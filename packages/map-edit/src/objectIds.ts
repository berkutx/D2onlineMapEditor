/**
 * Server-side object-id assignment (M4). Two clients can independently mint the SAME next
 * object id (ids are `{version}{TYPE}{hex4}` with a per-type counter — e.g. S143RU0005 — or
 * mountains `…ML0000#index`); the loser's addObject then throws on apply and is silently
 * dropped. The server resolves this by REASSIGNING a colliding add to the next free id of the
 * same family before it enters the shared log, so every broadcast op has a unique id.
 *
 * Pure: takes the set of currently-live ids + the ops, returns the (possibly rewritten) ops
 * and the temp→assigned remap so the author can reconcile its optimistic state.
 */

import type { EditOp } from "./ops.js";

const hex4 = (n: number): string => (n >>> 0).toString(16).padStart(4, "0");

/** The next id of `id`'s family that is NOT in `ids`. Handles the `{prefix}{hex4}` form and the
 *  mountains `{prefix}#{index}` form; falls back to a `_n` suffix for anything else. */
export function nextFreeObjectId(ids: ReadonlySet<string>, id: string): string {
  const hexM = /^(.+?)([0-9a-fA-F]{4})$/.exec(id);
  if (hexM) {
    const prefix = hexM[1]!;
    let n = parseInt(hexM[2]!, 16);
    let cand: string;
    do {
      n++;
      cand = prefix + hex4(n);
    } while (ids.has(cand));
    return cand;
  }
  const hashM = /^(.+#)(\d+)$/.exec(id);
  if (hashM) {
    const prefix = hashM[1]!;
    let n = parseInt(hashM[2]!, 10);
    let cand: string;
    do {
      n++;
      cand = prefix + n;
    } while (ids.has(cand));
    return cand;
  }
  let n = 1;
  let cand: string;
  do {
    cand = `${id}_${n++}`;
  } while (ids.has(cand));
  return cand;
}

/**
 * Reassign colliding addObject ids in `ops` against `liveIds` (the ids currently in the room
 * doc). Later ops in the same batch that REFERENCE a reassigned id (move/patch/delete the
 * just-added object) are rewritten to match. Returns the new ops + the temp→assigned remap
 * (empty when nothing collided — the common case, so the author needs no reconcile).
 */
export function assignObjectIds(
  liveIds: ReadonlySet<string>,
  ops: readonly EditOp[],
): { ops: EditOp[]; remap: Record<string, string> } {
  const ids = new Set(liveIds);
  const remap: Record<string, string> = {};
  const out = ops.map((op): EditOp => {
    // a later op targeting an already-reassigned object follows the remap
    if ((op.kind === "moveObject" || op.kind === "patchObject" || op.kind === "deleteObject") && remap[op.id]) {
      op = { ...op, id: remap[op.id]! };
    }
    if (op.kind === "addObject") {
      const oldId = op.object.id;
      if (ids.has(oldId)) {
        const newId = nextFreeObjectId(ids, oldId);
        remap[oldId] = newId;
        op = { ...op, object: { ...op.object, id: newId } };
        ids.add(newId);
      } else {
        ids.add(oldId);
      }
    }
    return op;
  });
  return { ops: out, remap };
}
