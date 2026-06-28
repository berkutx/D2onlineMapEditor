/**
 * Editor-only RELATIONS — links the raw `.sg` has no native concept of, layered on
 * top of the parsed map. They drive cascading edits (move a building → recompute
 * its road → move the guard/chest it served) and double as hints for an agent
 * regenerating a region. Inference + cascade execution land in M5; the type and a
 * stub inferrer exist now so the project format carries relations from day one.
 */

import { z } from "zod";
import type { MapDocument } from "@d2/map-schema";

export const RelationKind = z.enum([
  "fortGarrison", // fort -> the stack stationed inside it
  "fortVisiter", // fort -> the stack standing on it (moves with the fort)
  "roadToObject", // a road path -> the object it leads to
  "guardToTarget", // a guarding stack -> what it protects (chest/site)
  "objToTerrain", // an object -> terrain it is visually bound to
]);
export type RelationKind = z.infer<typeof RelationKind>;

export const Relation = z.object({
  id: z.string(),
  kind: RelationKind,
  from: z.string(), // object id (or cell key for terrain-bound)
  to: z.string(),
  params: z.record(z.unknown()).default({}),
});
export type Relation = z.infer<typeof Relation>;

/**
 * Seed relations from a freshly parsed map. STUB for M1: returns []. M5 will infer
 * garrison/visiter from fort fields, guards via the guard-range data, and roads
 * leading into forts. Kept as a pure function so the call site is stable now.
 */
export function inferRelations(_doc: MapDocument): Relation[] {
  return [];
}
