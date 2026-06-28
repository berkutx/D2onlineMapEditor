/**
 * generate — decode a MarkovJunior symbol grid (from @d2/mapgen) into EditOps placed at a
 * region offset. The engine (@d2/mapgen) is game-agnostic; THIS is the game-specific
 * "decode table": symbol -> terrain setCell / landmark / mountain. Kept in @d2/map-edit so
 * it can reuse bits/brush/place; @d2/mapgen stays a pure engine (no dependency back here).
 *
 * Walls are landmark OBJECTS (decorCatalog shape="wall") chosen by a 4-neighbour 16-mask
 * → the catalog's iso.orient (NE-SW / NW-SE / corner) — the same autotiling idea as roads.
 */
import type { MapDocument } from "@d2/map-schema";
import type { EditOp } from "./ops.js";
import { applyOps } from "./ops.js";
import { brushValue, roadBrush } from "./brush.js";
import { placeLandmarkOps, placeMountainOps } from "./place.js";

/** Number of 1×1 mountain sprites in the catalog (MOMNE0100..MOMNE0126). */
const MOUNTAIN_IMAGES = 27;

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A symbol grid as produced by @d2/mapgen runRecipe (structural — no import coupling). */
export interface SymbolGrid {
  width: number;
  height: number;
  rows: string[];
}

export type DecodeAction =
  | { kind: "skip" }
  | { kind: "terrain"; terrain: number } // land tileset id (1=HU,2=DW snow,3=HE,4=UN,5=NE,6=EL)
  | { kind: "water" }
  | { kind: "forest" }
  | { kind: "wall" } // landmark wall, orientation from the 16-mask
  | { kind: "mountain" } // a 1×1 mountain object (+37 cell stamp)
  | { kind: "road" } // a road cell (auto-tiled via roadBrush)
  | { kind: "decor"; shape: string }; // a scattered decoration (decorCatalog 1×1 of `shape`)

export type DecodeTable = Record<string, DecodeAction>;

/** Decode tables per recipe id (the symbol grid is engine-agnostic; this maps to OUR tiles). */
export const DECODE_TABLES: Record<string, DecodeTable> = {
  // Mazes: B = the wall/barrier symbol; W/A = carved passage. Same MazeGrowth grid,
  // three different barrier materials (decoration walls / forest hedges / mountains).
  wall_maze: { B: { kind: "wall" }, W: { kind: "skip" }, A: { kind: "skip" } },
  hedge_maze: { B: { kind: "forest" }, W: { kind: "skip" }, A: { kind: "skip" } },
  mountain_maze: { B: { kind: "mountain" }, W: { kind: "skip" }, A: { kind: "skip" } },
  // Organic water (MJ growth): W = water, B = untouched land.
  water_lake: { W: { kind: "water" } },
  water_isles: { W: { kind: "water" } },
  river: { W: { kind: "water" }, R: { kind: "water" } }, // R = the path head
  // Organic forest (MJ): F = forest, B = untouched land.
  decor_forest: { F: { kind: "forest" } },
  forest_scatter: { F: { kind: "forest" } },
  forest_clearings: { F: { kind: "forest" }, B: { kind: "skip" } }, // forest with grown glades
  // Mountains / hills (MJ): M = a 1×1 mountain; R = ridge path head.
  mountain_fill: { M: { kind: "mountain" } },
  relief_ridge: { M: { kind: "mountain" }, R: { kind: "mountain" } },
  relief_hills: { M: { kind: "mountain" } },
  // Roads: P = path trail, R = path head (both become auto-tiled road cells).
  road_path: { P: { kind: "road" }, R: { kind: "road" } },
  // Scattered decorations (D = a placed object of the given catalog shape).
  decor_rocks: { D: { kind: "decor", shape: "rock" } },
  decor_bushes: { D: { kind: "decor", shape: "vegetation" } },
  decor_ruins: { D: { kind: "decor", shape: "ruin-building" } },
  decor_graves: { D: { kind: "decor", shape: "grave" } },
  // Snow: full wash, organic patches, or sparse scatter — all map S -> snow tileset.
  snow_overlay: { S: { kind: "terrain", terrain: 2 } }, // 2 = DW/snow tileset
  snow_patches: { S: { kind: "terrain", terrain: 2 } },
  snow_scatter: { S: { kind: "terrain", terrain: 2 } },
  grass_fill: { G: { kind: "terrain", terrain: 5 } }, // 5 = neutral land
};

