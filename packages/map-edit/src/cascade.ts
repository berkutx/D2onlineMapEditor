/**
 * Cascade engine — given a move and the editor relations, produce the follow-on
 * EditOps (move the visiter stack, recompute the road, drag the guarded chest…).
 *
 * STUB for M1: returns []. The real engine lands in M5 once relation inference
 * exists. Isolated here so move handling can call it unconditionally today.
 */

import type { MapDocument } from "@d2/map-schema";
import type { Relation } from "./relations.js";
import type { EditOp } from "./ops.js";

export function cascadeMove(
  _doc: MapDocument,
  _relations: readonly Relation[],
  _move: Extract<EditOp, { kind: "moveObject" }>,
): EditOp[] {
  return [];
}
