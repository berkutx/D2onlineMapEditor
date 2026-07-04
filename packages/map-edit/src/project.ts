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
  /** How many commits are currently applied (undo decrements, redo increments). */
  cursor: z.number().int().nonnegative().default(0),
  /** Editor-only, optional per-location display captions (object id → text). NOT written to the
   *  .sg (the game has no such field); shown as a label on the world map. */
  captions: z.record(z.string(), z.string()).default({}),
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
    cursor: 0,
    captions: {},
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

/** Record a commit (one logical action's ops): drop any redo tail, append, advance. */
export function pushCommit(p: EditorProject, ops: readonly EditOp[]): EditorProject {
  if (ops.length === 0) return p;
  const journal = p.journal.slice(0, p.cursor).concat([ops.slice()]);
  return { ...p, journal, cursor: journal.length };
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

export function serializeProject(p: EditorProject): string {
  return JSON.stringify(EditorProject.parse(p));
}
export function deserializeProject(s: string): EditorProject {
  return EditorProject.parse(JSON.parse(s));
}
