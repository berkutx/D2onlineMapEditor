/**
 * Painter's-order (z-index) computation for placed objects.
 *
 * PURE module — no `pixi.js` import.
 *
 * In an isometric scene the draw order is "back to front": a cell with a larger
 * `x + y` (further down/front on screen) must be drawn AFTER one with a smaller
 * `x + y`. We pack the band `(x + y)` into the high bits and a per-type tie-break
 * rank into the low bits, so within one diagonal band objects layer consistently
 * (e.g. terrain decals under buildings under units).
 *
 *   key = (frontCellX + frontCellY) * BANDS + typeRank
 *
 * Multi-tile objects occupy several cells; we sort them by their FRONT-MOST cell
 * (the one with the largest x + y inside the footprint), because that is the cell
 * whose neighbours can be occluded by the sprite.
 */
import type { MapObject } from "@d2/map-schema";

/**
 * Tie-break slots reserved per diagonal band. Must exceed the largest `typeRank`
 * so a higher band always outranks a lower one regardless of type. 100 leaves
 * plenty of headroom over the current ~24 object types.
 */
export const BANDS = 100;

/**
 * Per-type stacking rank within a band (low = drawn first / underneath).
 * Flat decals and terrain-ish features sit low; tall buildings and mobile
 * stacks sit high so they overlap correctly.
 */
const TYPE_RANK: Record<MapObject["type"], number> = {
  // ground-level / flat
  location: 0,
  landmark: 5,
  crystal: 10,
  treasure: 12,
  ruin: 15,
  mountains: 18,
  // structures
  merchant: 20,
  mage: 20,
  trainer: 20,
  mercenary: 20,
  village: 25,
  fort: 26,
  capital: 27,
  // mobile / top
  unit: 40,
  stack: 45,
  // non-visual / fallback
  generic: 1,
};

/** The per-type rank, defaulting to a low value for anything unmapped. */
export function typeRank(type: MapObject["type"]): number {
  return TYPE_RANK[type] ?? 1;
}

/** Object footprint (defaults to 1×1 when unspecified). */
function footprint(obj: MapObject): { w: number; h: number } {
  return obj.footprint ?? { w: 1, h: 1 };
}

/**
 * The front-most cell of an object's footprint: the (x,y) inside the footprint
 * with the maximum `x + y`. The anchor `pos` is treated as the back/top corner,
 * so the front cell is `(pos.x + w - 1, pos.y + h - 1)`.
 */
export function frontCell(obj: MapObject): { x: number; y: number } {
  const fp = footprint(obj);
  return { x: obj.pos.x + fp.w - 1, y: obj.pos.y + fp.h - 1 };
}

/**
 * The painter's-order key for an object. Larger = drawn later (in front).
 * If the schema provides an explicit `z`, it is added as a final micro tie-break
 * so authored overrides win within the same type+band.
 */
export function zKey(obj: MapObject): number {
  const fc = frontCell(obj);
  const band = fc.x + fc.y;
  const base = band * BANDS + typeRank(obj.type);
  // explicit z (if any) nudges within the same slot without crossing bands.
  return base + (obj.z ?? 0) / 1000;
}

/** Comparator producing back-to-front order; stable by id on ties. */
export function compareZ(a: MapObject, b: MapObject): number {
  const ka = zKey(a);
  const kb = zKey(b);
  if (ka !== kb) return ka - kb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Return a new array of objects sorted back-to-front for painting. */
export function sortByZ(objects: readonly MapObject[]): MapObject[] {
  return [...objects].sort(compareZ);
}
