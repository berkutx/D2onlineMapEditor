/**
 * Deterministic terrain frame selection.
 *
 * PURE module — no `pixi.js` import. Given a {@link MapCell} (Contract A) and the
 * manifest {@link TerrainIndex} (Contract B), it decides which atlas frame keys to
 * stamp for that cell: a base tile, optional border-blend overlays (by comparing the
 * 4 orthogonal neighbours), an optional road tile, and an optional forest overlay.
 *
 * The base-tile variation seed is the verified toolsqt `MapTileHelper` formula
 *   variant = (x*y + x + y) % n
 * so the same map always renders identically.
 *
 * This module intentionally knows nothing about WHERE frames live (that is the
 * AssetStore's job) — it only returns frame-key strings to look up.
 */
import type { MapCell, TerrainGrid } from "@d2/map-schema";
import type { TerrainIndex } from "@d2/asset-manifest";

/** Orthogonal neighbour direction codes used for border blending. */
export type Edge = "N" | "E" | "S" | "W";

/** One resolved terrain cell: ordered list of frame keys to stamp bottom-to-top. */
export interface TerrainStamp {
  /** base ground tile frame key (always present if the ground has any base art) */
  base?: string;
  /** border-blend overlays drawn over the base, in N,E,S,W order */
  borders: string[];
  /** road overlay frame key, if this cell has a road */
  road?: string;
  /** forest overlay frame key, if this cell has forest */
  forest?: string;
}

/** Look up a cell at (x,y) in a row-major grid; out-of-range -> undefined. */
export function cellAt(
  grid: TerrainGrid,
  x: number,
  y: number,
): MapCell | undefined {
  if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) return undefined;
  return grid.cells[y * grid.size + x];
}

/**
 * Variation seed: which variant of a multi-frame base/border set to use for a cell.
 * Verified formula `(x*y + x + y) % n`. `n<=0` -> 0.
 */
export function variantSeed(x: number, y: number, n: number): number {
  if (n <= 0) return 0;
  // x*y can be large but stays well within Number's safe integer range for map
  // sizes (<= a few hundred), so plain arithmetic is fine and deterministic.
  return ((x * y + x + y) % n + n) % n;
}

/** Pick a frame key from an ordered variant list using the seed. */
function pickVariant(
  keys: readonly string[] | undefined,
  x: number,
  y: number,
): string | undefined {
  if (!keys || keys.length === 0) return undefined;
  return keys[variantSeed(x, y, keys.length)];
}

/**
 * The "blend class" of a cell for border comparison. Water blends differently from
 * land, and each non-water ground (race terrain) blends against its neighbours by
 * ground id. We key border sets by ground id, plus a dedicated water key.
 */
function blendKey(cell: MapCell): string {
  return cell.isWater ? "water" : String(cell.ground);
}

const EDGES: ReadonlyArray<{ edge: Edge; dx: number; dy: number }> = [
  { edge: "N", dx: 0, dy: -1 },
  { edge: "E", dx: 1, dy: 0 },
  { edge: "S", dx: 0, dy: 1 },
  { edge: "W", dx: -1, dy: 0 },
];

/**
 * Resolve the full stamp for one cell.
 *
 * Border logic: for each of the 4 orthogonal neighbours, if the neighbour's blend
 * class differs from this cell's, we emit a border overlay for that edge. The
 * overlay frame key is taken from `terrain.borders[`<blendKey>_<EDGE>`]` (variant
 * seeded), falling back to `terrain.borders[blendKey]`. Missing entries are skipped
 * (the renderer simply draws no overlay — still deterministic).
 */
export function selectTerrain(
  grid: TerrainGrid,
  cell: MapCell,
  terrain: TerrainIndex | undefined,
): TerrainStamp {
  const stamp: TerrainStamp = { borders: [] };
  if (!terrain) return stamp;

  const { x, y } = cell;

  // --- base ---
  const baseKey = String(cell.ground);
  stamp.base =
    pickVariant(terrain.base[baseKey], x, y) ??
    // some manifests key water base separately
    (cell.isWater ? pickVariant(terrain.base["water"], x, y) : undefined);

  // --- borders (compare 4 neighbours) ---
  const self = blendKey(cell);
  for (const { edge, dx, dy } of EDGES) {
    const nb = cellAt(grid, x + dx, y + dy);
    // Treat off-map as "same" so map edges don't grow spurious borders.
    if (!nb) continue;
    const other = blendKey(nb);
    if (other === self) continue;
    // The border art belongs to the *neighbour's* class bleeding into this edge.
    const variants =
      terrain.borders[`${other}_${edge}`] ?? terrain.borders[other];
    const key = pickVariant(variants, x, y);
    if (key) stamp.borders.push(key);
  }

  // --- road ---
  if (cell.roadType >= 0) {
    const roadVariants = terrain.roads[String(cell.roadType)];
    if (roadVariants && roadVariants.length > 0) {
      const idx =
        cell.roadVar >= 0 && cell.roadVar < roadVariants.length
          ? cell.roadVar
          : variantSeed(x, y, roadVariants.length);
      stamp.road = roadVariants[idx];
    }
  }

  // --- forest ---
  if (cell.forest > 0) {
    stamp.forest = terrain.forest[String(cell.forest)];
  }

  return stamp;
}

/** Resolve every cell of a grid into an array of stamps (row-major, same order). */
export function selectAllTerrain(
  grid: TerrainGrid,
  terrain: TerrainIndex | undefined,
): TerrainStamp[] {
  return grid.cells.map((c) => selectTerrain(grid, c, terrain));
}
