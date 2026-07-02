/**
 * Edit state: the EditorProject (our diff/undo format) for the currently-open map,
 * PLUS the live document (base map + applied edits) the renderer draws.
 *
 * - project: base scenario id + ordered commits (each a stroke's ops) + cursor.
 * - baseDoc: the map as loaded (immutable); liveDoc = base with active commits applied.
 * - rev: bumps whenever liveDoc changes, so the canvas re-tiles terrain on demand.
 *
 * Validate/export round-trip through the server's writer + validator (integrity gate).
 */
import { defineStore } from "pinia";
import { ref, shallowRef, computed } from "vue";
import {
  emptyProject,
  serializeProject,
  deserializeProject,
  pushCommit,
  undo,
  redo,
  applyOp,
  applyOps,
  activeOps,
  canUndo as canUndoFn,
  canRedo as canRedoFn,
  type EditorProject,
  type EditOp,
} from "@d2/map-edit";
import type { MapDocument } from "@d2/map-schema";
import type { ValidationReport, Region, GenDebug } from "@d2/socket-contract";
import {
  validateProject,
  exportProject,
  generateRegion,
  copilotLlm,
  fetchProjectRemote,
  saveProjectRemote,
  type ExportResult,
} from "../services/api";

const keyFor = (mapId: string): string => `d2.project.${mapId}`;

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const useEditStore = defineStore("edit", () => {
  const project = ref<EditorProject | null>(null);
  const report = ref<ValidationReport | null>(null);
  const busy = ref(false);
  /** Debug/timing for the last Copilot generation (shown in the chat). */
  const genDebug = ref<GenDebug | null>(null);

  /** The map as loaded (base) and the live doc = base + active commits. */
  const baseDoc = shallowRef<MapDocument | null>(null);
  const liveDoc = shallowRef<MapDocument | null>(null);
  /** Bumped whenever liveDoc changes (canvas watches this to re-tile terrain). */
  const rev = ref(0);
  /** Bumped only when an edit changes OBJECTS (place/move/delete/patch), so the
   *  canvas rebuilds the object layer without re-running it on every terrain stroke. */
  const objectsRev = ref(0);

  // --- collaboration (Stage 4) ------------------------------------------------
  // When joined to a room, every local commit is ALSO broadcast (set by collabStore via
  // setCollab). Peers' ops fold into the journal through applyIncoming (so export stays
  // correct) WITHOUT entering my undo stack. Undo/redo switch to the append-inverse model:
  // undo sends the inverse of MY last op as a new forward edit (the decided collab model).
  const roomConnected = ref(false);
  let outgoing: ((ops: readonly EditOp[]) => void) | null = null;
  /** Forward + INVERSE for each of MY commits (newest last). Only mine are undoable; the
   *  inverse is captured at apply time (applyOp's exact inverse) so collab undo is correct
   *  even after peers' ops land in between. */
  type UndoEntry = { forward: EditOp[]; inverse: EditOp[] };
  const myUndo = ref<UndoEntry[]>([]);
  const myRedo = ref<UndoEntry[]>([]);
  /** Inverse ops accumulated for the in-progress (un-committed) preview, in undo order. */
  let pendingInverses: EditOp[] = [];

  /** Called by collabStore on join/leave to enable/disable the broadcast + inverse-undo path. */
  function setCollab(connected: boolean, onOutgoing: ((ops: readonly EditOp[]) => void) | null): void {
    roomConnected.value = connected;
    outgoing = connected ? onOutgoing : null;
    myUndo.value = [];
    myRedo.value = [];
    pendingInverses = [];
  }

  /** True if any op touches objects (everything except setCell, which is terrain). */
  const touchesObjects = (ops: readonly EditOp[]): boolean =>
    ops.some((o) => o.kind !== "setCell");

  const undoable = computed(() =>
    roomConnected.value ? myUndo.value.length > 0 : project.value ? canUndoFn(project.value) : false,
  );
  const redoable = computed(() =>
    roomConnected.value ? myRedo.value.length > 0 : project.value ? canRedoFn(project.value) : false,
  );
  const dirty = computed(() => (project.value?.journal.length ?? 0) > 0);

  /** Load (or create) the project for `mapId`, restoring any persisted edits. localStorage
   *  first (this device's live state); if it yields an EMPTY project, the server-saved copy
   *  (per clientId) is adopted asynchronously — so a new/cleared browser restores its edits. */
  function ensureProject(mapId: string): void {
    if (project.value?.baseScenarioId === mapId) return;
    clearTimeout(autoValidateTimer); // don't let a stale timer validate across a map switch
    try {
      const s = localStorage.getItem(keyFor(mapId));
      project.value = s ? deserializeProject(s) : emptyProject(mapId);
    } catch {
      project.value = emptyProject(mapId);
    }
    report.value = null;
    const p = project.value;
    if (p && p.journal.length === 0 && Object.keys(p.captions ?? {}).length === 0) {
      void fetchProjectRemote(mapId)
        .then((remote) => {
          // adopt only if still on this map and nothing was edited in the meantime
          if (
            remote &&
            project.value?.baseScenarioId === mapId &&
            project.value.journal.length === 0
          ) {
            project.value = remote;
            recompute();
            persist();
          }
        })
        .catch(() => {/* offline / no server copy — localStorage state stands */});
    }
  }

  /** Set the base document (on map load) and recompute the live doc. */
  function setBaseDoc(doc: MapDocument): void {
    baseDoc.value = doc;
    recompute();
  }

  /** liveDoc = base + all active commits (full rebuild; used after undo/redo/load). */
  function recompute(): void {
    const base = baseDoc.value;
    liveDoc.value = base && project.value ? applyOps(base, activeOps(project.value)) : base;
    pendingInverses = []; // a full rebuild abandons any in-progress preview accumulation
    rev.value++;
    objectsRev.value++; // a full rebuild (load / undo / redo) may change the object set
  }

  /** Debounced server mirror of the project (durability beyond this browser). */
  let remoteSaveTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleRemoteSave(): void {
    const p = project.value;
    if (!p) return;
    clearTimeout(remoteSaveTimer);
    remoteSaveTimer = setTimeout(() => {
      const cur = project.value;
      if (!cur) return;
      void saveProjectRemote(cur.baseScenarioId, cur).catch(() => {
        /* offline — localStorage still has it; next persist retries */
      });
    }, 1500);
  }

  function persist(): void {
    const p = project.value;
    if (!p) return;
    try {
      localStorage.setItem(keyFor(p.baseScenarioId), serializeProject(p));
    } catch {
      /* storage unavailable — ignore */
    }
    scheduleRemoteSave();
  }

  /** Low-level: apply ops to the live doc, bumping rev/objectsRev. Returns the exact inverse
   *  ops (in undo order) so callers can capture them for undo without re-deriving. */
  function applyToLive(ops: readonly EditOp[]): EditOp[] {
    if (!liveDoc.value || ops.length === 0) return [];
    let d = liveDoc.value;
    const inv: EditOp[] = [];
    for (const op of ops) {
      const r = applyOp(d, op);
      d = r.doc;
      inv.unshift(r.inverse); // prepend → final array undoes in reverse application order
    }
    liveDoc.value = d;
    rev.value++;
    if (touchesObjects(ops)) objectsRev.value++;
    report.value = null; // any edit invalidates the last validation verdict (top-bar chip)
    return inv;
  }

  /** Apply ops to the live doc for immediate feedback (no journal entry yet). Accumulates the
   *  stroke's inverse so the eventual commitStroke can record it for collab undo. */
  function applyPreview(ops: readonly EditOp[]): void {
    const inv = applyToLive(ops);
    if (inv.length) pendingInverses = [...inv, ...pendingInverses];
  }

  /** Record a finished stroke as one commit (liveDoc already reflects it via preview). When
   *  joined to a room, also broadcast the ops and push {forward,inverse} onto my undo stack. */
  function commitStroke(ops: readonly EditOp[]): void {
    if (!project.value || ops.length === 0) return;
    const inverse = pendingInverses;
    pendingInverses = [];
    project.value = pushCommit(project.value, ops);
    report.value = null;
    persist();
    scheduleAutoValidate();
    if (roomConnected.value && outgoing) {
      outgoing(ops);
      myUndo.value = [...myUndo.value, { forward: ops.slice(), inverse }];
      myRedo.value = [];
    }
  }

  /**
   * Fold a PEER's ops into the live doc + journal (so export includes them) without
   * broadcasting or touching my undo stack. Called by collabStore on `edit:applied`.
   */
  function applyIncoming(ops: readonly EditOp[]): void {
    if (!project.value || ops.length === 0) return;
    applyToLive(ops); // incremental liveDoc update (+ rev/objectsRev); not part of my stroke
    project.value = pushCommit(project.value, ops); // record for export / recompute
    report.value = null;
    persist();
    scheduleAutoValidate();
  }

  /** Atomic apply + record (for non-drag single actions). */
  function commit(ops: readonly EditOp[]): void {
    applyPreview(ops);
    commitStroke(ops);
  }

  function undoEdit(): void {
    if (!project.value) return;
    // Collab: apply the captured inverse of MY last op as a NEW forward edit (append-inverse,
    // no history rewind) and broadcast it. Local-only: the classic cursor step-back.
    if (roomConnected.value) {
      const entry = myUndo.value[myUndo.value.length - 1];
      if (!entry) return;
      applyToLive(entry.inverse);
      project.value = pushCommit(project.value, entry.inverse);
      persist();
      outgoing?.(entry.inverse);
      myUndo.value = myUndo.value.slice(0, -1);
      myRedo.value = [...myRedo.value, entry];
      report.value = null;
      scheduleAutoValidate();
      return;
    }
    project.value = undo(project.value);
    recompute();
    report.value = null;
    persist();
    scheduleAutoValidate();
  }
  function redoEdit(): void {
    if (!project.value) return;
    // Collab: re-apply the original forward op (mirror of undoEdit) and broadcast it.
    if (roomConnected.value) {
      const entry = myRedo.value[myRedo.value.length - 1];
      if (!entry) return;
      applyToLive(entry.forward);
      project.value = pushCommit(project.value, entry.forward);
      persist();
      outgoing?.(entry.forward);
      myRedo.value = myRedo.value.slice(0, -1);
      myUndo.value = [...myUndo.value, entry];
      report.value = null;
      scheduleAutoValidate();
      return;
    }
    project.value = redo(project.value);
    recompute();
    report.value = null;
    persist();
    scheduleAutoValidate();
  }

  /** Discard all edits for the current map, keeping the same base. */
  function reset(): void {
    if (!project.value) return;
    clearTimeout(autoValidateTimer); // a pending auto-check would race the fresh project
    project.value = emptyProject(project.value.baseScenarioId, project.value.meta);
    recompute();
    report.value = null;
    persist();
  }

  /** Editor-only per-object display captions (object id → text); persisted, NOT in the .sg. */
  const captions = computed<Record<string, string>>(() => project.value?.captions ?? {});
  function setCaption(id: string, text: string): void {
    if (!project.value) return;
    const next = { ...(project.value.captions ?? {}) };
    const t = text.trim();
    if (t) next[id] = t;
    else delete next[id];
    project.value = { ...project.value, captions: next };
    persist(); // editor-only metadata: persist without touching the op journal
  }

  /** Editor-only ANCHORS (child id → parent id): moving the parent drags every transitively
   *  anchored child along. Persisted with the project, never written to the .sg. */
  const anchors = computed<Record<string, string>>(() => project.value?.anchors ?? {});
  /** Anchor `childId` to `parentId`. Rejects self/cycles (walks the parent chain). */
  function setAnchor(childId: string, parentId: string): boolean {
    if (!project.value || childId === parentId) return false;
    // cycle guard: parentId must not be (transitively) anchored to childId
    let p: string | undefined = parentId;
    const cur = project.value.anchors ?? {};
    while (p) {
      if (p === childId) return false;
      p = cur[p];
    }
    project.value = { ...project.value, anchors: { ...cur, [childId]: parentId } };
    persist();
    return true;
  }
  function clearAnchor(childId: string): void {
    if (!project.value) return;
    const next = { ...(project.value.anchors ?? {}) };
    delete next[childId];
    project.value = { ...project.value, anchors: next };
    persist();
  }
  /** Editor-GENERATED variable ids (counter gates etc.); persisted with the project, NOT in
   *  the .sg beyond the variables themselves. Drives the collapsed «Автоматические» group. */
  const autoVars = computed<number[]>(() => project.value?.autoVars ?? []);
  function markAutoVar(id: number): void {
    if (!project.value) return;
    const cur = project.value.autoVars ?? [];
    if (cur.includes(id)) return;
    project.value = { ...project.value, autoVars: [...cur, id] };
    persist(); // editor-only metadata: persist without touching the op journal
  }
  function unmarkAutoVar(id: number): void {
    if (!project.value) return;
    const cur = project.value.autoVars ?? [];
    if (!cur.includes(id)) return;
    project.value = { ...project.value, autoVars: cur.filter((x) => x !== id) };
    persist();
  }

  /** The move-group for `id`: itself + every TRANSITIVE anchored child (parents stay put). */
  function anchorGroup(id: string): string[] {
    const a = anchors.value;
    const kids = new Map<string, string[]>();
    for (const [c, p] of Object.entries(a)) {
      const arr = kids.get(p) ?? [];
      arr.push(c);
      kids.set(p, arr);
    }
    const out: string[] = [];
    const stack = [id];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      for (const k of kids.get(cur) ?? []) stack.push(k);
    }
    return out;
  }

  async function validate(): Promise<ValidationReport | null> {
    if (!project.value) return null;
    busy.value = true;
    try {
      report.value = await validateProject(project.value.baseScenarioId, project.value);
      return report.value;
    } finally {
      busy.value = false;
    }
  }

  /**
   * AUTO-validation: re-check the map when the user STOPS editing (debounced idle, not a
   * server-side timer sweep — one cheap request per edit burst, per client). The result
   * lands in `report`, which drives the top-bar check button's green/red state. Silent:
   * errors here never pop dialogs (the manual button shows the detailed report).
   */
  let autoValidateTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleAutoValidate(): void {
    clearTimeout(autoValidateTimer);
    const p = project.value;
    if (!p || p.journal.length === 0) return; // nothing to check on a pristine map
    autoValidateTimer = setTimeout(() => {
      if (busy.value) {
        scheduleAutoValidate(); // a manual validate/export/generate is running — retry later
        return;
      }
      void validate().catch(() => {
        /* offline / transient — the button just stays neutral until the next edit */
      });
    }, 2500);
  }

  /**
   * Copilot generation: run `recipeId` over `region` server-side (MarkovJunior + decode +
   * validate), then commit the returned ops as ONE undoable edit if they validate.
   */
  async function generate(
    recipeId: string,
    region: Region,
    seed?: number,
    cells?: [number, number][] | null,
    protect?: boolean,
  ): Promise<ValidationReport | null> {
    if (!project.value) return null;
    busy.value = true;
    try {
      const res = await generateRegion(project.value.baseScenarioId, project.value, recipeId, region, seed, cells, protect);
      report.value = res.report;
      genDebug.value = res.debug ?? null;
      if (res.report.ok && res.ops.length) commit(res.ops);
      return res.report;
    } finally {
      busy.value = false;
    }
  }

  /**
   * Copilot LLM (Phase-4 POC): send a natural-language command to the server's LLM bridge,
   * which returns a generation plan's EditOps + validation report. Commits the ops as ONE
   * undoable edit if they validate. Returns the report + the LLM's prose (for the chat).
   */
  async function copilot(
    text: string,
    selection?: Region | null,
    cells?: [number, number][] | null,
    protect?: boolean,
  ): Promise<{ report: ValidationReport; reasoning?: string; debug?: GenDebug } | null> {
    if (!project.value) return null;
    busy.value = true;
    try {
      const res = await copilotLlm(project.value.baseScenarioId, project.value, text, selection ?? null, cells, protect);
      report.value = res.report;
      genDebug.value = res.debug ?? null;
      if (res.report.ok && res.ops.length) commit(res.ops);
      return { report: res.report, reasoning: res.reasoning, debug: res.debug };
    } finally {
      busy.value = false;
    }
  }

  async function exportSg(): Promise<ExportResult | null> {
    if (!project.value) return null;
    busy.value = true;
    try {
      const r = await exportProject(project.value.baseScenarioId, project.value);
      if (r.ok) downloadBlob(r.blob, r.filename);
      else report.value = r.report;
      return r;
    } finally {
      busy.value = false;
    }
  }

  return {
    project,
    report,
    busy,
    genDebug,
    baseDoc,
    liveDoc,
    rev,
    objectsRev,
    undoable,
    redoable,
    dirty,
    ensureProject,
    setBaseDoc,
    applyPreview,
    commitStroke,
    commit,
    applyIncoming,
    setCollab,
    roomConnected,
    undoEdit,
    redoEdit,
    reset,
    captions,
    setCaption,
    anchors,
    setAnchor,
    clearAnchor,
    anchorGroup,
    autoVars,
    markAutoVar,
    unmarkAutoVar,
    validate,
    generate,
    copilot,
    exportSg,
  };
});
