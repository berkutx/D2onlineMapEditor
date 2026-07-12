import { z } from "zod";
import { MapObject, MapEvent, ScenarioVariable, StackTemplate, DiplomacyEntry } from "@d2/map-schema";

/** Editable scenario-settings fields (a PARTIAL patch of MapHeader; only present keys apply). */
export const ScenarioInfoPatch = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  objective: z.string().optional(),
  story: z.string().optional(),
  winText: z.string().optional(),
  loseText: z.string().optional(),
  suggestedLevel: z.number().int().optional(),
  difficulty: z.object({ scenario: z.number().int(), game: z.number().int() }).optional(),
  limits: z
    .object({
      unit: z.number().int(),
      spell: z.number().int(),
      leader: z.number().int(),
      city: z.number().int(),
    })
    .optional(),
});
export type ScenarioInfoPatch = z.infer<typeof ScenarioInfoPatch>;

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
  // edit an existing MidPlayer's fields (isHuman / bank resources / lordId / attitude / …); the
  // player roster itself (add/remove) is a later op. `id` = the player uid; `fields` = partial PlayerInfo.
  z.object({ kind: z.literal("patchPlayer"), id: z.string(), fields: z.record(z.unknown()) }),
  z.object({ kind: z.literal("upsertEvent"), event: MapEvent }),
  z.object({ kind: z.literal("deleteEvent"), id: z.string() }),
  // scenario variables live in ONE MidScenVariables block, so the whole list is set at once.
  z.object({ kind: z.literal("setVariables"), variables: z.array(ScenarioVariable) }),
  z.object({ kind: z.literal("upsertTemplate"), template: StackTemplate }),
  z.object({ kind: z.literal("deleteTemplate"), id: z.string() }),
  z.object({ kind: z.literal("setScenarioInfo"), fields: ScenarioInfoPatch }),
  // diplomacy lives in ONE MidDiplomacy block, so the whole list is set at once.
  z.object({ kind: z.literal("setDiplomacy"), diplomacy: z.array(DiplomacyEntry) }),
]);
export type EditOp = z.infer<typeof EditOp>;

export const OpAck = z.object({
  ok: z.boolean(),
  seq: z.number().int().optional(),
  reason: z.string().optional(),
});
export type OpAck = z.infer<typeof OpAck>;
