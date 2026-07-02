import { z } from "zod";
import { MapObject, MapEvent } from "@d2/map-schema";

/** Map edit operations. Declared now; the server applies them only from Stage 4
 *  (read-only before that). Coarse, server-validated, last-writer-wins per cell/object.
 *  v0.3: additive event ops (upsertEvent/deleteEvent) — a scenario event is a self-contained
 *  MidEvent block, so it round-trips via append/replace/delete of a whole frame. */
export const EditOp = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("setCell"),
    x: z.number().int(),
    y: z.number().int(),
    value: z.number().int(),
    roadType: z.number().int().optional(),
    roadVar: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("addObject"), object: MapObject }),
  z.object({
    kind: z.literal("moveObject"),
    id: z.string(),
    x: z.number().int(),
    y: z.number().int(),
  }),
  z.object({ kind: z.literal("patchObject"), id: z.string(), fields: z.record(z.unknown()) }),
  z.object({ kind: z.literal("deleteObject"), id: z.string() }),
  z.object({ kind: z.literal("upsertEvent"), event: MapEvent }),
  z.object({ kind: z.literal("deleteEvent"), id: z.string() }),
]);
export type EditOp = z.infer<typeof EditOp>;

export const OpAck = z.object({
  ok: z.boolean(),
  seq: z.number().int().optional(),
  reason: z.string().optional(),
});
export type OpAck = z.infer<typeof OpAck>;
