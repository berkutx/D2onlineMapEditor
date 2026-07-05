/**
 * EditorProject — our own intermediate save format: a base scenario + an ordered
 * journal of EditOps + a cursor (for undo/"step back"/redo) + editor-only
 * relations. JSON, agent-readable. This, not the `.sg`, is the thing the editor
 * loads/saves while working; the `.sg` is materialised on export from base+ops.
 *
 * Helpers are pure (return a new project) so a Pinia/store can treat it as state.
 */

import { z } from "zod";
import { EditOp } from "@d2/socket-contract";
import { Relation } from "./relations.js";

export const PROJECT_VERSION = 2 as const;

export const EditorProject = z.object({
  version: z.literal(PROJECT_VERSION),
  /** Opaque server id of the base map this project was derived from. */
  baseScenarioId: z.string(),
  /** Base map ETag at fork time (to detect the source changing under us). */
  baseEtag: z.string().optional(),
  relations: z.array(Relation).default([]),
  /**
   * Ordered list of COMMITS; each commit is the ops of one logical action (a brush
   * stroke, a move, …) so undo/redo step a whole action, not a single cell. Redo
   * lives past the cursor.
   */
  journal: z.array(z.array(EditOp)).default([]),
  /**
   * Per-op stable uids, parallel to `journal` (opUids[i][j] names journal[i][j]).
   * The collab layer sends an op's uid as its `clientOpId`, so any later room-log
   * replay (fresh join, second tab, reconnect) can SKIP ops this journal already
   * holds — the fix for the double-apply crash («addObject: id already exists»).
   * Random uuids, deliberately NOT derived from the private clientId (uids are
   * visible to peers). Older projects lack entries — see ensureOpUids.
   */
  opUids: z.array(z.array(z.string())).default([]),
  /** How many commits are currently applied (undo decrements, redo increments). */
  cursor: z.number().int().nonnegative().default(0),
  /**
   * Monotonic revision of the editor-only METADATA below (zones/captions/anchors/
   * roadAnchors/autoVars), bumped on every local metadata mutation. Two tabs of one
   * browser share the localStorage project key: the op journal converges via the collab
   * room-log, but metadata is not op-carried — tabs reconcile it by metaRev (adopt a
   * NEWER foreign write, re-persist over an OLDER one; see editStore's storage handler).
   */
  metaRev: z.number().int().nonnegative().default(0),
  /** Editor-only, optional per-location display captions (object id → text). NOT written to the
   *  .sg (the game has no such field); shown as a label on the world map. */
  captions: z.record(z.string(), z.string()).default({}),
  /** Editor-only per-event notes (event id → free-form description). The event's game NAME
   *  (e.g. "1ZoneKreigSay2") goes to the .sg; this longer note stays in the project only. */
  eventDescs: z.record(z.string(), z.string()).default({}),
  /**
   * Editor-only ANCHORS (child object id → parent object id): moving the parent moves every
   * transitively anchored child by the same delta (one undoable stroke). NOT in the .sg —
   * the game has no such concept; this is the editor's own "надслойка" for keeping a guard
   * with its chest, a visitor with its building, etc. Cycles are rejected at set time.
   */
  anchors: z.record(z.string(), z.string()).default({}),
  /**
   * Editor-GENERATED variable ids (builders like «после N раз» allocate a counter variable
   * and mark it here). The VARIABLES themselves live in the document/.sg as usual — this is
   * only editor metadata that folds them into a collapsed «Автоматические» group in the UI.
   * An id that no longer exists in the document is simply ignored (orphaned marks are harmless).
   */
  autoVars: z.array(z.number().int()).default([]),
  /**
   * «Дорога следует за входом»: fort object ids whose attached road re-routes when the fort
   * moves (erase old-entrance..first-bend, extend bend → new entrance; entrance = pos +
   * (size,size), byte-derived). The road "child" is IMPLICIT — located at move time from the
   * CURRENT entrance, so it survives road edits with no stale cell lists. Editor-only.
   */
  roadAnchors: z.record(z.string(), z.object({ mode: z.literal("reroute") })).default({}),
  /**
   * Free-form ZONES (editor-only): a hand-drawn cell mask compiled into game MidLocation
   * squares (5×5/3×3/1×1, overlap-legal, tiles ⊆ mask). `locIds` tracks the materialized
   * locations of the current generation — regen deletes them and re-tiles. ZN ids never
   * reach the .sg (only the generated LO locations do).
   */
  zones: z.record(z.string(), z.object({
    name: z.string(),
    cells: z.array(z.string()), // "x,y" mask keys
    locIds: z.array(z.string()).default([]),
    /** Zone-event CLONE groups: each entry = [baseEventId, ...cloneEventIds]. The game
     *  allows ONE zone condition per event (conditions are AND-only), so a zone trigger is
     *  a set of per-location clones; the events panel collapses them behind the base row.
     *  Entries are validated against live events at render (stale ids are harmless). */
    eventGroups: z.array(z.array(z.string())).default([]),
  })).default({}),
  meta: z
    .object({
      name: z.string().optional(),
      note: z.string().optional(),
      /** Set when the base is a blank template (New Map). */
      createdFromTemplate: z.boolean().optional(),
    })
    .default({}),
});
export type EditorProject = z.infer<typeof EditorProject>;

