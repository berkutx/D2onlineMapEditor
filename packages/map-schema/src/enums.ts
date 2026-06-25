import { z } from "zod";

/**
 * Ground type = bits 3..5 of `MapCell.value`. `Water === 3` (verified in toolsqt MapGrid.h).
 * The exact race<->index mapping for non-water grounds is resolved by the asset manifest's
 * terrain naming, not asserted here; values are passed through as numbers.
 */
export const Ground = {
  Neutral: 0,
  Empire: 1,
  Clans: 2,
  Water: 3,
  Legions: 4,
  Undead: 5,
  Elves: 6,
} as const;
export type GroundId = number;

/** Discriminator for the MapObject union. Unknown binary blocks degrade to "generic". */
export const ObjectType = z.enum([
  "stack",
  "fort",
  "capital",
  "village",
  "ruin",
  "merchant",
  "mage",
  "trainer",
  "mercenary",
  "mountains",
  "crystal",
  "landmark",
  "location",
  "bag",
  "tomb",
  "rod",
  "unit",
  "stackTemplate",
  "event",
  "diplomacy",
  "questLine",
  "scenVariable",
  "generic",
]);
export type ObjectType = z.infer<typeof ObjectType>;
