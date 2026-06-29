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

/** Mountain sprite image counts per footprint width (MOMNE{ww}{ii}): 1×1→27, 2×2→25, 3×3→26. */
const MOUNTAIN_IMAGES_BY_W: Record<number, number> = { 1: 27, 2: 25, 3: 26 };

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

/** Wall piece ids grouped by iso orientation (straights + corners). */
export interface WallPieces {
  "NE-SW": string[];
  "NW-SE": string[];
  corner: string[];
}
/** One wall art set (a faction's stone/wood walls): its 1×1 pieces (s1) + 2×2 pieces (s2),
 *  plus an optional matching corner TOWER. The game faces castles with the 2×2 stone set in
 *  long lines + towers at the corners — that's what a maze uses. */
export interface WallStyle {
  key: string;
  s1: WallPieces;
  s2: WallPieces;
  /** a plain stone turret of the same faction (placed at corners/junctions). */
  tower?: string;
}
/** Available wall styles. A maze uses ONE so the art doesn't mix; the 2×2 stone set wins. */
export interface WallSet {
  styles: WallStyle[];
}

const emptyWallPieces = (): WallPieces => ({ "NE-SW": [], "NW-SE": [], corner: [] });
const wallComplete = (p: WallPieces): boolean =>
  p.corner.length > 0 && (p["NE-SW"].length > 0 || p["NW-SE"].length > 0);

interface WallCatalogEntry {
  id: string;
  shape: string;
  cx: number;
  cy: number;
  iso?: { orient?: string };
  tone?: string;
  tags?: string[];
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
  const byKey = new Map<string, WallStyle>();
  for (const e of arr) {
    if (e.shape !== "wall" && e.shape !== "fence") continue;
    const cx = e.cx ?? 1, cy = e.cy ?? 1;
    if (!((cx === 1 && cy === 1) || (cx === 2 && cy === 2))) continue; // 1×1 + 2×2 only
    const key = `${e.shape}|${e.id.slice(0, 4)}`; // one art set = shape + faction prefix
    let st = byKey.get(key);
    if (!st) { st = { key, s1: emptyWallPieces(), s2: emptyWallPieces() }; byKey.set(key, st); }
    const pieces = cx === 2 ? st.s2 : st.s1;
    const o = e.iso?.orient;
    if (o === "NE-SW" || o === "NW-SE") pieces[o].push(e.id);
    else pieces.corner.push(e.id);
  }
  // matching corner TOWER per faction: a 1×1 plain stone turret (prefer tone "neutral", so a
  // grey turret that matches the wall — not the red-roof / snowy 2×2 watchtowers).
  const towerByFaction = new Map<string, { id: string; score: number }>();
  for (const e of arr) {
    if (e.shape !== "tower" || (e.cx ?? 1) !== 1 || (e.cy ?? 1) !== 1) continue;
    const fac = e.id.slice(0, 4);
    const score = e.tone === "neutral" || (e.tags ?? []).includes("neutral") ? 1 : 0;
    const cur = towerByFaction.get(fac);
    if (!cur || score > cur.score) towerByFaction.set(fac, { id: e.id, score });
  }