export function emptyProject(
  baseScenarioId: string,
  meta: EditorProject["meta"] = {},
): EditorProject {
  return {
    version: PROJECT_VERSION,
    baseScenarioId,
    relations: [],
    journal: [],
    opUids: [],
    cursor: 0,
    metaRev: 0,
    captions: {},
    eventDescs: {},
    anchors: {},
    autoVars: [],
    roadAnchors: {},
    zones: {},
    meta,
  };
}

/** The commits currently in effect (journal up to the cursor). */
export function activeCommits(p: EditorProject): EditOp[][] {
  return p.journal.slice(0, p.cursor);
}

/** The flat ops currently in effect (for byte export / applying to a doc). */
export function activeOps(p: EditorProject): EditOp[] {
  return activeCommits(p).flat();
}

/** Record a commit (one logical action's ops): drop any redo tail, append, advance.
 *  `uids` (parallel to `ops`) are the stable per-op ids the collab layer dedups by;
 *  omitted (server-side augment paths) → the commit simply has no uids. */
export function pushCommit(
  p: EditorProject,
  ops: readonly EditOp[],
  uids?: readonly string[],
): EditorProject {
  if (ops.length === 0) return p;
  const journal = p.journal.slice(0, p.cursor).concat([ops.slice()]);
  const opUids = (p.opUids ?? []).slice(0, p.cursor).concat([uids ? uids.slice() : []]);
  return { ...p, journal, opUids, cursor: journal.length };
}

/** Record a single op as its own commit (convenience). */
export function pushOp(p: EditorProject, op: EditOp): EditorProject {
  return pushCommit(p, [op]);
}

export const canUndo = (p: EditorProject): boolean => p.cursor > 0;
export const canRedo = (p: EditorProject): boolean => p.cursor < p.journal.length;

export function undo(p: EditorProject): EditorProject {
  return canUndo(p) ? { ...p, cursor: p.cursor - 1 } : p;
}
export function redo(p: EditorProject): EditorProject {
  return canRedo(p) ? { ...p, cursor: p.cursor + 1 } : p;
}

/** Every op uid the journal knows about (INCLUDING the redo tail past the cursor —
 *  an undone-but-sent op must still be recognized in a room-log replay). */
export function allOpUids(p: EditorProject): Set<string> {
  const s = new Set<string>();
  for (const commit of p.opUids ?? []) for (const uid of commit) if (uid) s.add(uid);
  return s;
}

/** Uids of the ACTIVE ops, flat + parallel to activeOps(p); "" where a commit predates
 *  uid tracking (run ensureOpUids first to avoid that). */
export function activeOpUids(p: EditorProject): string[] {
  const out: string[] = [];
  for (let i = 0; i < p.cursor; i++) {
    const ops = p.journal[i] ?? [];
    const uids = (p.opUids ?? [])[i] ?? [];
    for (let j = 0; j < ops.length; j++) out.push(uids[j] ?? "");
  }
  return out;
}

/** Backfill missing per-op uids (projects saved before uid tracking) using `gen`.
 *  Returns the same object when nothing was missing. */
export function ensureOpUids(p: EditorProject, gen: () => string): EditorProject {
  const src = p.opUids ?? [];
  let changed = src.length !== p.journal.length;
  const opUids = p.journal.map((ops, i) => {
    const uids = src[i] ?? [];
    if (uids.length === ops.length && uids.every((u) => u)) return uids;
    changed = true;
    return ops.map((_, j) => uids[j] || gen());
  });
  return changed ? { ...p, opUids } : p;
}

export function serializeProject(p: EditorProject): string {
  return JSON.stringify(EditorProject.parse(p));
}
export function deserializeProject(s: string): EditorProject {
  return EditorProject.parse(JSON.parse(s));
}
