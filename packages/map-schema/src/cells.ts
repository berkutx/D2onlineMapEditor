import { z } from "zod";

/** A single decoded terrain cell. Positions are CARTESIAN (col x, row y); the iso
 *  transform lives only in @d2/pixi-render. `value` is the raw int32 kept for round-trip. */
export const MapCell = z.object({
  x: z.number().int(),
  y: z.number().int(),
  value: z.number().int(), // raw packed int32 from the .sg MapBlock cell
  terrain: z.number().int(), // value & 7  (race-themed tile set selector)
  ground: z.number().int(), // (value >> 3) & 7
  isWater: z.boolean(), // ground === 3 (denormalized for renderer speed)
  forest: z.number().int(), // value >>> 26 (0 = none)
  roadType: z.number().int(), // -1 = none; else MidRoad.roadIndex applied onto this cell
  roadVar: z.number().int(), // -1 = none; else MidRoad.var
});
export type MapCell = z.infer<typeof MapCell>;

/** The terrain grid: row-major `cells`, length === size*size, index = y*size + x. */
export const TerrainGrid = z.object({
  size: z.number().int().positive(),
  cells: z.array(MapCell),
});
export type TerrainGrid = z.infer<typeof TerrainGrid>;