  const styles = [...byKey.values()].filter((s) => wallComplete(s.s1) || wallComplete(s.s2));
  for (const s of styles) s.tower = towerByFaction.get(s.key.split("|")[1] ?? "")?.id;
  // prefer "wall" (stone) over "fence", then faction desc, so the stone sets sort first.
  styles.sort((a, b) =>
    (a.key.startsWith("wall|") ? 0 : 1) - (b.key.startsWith("wall|") ? 0 : 1) || (a.key < b.key ? 1 : -1));
  return { styles };
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
function wallPiece(mask: number, pieces: WallPieces): string | undefined {
  const n = mask & 1, e = mask & 2, s = mask & 4, w = mask & 8;
  const ns = n || s, ew = e || w;
  const NE = pieces["NE-SW"], NW = pieces["NW-SE"], CO = pieces.corner;
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
  /** Cell scale: the symbol grid is `scale`× coarser than the region. Each grid cell maps to
   *  a scale×scale block (terrain fills the block; objects anchor at its corner + use a
   *  scale×scale sprite). Used by the wall maze (scale 2 → 2×2 stone wall pieces). */
  scale = 1,
): EditOp[] {
  const n = doc.size;
  const inb = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < n && y < n;
  const isProtected = (v: number): boolean => ((v >> 3) & 7) === 3 || v === 37;
  const allowed = (x: number, y: number): boolean =>
    inb(x, y) && !(mask && !mask.has(`${x},${y}`)) && !(protect && isProtected(doc.terrain.cells[y * n + x]!.value));
  const ops: EditOp[] = [];
  const wallCells = new Set<string>();
  const mountainCells: { x: number; y: number }[] = [];
  const roadCells: { x: number; y: number }[] = [];
  const decorCells: { x: number; y: number; shape: string }[] = [];

  // pass 1: terrain ops (fill the scale×scale block) + collect object anchors.
  for (let gy = 0; gy < grid.height; gy++) {
    for (let gx = 0; gx < grid.width; gx++) {
      const ax = region.x + gx * scale;
      const ay = region.y + gy * scale;
      const action = table[grid.rows[gy]?.[gx] ?? ""] ?? { kind: "skip" };
      if (action.kind === "skip") continue;
      if (action.kind === "terrain" || action.kind === "water" || action.kind === "forest") {
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const x = ax + dx, y = ay + dy;
            if (!allowed(x, y)) continue;
            const cv = doc.terrain.cells[y * n + x]!.value;
            const v =
              action.kind === "terrain" ? brushValue(cv, { type: "terrain", terrain: action.terrain }, x, y)
              : action.kind === "water" ? brushValue(cv, { type: "water" }, x, y)
              : brushValue(cv, { type: "forest" }, x, y);
            if (v !== cv) ops.push({ kind: "setCell", x, y, value: v });
          }
        continue;
      }
      // object actions: anchor at the block's corner
      if (!allowed(ax, ay)) continue;
      if (action.kind === "wall") wallCells.add(`${ax},${ay}`);
      else if (action.kind === "mountain") mountainCells.push({ x: ax, y: ay });
      else if (action.kind === "road") roadCells.push({ x: ax, y: ay });
      else if (action.kind === "decor") decorCells.push({ x: ax, y: ay, shape: action.shape });
    }
  }

  // pass 2: object placements. Thread a working doc so each placeXOps allocates a fresh
  // id (they read the current max/count from the doc).
  let work = doc;

  // 2a: wall landmarks — ONE consistent art set, auto-tiled by the 4-neighbour mask. At
  // scale 2 the maze is coarse and uses the 2×2 stone wall pieces (like the game's castles);
  // neighbours are checked at the coarse `scale` spacing.
  const wantS2 = scale >= 2;
  const style = walls.styles.find((s) => wallComplete(wantS2 ? s.s2 : s.s1)) ?? walls.styles[0];
  const pieces = style ? (wantS2 && wallComplete(style.s2) ? style.s2 : style.s1) : undefined;
  if (pieces && wallComplete(pieces)) {
    for (const key of wallCells) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      let m = 0;
      for (const [dx, dy, bit] of N4) if (wallCells.has(`${x + dx * scale},${y + dy * scale}`)) m |= bit;
      // a corner / junction / lone post (not a straight run) → a tower, else a wall piece.
      const straight = (!!(m & 1) || !!(m & 4)) !== (!!(m & 2) || !!(m & 8));
      const baseType = !straight && style?.tower ? style.tower : wallPiece(m, pieces);
      if (!baseType) continue;
      const placeOps = placeLandmarkOps(work, x, y, baseType);
      ops.push(...placeOps);
      work = applyOps(work, placeOps);
    }
  }

  // 2b: mountains — greedily pack the LARGEST sprite (3×3 → 2×2 → 1×1) that fits entirely
  // within the mountain-cell set, so a solid massif uses big peaks and a thin ridge stays
  // 1×1. Image varies by position (deterministic). placeMountainOps stamps the 37 cells.
  const mset = new Set(mountainCells.map((c) => `${c.x},${c.y}`));
  const placedM = new Set<string>();
  const mfits = (x0: number, y0: number, sz: number): boolean => {
    for (let dy = 0; dy < sz; dy++)
      for (let dx = 0; dx < sz; dx++) {
        const k = `${x0 + dx},${y0 + dy}`;
        if (!mset.has(k) || placedM.has(k)) return false; // mset cells are already in-bounds
      }
    return true;
  };
  const sortedM = mountainCells.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  for (const { x, y } of sortedM) {
    if (placedM.has(`${x},${y}`)) continue;
    let sz = 1;
    if (mfits(x, y, 3)) sz = 3;
    else if (mfits(x, y, 2)) sz = 2;
    const imgN = MOUNTAIN_IMAGES_BY_W[sz] ?? 1;
    const image = (((x * 31 + y * 17) % imgN) + imgN) % imgN;
    const placeOps = placeMountainOps(work, x, y, sz, sz, image);
    ops.push(...placeOps);
    work = applyOps(work, placeOps);
    for (let dy = 0; dy < sz; dy++) for (let dx = 0; dx < sz; dx++) placedM.add(`${x + dx},${y + dy}`);
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