/** One wall art set's 1×1 pieces grouped by iso orientation. */
export interface WallStyle {
  "NE-SW": string[];
  "NW-SE": string[];
  corner: string[];
}
/** Available wall styles (each a consistent art set). A maze uses ONE style so the walls
 *  don't mix faction art cell-to-cell; styles[0] = the preferred (stone) set. */
export interface WallSet {
  styles: WallStyle[];
}

interface WallCatalogEntry {
  id: string;
  shape: string;
  cx: number;
  cy: number;
  iso?: { orient?: string };
}

/**
 * Collect 1×1 wall/fence pieces from the catalog, grouped into consistent ART SETS
 * (shape + faction), each by iso orientation. Styles are sorted so the most complete
 * stone "wall" set is first — a maze then uses ONE style instead of mixing art.
 */
export function buildWallSet(
  catalog: Record<string, WallCatalogEntry> | WallCatalogEntry[],
): WallSet {
  const arr = Array.isArray(catalog) ? catalog : Object.values(catalog);
  const byStyle = new Map<string, WallStyle>();
  for (const e of arr) {
    if ((e.shape !== "wall" && e.shape !== "fence") || e.cx !== 1 || e.cy !== 1) continue;
    const key = `${e.shape}|${e.id.slice(0, 4)}`; // one art set = shape + faction prefix
    let st = byStyle.get(key);
    if (!st) { st = { "NE-SW": [], "NW-SE": [], corner: [] }; byStyle.set(key, st); }
    const o = e.iso?.orient;
    if (o === "NE-SW" || o === "NW-SE") st[o].push(e.id);
    else st.corner.push(e.id);
  }
  const score = (k: string, s: WallStyle): number =>
    (s["NE-SW"].length && s["NW-SE"].length ? 2 : 0) + Math.min(s.corner.length, 2) + (k.startsWith("wall|") ? 1 : 0);
  const usable = [...byStyle.entries()].filter(([, s]) => (s["NE-SW"].length || s["NW-SE"].length) && s.corner.length);
  usable.sort(([ka, a], [kb, b]) => score(kb, b) - score(ka, a) || (ka < kb ? 1 : -1)); // tie -> faction desc (stone G003 first)
  return { styles: usable.map(([, s]) => s) };
}

/** 1×1 decoration landmark ids grouped by catalog `shape` (rock / vegetation / …). */
export type DecorSet = Record<string, string[]>;

/** Group the catalog's 1×1 decorations by shape, for scatter recipes. */
export function buildDecorSet(
  catalog: Record<string, WallCatalogEntry> | WallCatalogEntry[],
): DecorSet {
  const arr = Array.isArray(catalog) ? catalog : Object.values(catalog);
  const set: DecorSet = {};
  for (const e of arr) {
    if ((e.cx ?? 1) > 1 || (e.cy ?? 1) > 1 || !e.shape) continue; // 1×1 only
    (set[e.shape] ??= []).push(e.id);
  }
  return set;
}

// 4 neighbours -> bit (N=1, E=2, S=4, W=8).
const N4: ReadonlyArray<readonly [number, number, number]> = [
  [0, -1, 1],
  [1, 0, 2],
  [0, 1, 4],
  [-1, 0, 8],
];

/**
 * 16-case wall autotiling → the piece id from one style. Cartesian N/S map to the iso
 * NE-SW axis, E/W to the iso NW-SE axis. The art only has straights + 2 corners (no
 * cap/T/cross sprites exist), so: straight runs AND ends use a straight; corners/T/cross/
 * post use a corner (the 2 rotations split across the 4 corner directions as a best fit).
 */
function wallPiece(mask: number, style: WallStyle): string | undefined {
  const n = mask & 1, e = mask & 2, s = mask & 4, w = mask & 8;
  const ns = n || s, ew = e || w;
  const NE = style["NE-SW"], NW = style["NW-SE"], CO = style.corner;
  if (ns && !ew) return NE[0] ?? NW[0] ?? CO[0]; // N–S run, or a N/S end
  if (ew && !ns) return NW[0] ?? NE[0] ?? CO[0]; // E–W run, or an E/W end
  if (CO.length) {
    const variant = mask === 3 || mask === 12 || mask === 7 || mask === 13 ? 0 : 1; // opposite-pair split
    return CO[variant % CO.length];
  }
  return NE[0] ?? NW[0];
}

/**
 * Decode `grid` into EditOps, offset by `region`. Terrain symbols become `setCell`;
 * wall symbols become landmark objects auto-oriented by their wall neighbours. Cells
 * outside the map are skipped. `walls` supplies the catalog ids per orientation.
 */
