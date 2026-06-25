/**
 * Isometric coordinate math for the D2 map.
 *
 * PURE module — it must NOT import `pixi.js` (it is unit-tested under vitest/node,
 * which has no WebGL/DOM). Everything here is deterministic number-crunching.
 *
 * Cartesian map cells `(x, y)` (col, row) are projected to a 2:1 isometric diamond.
 * Disciples 2 terrain tiles are 192px wide; the diamond half-width is therefore 96
 * and the half-height 48 (2:1). The "screen" / world basis is:
 *
 *   worldX = (x - y) * HALF_W
 *   worldY = (x + y) * HALF_H
 *
 * which matches the documented Contract-A iso transform (`isoX = x - y`,
 * `isoY = (x + y) / 2`) scaled by the tile geometry.
 */

// D2 terrain TILE_SIZE = 32 -> iso diamonds are 64 wide x 32 tall (verified in the
// editor's MapTileHelper/MapRegionExtractor). Cell pitch is therefore HALF_W=32,
// HALF_H=16. Object/decoration sprites keep their native pixel size, so a city or
// mountain correctly spans several cells (as in the original editor).
/** Full iso diamond width in px (2 * TILE_SIZE). */
export const TILE_W = 64;
/** Diamond half-width = TILE_SIZE. */
export const HALF_W = 32;
/** Diamond half-height = TILE_SIZE / 2 (2:1 iso). */
export const HALF_H = 16;

/** Contract-A scalar iso transform: isoX = x - y. */
export function isoX(x: number, y: number): number {
  return x - y;
}

/** Contract-A scalar iso transform: isoY = (x + y) / 2. */
export function isoY(x: number, y: number): number {
  return (x + y) / 2;
}

export interface WorldPoint {
  x: number;
  y: number;
}

/**
 * Project a cartesian cell `(cx, cy)` to its world-space pixel position
 * (the CENTER of the iso diamond for that cell).
 *
 *   worldX = (cx - cy) * HALF_W
 *   worldY = (cx + cy) * HALF_H
 */
export function cellToWorld(cx: number, cy: number): WorldPoint {
  return {
    x: (cx - cy) * HALF_W,
    y: (cx + cy) * HALF_H,
  };
}

/**
 * Inverse of {@link cellToWorld}: map a world-space pixel back to a fractional
 * cartesian cell. Caller rounds/floors as needed for hit-testing.
 *
 *   cx = wy / (2*HALF_H) + wx / (2*HALF_W)
 *   cy = wy / (2*HALF_H) - wx / (2*HALF_W)
 */
export function worldToCell(wx: number, wy: number): WorldPoint {
  const a = wx / (2 * HALF_W);
  const b = wy / (2 * HALF_H);
  return {
    x: b + a,
    y: b - a,
  };
}

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/**
 * Axis-aligned world bounding box that contains every cell center of a
 * `size × size` map. For a diamond map the extreme centers are:
 *   - left   : cell (0, size-1)        -> worldX = -(size-1)*HALF_W
 *   - right  : cell (size-1, 0)        -> worldX =  (size-1)*HALF_W
 *   - top    : cell (0, 0)             -> worldY = 0
 *   - bottom : cell (size-1, size-1)   -> worldY = (2*size-2)*HALF_H
 *
 * The returned box is padded by one half-tile on every side so the full tile
 * art (not just the center) is covered.
 */
export function mapWorldBounds(size: number): WorldBounds {
  const s = Math.max(0, size - 1);
  const minX = -s * HALF_W - HALF_W;
  const maxX = s * HALF_W + HALF_W;
  const minY = 0 - HALF_H;
  const maxY = 2 * s * HALF_H + HALF_H;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
