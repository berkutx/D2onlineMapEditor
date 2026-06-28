/**
 * Terrain cell bit pack/unpack — mirrors the verified `.sg` cell layout
 * (see @d2/map-schema cells.ts and sg-parser grid.ts):
 *   terrain = v & 7 ; ground = (v >> 3) & 7 (water == 3) ; forest = v >>> 26
 *
 * Brushes MUST mutate cells through these setters so the untouched bits (6..25,
 * which hold other packed cell data) are preserved — never rebuild a value from
 * scratch, that would clobber data the editor doesn't model.
 */

import type { MapCell } from "@d2/map-schema";

export const TERRAIN_BITS = 0x7;
export const GROUND_SHIFT = 3;
export const GROUND_BITS = 0x7;
export const FOREST_SHIFT = 26;
export const FOREST_BITS = 0x3f; // bits 26..31

export const GROUND_WATER = 3;

export const getTerrain = (v: number): number => v & TERRAIN_BITS;
export const getGround = (v: number): number => (v >> GROUND_SHIFT) & GROUND_BITS;
export const getForest = (v: number): number => (v >>> FOREST_SHIFT) & FOREST_BITS;
export const isWater = (v: number): boolean => getGround(v) === GROUND_WATER;

export const setTerrain = (v: number, t: number): number =>
  ((v & ~TERRAIN_BITS) | (t & TERRAIN_BITS)) | 0;

export const setGround = (v: number, g: number): number =>
  ((v & ~(GROUND_BITS << GROUND_SHIFT)) | ((g & GROUND_BITS) << GROUND_SHIFT)) | 0;

export const setForest = (v: number, f: number): number =>
  ((v & ~(FOREST_BITS << FOREST_SHIFT)) | ((f & FOREST_BITS) << FOREST_SHIFT)) | 0;

/** Convenience: mark a cell as water ground (ground == 3). */
export const setWater = (v: number): number => setGround(v, GROUND_WATER);

/** Decode the bit-packed fields of a cell value (terrain/ground/isWater/forest). */
export function decodeCellFields(value: number): {
  terrain: number;
  ground: number;
  isWater: boolean;
  forest: number;
} {
  const ground = getGround(value);
  return { terrain: getTerrain(value), ground, isWater: ground === GROUND_WATER, forest: getForest(value) };
}

/** Build a full MapCell from a raw value at (x,y), keeping any road overlay given. */
export function makeCell(
  x: number,
  y: number,
  value: number,
  roadType = -1,
  roadVar = -1,
): MapCell {
  const f = decodeCellFields(value);
  return { x, y, value: value | 0, ...f, roadType, roadVar };
}