export function decodeGrid(
  doc: MapDocument,
  grid: SymbolGrid,
  table: DecodeTable,
  region: Region,
  walls: WallSet,
  /** Optional cell mask ("x,y" keys): only these cells receive ops (for brush/line/frame zones). */
  mask?: ReadonlySet<string>,
  /** Protect existing features: skip cells whose CURRENT value is water (ground==3) or
   *  a mountain stamp (37), so generation never overwrites a hand-made lake / mountain. */
  protect?: boolean,
  /** Decoration ids grouped by shape (for the "decor" action). */
  decor?: DecorSet,
): EditOp[] {
  const n = doc.size;
  const inb = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < n && y < n;
  const ops: EditOp[] = [];
  const wallCells = new Set<string>();
  const mountainCells: { x: number; y: number }[] = [];
  const roadCells: { x: number; y: number }[] = [];
  const decorCells: { x: number; y: number; shape: string }[] = [];

  // pass 1: terrain ops + collect wall cells
  for (let gy = 0; gy < grid.height; gy++) {
    for (let gx = 0; gx < grid.width; gx++) {
      const x = region.x + gx;
      const y = region.y + gy;
      if (!inb(x, y)) continue;
      if (mask && !mask.has(`${x},${y}`)) continue;
      const cell = doc.terrain.cells[y * n + x]!;
      if (protect && (((cell.value >> 3) & 7) === 3 || cell.value === 37)) continue;
      const action = table[grid.rows[gy]?.[gx] ?? ""] ?? { kind: "skip" };
      if (action.kind === "terrain") {
        const v = brushValue(cell.value, { type: "terrain", terrain: action.terrain }, x, y);
        if (v !== cell.value) ops.push({ kind: "setCell", x, y, value: v });
      } else if (action.kind === "water") {
        const v = brushValue(cell.value, { type: "water" }, x, y);
        if (v !== cell.value) ops.push({ kind: "setCell", x, y, value: v });
      } else if (action.kind === "forest") {
        const v = brushValue(cell.value, { type: "forest" }, x, y);
        if (v !== cell.value) ops.push({ kind: "setCell", x, y, value: v });
      } else if (action.kind === "wall") {
        wallCells.add(`${x},${y}`);
      } else if (action.kind === "mountain") {
        mountainCells.push({ x, y });
      } else if (action.kind === "road") {
        roadCells.push({ x, y });
      } else if (action.kind === "decor") {
        decorCells.push({ x, y, shape: action.shape });
      }
    }
  }

  // pass 2: object placements. Thread a working doc so each placeXOps allocates a fresh
  // id (they read the current max/count from the doc).
  let work = doc;

  // 2a: wall landmarks — ONE consistent style, auto-tiled by the 4-neighbour mask.
  const style = walls.styles[0];
  if (style) {
    for (const key of wallCells) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      let mask = 0;
      for (const [dx, dy, bit] of N4) if (wallCells.has(`${x + dx},${y + dy}`)) mask |= bit;
      const baseType = wallPiece(mask, style);
      if (!baseType) continue;
      const placeOps = placeLandmarkOps(work, x, y, baseType);
      ops.push(...placeOps);
      work = applyOps(work, placeOps);
    }
  }

  // 2b: mountains (1×1). Image varies by position so a range mixes sprites (no RNG — keeps
  // generation deterministic per seed); placeMountainOps also stamps the 37 cell value.
  for (const { x, y } of mountainCells) {
    const image = (((x * 31 + y * 17) % MOUNTAIN_IMAGES) + MOUNTAIN_IMAGES) % MOUNTAIN_IMAGES;
    const placeOps = placeMountainOps(work, x, y, 1, 1, image);
    ops.push(...placeOps);
    work = applyOps(work, placeOps);
  }

  // 2c: roads (auto-tiled). roadBrush recomputes the cell + its neighbours from the roads
  // already in the working doc, so threading produces correct connectivity.
  for (const { x, y } of roadCells) {
    const rOps = roadBrush(work, x, y);
    ops.push(...rOps);
    work = applyOps(work, rOps);
  }

  // 2d: scattered decorations — a landmark object picked from the catalog by shape (sprite
  // varies by position for variety). Skipped silently when no catalog/shape is available.
  if (decor) {
    for (const { x, y, shape } of decorCells) {
      const list = decor[shape];
      if (!list || !list.length) continue;
      const id = list[(((x * 31 + y * 17) % list.length) + list.length) % list.length]!;
      const placeOps = placeLandmarkOps(work, x, y, id);
      ops.push(...placeOps);
      work = applyOps(work, placeOps);
    }
  }
  return ops;
}
