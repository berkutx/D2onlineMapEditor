/**
 * diffDocs — the minimal EditOp[] that turns document `a` into document `b`. Pure.
 *
 * This is the linchpin of conflict-aware revert (M5): the server rolls a user's edits back
 * by re-simulating the map WITHOUT those ops (`target`) and diffing it against the current
 * HEAD — `diffDocs(head, target)` is the forward "revert" commit. It is also what lets a
 * client adopt the server's materialised HEAD and reconcile it against its own journal.
 *
 * opKeys — the cell/object/entity KEYS an op touches, for last-writer / conflict tracking.
 */

import type { MapDocument, MapObject } from "@d2/map-schema";
import type { EditOp } from "@d2/socket-contract";
import type { ScenarioInfoPatch } from "@d2/socket-contract";

/** JSON-structural equality (drops `undefined`, matching how ops round-trip over the wire). */
const eq = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);

/** Top-level fields of `b` that differ from `a` (skipping `skip`); null when none differ. */
function diffFields(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  skip: readonly string[],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (skip.includes(k)) continue;
    if (!eq(a[k], b[k])) {
      out[k] = b[k];
      any = true;
    }
  }
  return any ? out : null;
}

/** True if `b` REMOVES a field that `a` had (present→absent). A patchObject cannot express
 *  this over the wire: `{field: undefined}` is dropped by JSON.stringify (log + socket), so
 *  applyOp receives `{}` and the field survives. Such a change must go through delete+add. */
function clearsAField(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const k of Object.keys(a)) {
    if (k === "id" || k === "type" || k === "pos") continue;
    if (a[k] !== undefined && b[k] === undefined) return true;
  }
  return false;
}

const SCENARIO_INFO_KEYS = [
  "name", "description", "author", "objective", "story", "winText", "loseText",
  "suggestedLevel", "difficulty", "limits",
] as const;

/**
 * The minimal ops to transform `a` into `b`, over every part of the document a room op can
 * touch: terrain cells, objects (add/delete/move/patch), events, templates, variables,
 * diplomacy, scenario info. `applyOps(a, diffDocs(a, b))` is structurally equal to `b`.
 */
export function diffDocs(a: MapDocument, b: MapDocument): EditOp[] {
  const ops: EditOp[] = [];

  // --- terrain: one setCell per changed cell (value / road) -----------------
  const ca = a.terrain?.cells ?? [];
  const cb = b.terrain?.cells ?? [];
  for (let i = 0; i < cb.length; i++) {
    const pb = cb[i];
    if (!pb) continue;
    const pa = ca[i];
    if (!pa || pa.value !== pb.value || pa.roadType !== pb.roadType || pa.roadVar !== pb.roadVar) {
      ops.push({ kind: "setCell", x: pb.x, y: pb.y, value: pb.value, roadType: pb.roadType, roadVar: pb.roadVar });
    }
  }

  // --- objects: add / delete / move / patch ---------------------------------
  const aObj = new Map<string, MapObject>(a.objects.map((o) => [o.id, o]));
  const bObj = new Map<string, MapObject>(b.objects.map((o) => [o.id, o]));
  for (const [id, ob] of bObj) {
    const oa = aObj.get(id);
    if (!oa) {
      ops.push({ kind: "addObject", object: ob });
      continue;
    }
    const ra = oa as unknown as Record<string, unknown>;
    const rb = ob as unknown as Record<string, unknown>;
    // A discriminant TYPE change (patchObject can't alter `type`) or a field REMOVAL (JSON
    // drops `{field: undefined}` on the wire/journal) can't be a clean patch — replace the
    // whole object with delete+add so the round-trip is EXACT after JSON serialization.
    if (oa.type !== ob.type || clearsAField(ra, rb)) {
      ops.push({ kind: "deleteObject", id });
      ops.push({ kind: "addObject", object: ob });
      continue;
    }
    if (oa.pos.x !== ob.pos.x || oa.pos.y !== ob.pos.y) {
      ops.push({ kind: "moveObject", id, x: ob.pos.x, y: ob.pos.y });
    }
    const fields = diffFields(ra, rb, ["id", "type", "pos"]);
    if (fields) ops.push({ kind: "patchObject", id, fields });
  }
  for (const id of aObj.keys()) if (!bObj.has(id)) ops.push({ kind: "deleteObject", id });

  // --- events (self-contained blocks: upsert / delete) ----------------------
  const aEv = new Map((a.events ?? []).map((e) => [e.id, e]));
  const bEv = new Map((b.events ?? []).map((e) => [e.id, e]));
  for (const [id, eb] of bEv) {
    const ea = aEv.get(id);
    if (!ea || !eq(ea, eb)) ops.push({ kind: "upsertEvent", event: eb });
  }
  for (const id of aEv.keys()) if (!bEv.has(id)) ops.push({ kind: "deleteEvent", id });

  // --- templates ------------------------------------------------------------
  const aT = new Map((a.templates ?? []).map((t) => [t.id, t]));
  const bT = new Map((b.templates ?? []).map((t) => [t.id, t]));
  for (const [id, tb] of bT) {
    const ta = aT.get(id);
    if (!ta || !eq(ta, tb)) ops.push({ kind: "upsertTemplate", template: tb });
  }
  for (const id of aT.keys()) if (!bT.has(id)) ops.push({ kind: "deleteTemplate", id });

  // --- whole-list blocks ----------------------------------------------------
  if (!eq(a.variables ?? [], b.variables ?? [])) {
    ops.push({ kind: "setVariables", variables: (b.variables ?? []).slice() });
  }
  if (!eq(a.diplomacy ?? [], b.diplomacy ?? [])) {
    ops.push({ kind: "setDiplomacy", diplomacy: (b.diplomacy ?? []).slice() });
  }

  // --- scenario info (patchable header fields) ------------------------------
  const ha = (a.header ?? {}) as unknown as Record<string, unknown>;
  const hb = (b.header ?? {}) as unknown as Record<string, unknown>;
  const infoFields: Record<string, unknown> = {};
  let infoAny = false;
  for (const k of SCENARIO_INFO_KEYS) {
    if (!eq(ha[k], hb[k])) {
      infoFields[k] = hb[k];
      infoAny = true;
    }
  }
  if (infoAny) ops.push({ kind: "setScenarioInfo", fields: infoFields as ScenarioInfoPatch });

  return ops;
}

/**
 * The KEYS an op touches — the unit of last-writer / conflict tracking. A cell is `"x,y"`;
 * an object / event / template is its id (namespaced by kind so an object and a same-named
 * template never collide); the whole-document blocks get a single sentinel key.
 */
export function opKeys(op: EditOp): string[] {
  switch (op.kind) {
    case "setCell":
      return [`${op.x},${op.y}`];
    case "addObject":
      return [`O:${op.object.id}`];
    case "moveObject":
    case "patchObject":
    case "deleteObject":
      return [`O:${op.id}`];
    case "patchPlayer":
      return [`P:${op.id}`]; // one player = one conflict key (edits to different players don't clash)
    case "upsertEvent":
      return [`E:${op.event.id}`];
    case "deleteEvent":
      return [`E:${op.id}`];
    case "upsertTemplate":
      return [`T:${op.template.id}`];
    case "deleteTemplate":
      return [`T:${op.id}`];
    case "setVariables":
      return ["VARS"];
    case "setScenarioInfo":
      return ["SCENARIO"];
    case "setDiplomacy":
      return ["DIPLOMACY"];
  }
}
