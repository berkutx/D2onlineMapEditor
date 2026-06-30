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
import { validateProject, exportProject, generateRegion, copilotLlm, type ExportResult } from "../services/api";

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

  /** True if any op touches objects (everything except setCell, which is terrain). */
  const touchesObjects = (ops: readonly EditOp[]): boolean =>
    ops.some((o) => o.kind !== "setCell");

  const undoable = computed(() => (project.value ? canUndoFn(project.value) : false));
  const redoable = computed(() => (project.value ? canRedoFn(project.value) : false));
  const dirty = computed(() => (project.value?.journal.length ?? 0) > 0);

  /** Load (or create) the project for `mapId`, restoring any persisted edits. */
  function ensureProject(mapId: string): void {
    if (project.value?.baseScenarioId === mapId) return;
    try {
      const s = localStorage.getItem(keyFor(mapId));
      project.value = s ? deserializeProject(s) : emptyProject(mapId);
    } catch {
      project.value = emptyProject(mapId);
    }
    report.value = null;
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
    rev.value++;
    objectsRev.value++; // a full rebuild (load / undo / redo) may change the object set
  }

  function persist(): void {
    const p = project.value;
    if (!p) return;
    try {
      localStorage.setItem(keyFor(p.baseScenarioId), serializeProject(p));
    } catch {
      /* storage unavailable — ignore */
    }
  }

  /** Apply ops to the live doc for immediate feedback (no journal entry yet). */
  function applyPreview(ops: readonly EditOp[]): void {
    if (!liveDoc.value || ops.length === 0) return;
    let d = liveDoc.value;
    for (const op of ops) d = applyOp(d, op).doc;
    liveDoc.value = d;
    rev.value++;
    if (touchesObjects(ops)) objectsRev.value++;
  }

  /** Record a finished stroke as one commit (liveDoc already reflects it via preview). */
  function commitStroke(ops: readonly EditOp[]): void {
    if (!project.value || ops.length === 0) return;
    project.value = pushCommit(project.value, ops);
    report.value = null;
    persist();
  }

  /** Atomic apply + record (for non-drag single actions). */
  function commit(ops: readonly EditOp[]): void {
    applyPreview(ops);
    commitStroke(ops);
  }

  function undoEdit(): void {
    if (!project.value) return;
    project.value = undo(project.value);
    recompute();
    report.value = null;
    persist();
  }
  function redoEdit(): void {
    if (!project.value) return;
    project.value = redo(project.value);
    recompute();
    report.value = null;
    persist();
  }

  /** Discard all edits for the current map, keeping the same base. */
  function reset(): void {
    if (!project.value) return;
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
    undoEdit,
    redoEdit,
    reset,
    captions,
    setCaption,
    validate,
    generate,
    copilot,
    exportSg,
  };
});
