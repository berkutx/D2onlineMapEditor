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
  // landmark wall, orientation from the 16-mask. `shape` picks the art (stone "wall" by
  // default, or the wooden "fence"); `size` is the piece size the recipe is drawn with
  // (2 = the 2×2 fortress pieces of a coarse maze, 1 = one-cell pieces) — what a mod must have.
  | { kind: "wall"; shape?: "wall" | "fence"; size?: 1 | 2 }
  | { kind: "mountain" } // a 1×1 mountain object (+37 cell stamp)
  | { kind: "road" } // a road cell (auto-tiled via roadBrush)
  | { kind: "decor"; shape: string }; // a scattered decoration (decorCatalog 1×1 of `shape`)

export type DecodeTable = Record<string, DecodeAction>;

/** Decode tables per recipe id (the symbol grid is engine-agnostic; this maps to OUR tiles). */
export const DECODE_TABLES: Record<string, DecodeTable> = {
  // The mazes: B = the wall/barrier symbol, W/A = carved passage. Three looks of one idea:
  // a coarse fortress of 2×2 stone walls, a fine maze of one-cell stone walls, a palisade.
  wall_maze: { B: { kind: "wall", shape: "wall", size: 2 }, W: { kind: "skip" }, A: { kind: "skip" } },
  wall_maze_thin: { B: { kind: "wall", shape: "wall", size: 1 }, W: { kind: "skip" }, A: { kind: "skip" } },
  wall_maze_fence: { B: { kind: "wall", shape: "fence", size: 1 }, W: { kind: "skip" }, A: { kind: "skip" } },
  // Organic water (MJ growth): W = water, B = untouched land.
  water_lake: { W: { kind: "water" } },
  water_isles: { W: { kind: "water" } },
  // Islands: the region floods (W), grown B blobs stay DRY — untouched original terrain.
  water_islands: { W: { kind: "water" } },
  // River = the U-marked border of a two-seed Voronoi (canonical mxgmn River): crosses the
  // zone by construction. W/R are the competing growth colours — scaffolding, not water.
  river: { U: { kind: "water" } },
  // Organic forest (MJ): F = forest, B = untouched land.
  decor_forest: { F: { kind: "forest" } },
  forest_scatter: { F: { kind: "forest" } },
  forest_fill: { F: { kind: "forest" } }, // solid forest (zone or a brush stroke)
  // Mountains / hills (MJ): M = a 1×1 mountain; ridge = Voronoi border (U), greedy-packed
  // into 2×2/3×3 peaks by the decoder.
  mountain_fill: { M: { kind: "mountain" } },
  mountain_blob: { M: { kind: "mountain" } }, // organic massif (grown blob)
  relief_ridge: { U: { kind: "mountain" } },
  relief_hills: { M: { kind: "mountain" } },
  // Road = the thin (one-sided) Voronoi border, auto-tiled by roadBrush.
  road_path: { U: { kind: "road" } },
  // Scattered decorations (D = a placed object of the given catalog shape).
  decor_rocks: { D: { kind: "decor", shape: "rock" } },
  decor_bushes: { D: { kind: "decor", shape: "vegetation" } },
  decor_ruins: { D: { kind: "decor", shape: "ruin-building" } },
  decor_graves: { D: { kind: "decor", shape: "grave" } },
  // Snow: full wash, organic patches, or sparse scatter — all map S -> snow tileset.
  snow_overlay: { S: { kind: "terrain", terrain: 2 } }, // 2 = DW/snow tileset
  snow_patches: { S: { kind: "terrain", terrain: 2 } },
  grass_fill: { G: { kind: "terrain", terrain: 5 } }, // 5 = neutral land
};

/** Wall piece ids grouped by iso orientation (straights + corners). The straights of a
 *  direction are sorted whole pieces first: a ruined set also has half walls, which serve as
 *  the crumbled END of a run, not as its body. */
export interface WallPieces {
  "NE-SW": string[];
  "NW-SE": string[];
  corner: string[];
}
/** One wall art set — a run of pieces the game's tables number one after another (the stone
 *  wall 0046–0048, its mossy twin 8134–8136, the palisade 8296–8301): its 1×1 pieces (s1) or
 *  its 2×2 pieces (s2). The game faces castles with a 2×2 stone set in long lines and towers
 *  at the corners — that's what a maze uses. */
export interface WallStyle {
  key: string;
  s1: WallPieces;
  s2: WallPieces;
  /** the tone most of its pieces have ("neutral", "dark", …): a joint building is matched to it */
  tone?: string;
  /** one-cell corner pieces by the arms they join (the 4-neighbour mask: N|E = 3, E|S = 6,
   *  S|W = 12, W|N = 9). Set only when the art really has all four — a palisade does, ruined
   *  stone walls do not, and then a joint is a building instead. */
  corners?: Record<number, string>;
  /** one-cell half walls by the side they are attached to (the arm bit: N = 1, E = 2, S = 4,
   *  W = 8) — the crumbled end of a run */
  stubs?: Record<number, string>;
  /** a 1×1 stone turret that matches the set — what stands on its joints by default */
  tower?: string;
}
/** A building a maze may stand on a joint. `kind` is the catalogue's own English name of it:
 *  "Tower" (round stone), "Watchtower" (wooden), "Small tower", "Giants' tower", "Lighthouse",
 *  "Column", "Rune monolith", "Obelisk". */
export interface MazeOrnament {
  id: string;
  kind: string;
  tone: string;
}
/** Buildings for the joints of a maze, from the mod's catalogue. */
export interface MazeOrnaments {
  /** one-cell towers */
  towers: MazeOrnament[];
  /** 2×2 towers — a bastion for the corner of a fortress */
  bastions: MazeOrnament[];
  /** one-cell columns, monoliths and obelisks */
  pillars: MazeOrnament[];
}
/** Available wall styles (a maze uses ONE, so the art doesn't mix) and joint buildings. */
export interface WallSet {
  styles: WallStyle[];
  ornaments?: MazeOrnaments;
}

const emptyWallPieces = (): WallPieces => ({ "NE-SW": [], "NW-SE": [], corner: [] });
const wallComplete = (p: WallPieces): boolean =>
  p.corner.length > 0 && (p["NE-SW"].length > 0 || p["NW-SE"].length > 0);
const pieceCount = (st: WallStyle): number =>
  [st.s1, st.s2].reduce((n, p) => n + p["NE-SW"].length + p["NW-SE"].length + p.corner.length, 0);

interface WallCatalogEntry {
  id: string;
  shape: string;
  cx: number;
  cy: number;
  /** `dx` / `base`: where the piece sits on its source canvas (build_decor_catalog) — dx is
   *  how far its mass is off the canvas centre (−1 all left … +1 all right), base its lowest
   *  row counted down from the centre. Absent in a catalogue built before they existed. */
  iso?: { orient?: string; dx?: number; base?: number };
  tone?: string;
  tags?: string[];
  desc_en?: string;
}

/** a piece leaning this far off the centre is a half wall, or a corner that opens sideways */
const LEAN = 0.4;

/**
 * Collect the catalogue's wall and palisade pieces into ART SETS, and the buildings a maze may
 * stand on its joints. A set is a run of consecutive ids of one shape and footprint; sets come
 * 2×2 stone first (the fortress look), then by the number of pieces, so a recipe that asks for
 * a look gets its richest set.
 */
export function buildWallSet(
  catalog: Record<string, WallCatalogEntry> | WallCatalogEntry[],
  opts: { preferredTower?: string } = {},
): WallSet {
  // The round stone "Башня" the game's OWN maze maps place at junctions (verified on a
  // shipped maze scenario). Its id is a fact of the mod's tables: the mod's profile names it
  // (`mazeTower`); the stock id is the fallback for a catalog that comes without a profile.
  const preferredTower = (opts.preferredTower ?? "G000MG0149").toUpperCase();
  const arr = Array.isArray(catalog) ? catalog : Object.values(catalog);
  const sizeOf = (e: WallCatalogEntry): number => ((e.cx ?? 1) === 2 && (e.cy ?? 1) === 2 ? 2 : (e.cx ?? 1) === 1 && (e.cy ?? 1) === 1 ? 1 : 0);

  // ---- art sets
  const walls = arr
    .filter((e) => (e.shape === "wall" || e.shape === "fence") && sizeOf(e) > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const runs: { style: WallStyle; entries: WallCatalogEntry[] }[] = [];
  let prev: WallCatalogEntry | undefined;
  for (const e of walls) {
    const num = Number(e.id.slice(-4));
    const follows = !!prev && prev.shape === e.shape && sizeOf(prev) === sizeOf(e)
      && prev.id.slice(0, -4) === e.id.slice(0, -4) && Number.isInteger(num) && num === Number(prev.id.slice(-4)) + 1;
    if (!follows) runs.push({ style: { key: `${e.shape}|${e.id}`, s1: emptyWallPieces(), s2: emptyWallPieces() }, entries: [] });
    runs[runs.length - 1]!.entries.push(e);
    prev = e;
  }
  for (const { style, entries } of runs) {
    const into = sizeOf(entries[0]!) === 2 ? style.s2 : style.s1;
    const lean = (e: WallCatalogEntry): number => Math.abs(e.iso?.dx ?? 0);
    // whole pieces first within a direction (stable for a catalogue without the geometry)
    for (const e of entries.slice().sort((a, b) => lean(a) - lean(b))) {
      const o = e.iso?.orient;
      if (o === "NE-SW" || o === "NW-SE") into[o].push(e.id);
      else into.corner.push(e.id);
    }
    // the tone most pieces have
    const tones = new Map<string, number>();
    for (const e of entries) tones.set(e.tone ?? "neutral", (tones.get(e.tone ?? "neutral") ?? 0) + 1);
    style.tone = [...tones].sort((a, b) => b[1] - a[1] || (a[0] === "neutral" ? -1 : 1))[0]?.[0];
    if (into !== style.s1) continue;
    // one-cell pieces: tell the corners apart, and the half walls
    const straights = entries.filter((e) => e.iso?.orient === "NE-SW" || e.iso?.orient === "NW-SE");
    const bases = straights.map((e) => e.iso?.base).filter((b): b is number => typeof b === "number");
    const base = bases.length ? bases.reduce((a, b) => a + b, 0) / bases.length : undefined;
    const corners: Record<number, string> = {};
    for (const e of entries) {
      const dx = e.iso?.dx;
      if (e.iso?.orient !== "corner" || typeof dx !== "number") continue;
      // a corner opens to the side its mass leans to: right = toward N and E, left = S and W;
      // of two that sit in the middle, the one standing higher than the straights opens up
      // (W and N), the other down (E and S)
      const arms = dx > LEAN ? 3 : dx < -LEAN ? 12
        : typeof e.iso?.base === "number" && base !== undefined && e.iso.base < base - 3 ? 9 : 6;
      if (!(arms in corners)) corners[arms] = e.id;
    }
    if ([3, 6, 9, 12].every((m) => m in corners)) style.corners = corners;
    const stubs: Record<number, string> = {};
    for (const e of straights) {
      const dx = e.iso?.dx;
      if (typeof dx !== "number" || Math.abs(dx) <= LEAN - 0.1) continue;
      // on screen N is up-right and S down-left (the NE-SW pieces), E down-right and W up-left
      const arm = e.iso?.orient === "NE-SW" ? (dx > 0 ? 1 : 4) : dx > 0 ? 2 : 8;
      if (!(arm in stubs)) stubs[arm] = e.id;
    }
    if (Object.keys(stubs).length) style.stubs = stubs;
  }

  // ---- buildings for the joints
  const ornament = (e: WallCatalogEntry): MazeOrnament => ({ id: e.id, kind: e.desc_en ?? "Tower", tone: e.tone ?? "neutral" });
  const byId = (a: MazeOrnament, b: MazeOrnament): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const ornaments: MazeOrnaments = {
    towers: arr.filter((e) => e.shape === "tower" && sizeOf(e) === 1).map(ornament).sort(byId),
    bastions: arr.filter((e) => e.shape === "tower" && sizeOf(e) === 2).map(ornament).sort(byId),
    pillars: arr.filter((e) => (e.shape === "standing-stone" || e.shape === "obelisk") && sizeOf(e) === 1).map(ornament).sort(byId),
  };
  // the turret of a set: the mod's maze tower — unless the set has a tone of its own (mossy
  // stone), then a round tower of that tone first; a plain grey one before any other
  const round = ornaments.towers.filter((t) => t.kind === "Tower");
  const turrets = round.length ? round : ornaments.towers;
  const turretFor = (tone: string | undefined): string | undefined => {
    const own = tone ?? "neutral";
    const score = (t: MazeOrnament): number =>
      (t.id.toUpperCase() === preferredTower ? 4 : 0) + (t.tone === own ? (own === "neutral" ? 2 : 6) : 0) + (t.tone === "neutral" ? 1 : 0);
    return turrets.slice().sort((a, b) => score(b) - score(a) || byId(a, b))[0]?.id;
  };

  const styles = runs.map((r) => r.style).filter((st) => wallComplete(st.s1) || wallComplete(st.s2));
  for (const st of styles) st.tower = turretFor(st.tone);
  // stone before a palisade, the 2×2 sets first, then the richer set, then by id
  const rank = (st: WallStyle): number => (st.key.startsWith("wall|") ? 0 : 2) + (wallComplete(st.s2) ? 0 : 1);
  styles.sort((a, b) => rank(a) - rank(b) || pieceCount(b) - pieceCount(a) || (a.key < b.key ? -1 : 1));
  return { styles, ornaments };
}

/**
 * Cells occupied by the document's OBJECTS (footprint-aware) — the game-mechanics guard
 * the validator can't provide: generation must never flood a village, bury a stack under
 * a mountain, or stack a landmark on a merchant. Footprints: byte-verified type sizes;
 * mountains carry their own w/h; landmarks resolve through `landmarkSizes` (catalog cx/cy,
 * UPPERCASE baseType keys) and default to 1×1. Locations are ZONES, not solids — skipped.
 */
const TYPE_FOOTPRINT: Record<string, [number, number]> = {
  village: [4, 4],
  fort: [4, 4],
  capital: [5, 5],
  merchant: [3, 3],
  mage: [3, 3],
  trainer: [3, 3],
  mercenary: [3, 3],
  ruin: [3, 3],
};

export function buildOccupiedSet(
  doc: MapDocument,
  landmarkSizes?: Record<string, readonly [number, number]>,
): Set<string> {
  const out = new Set<string>();
  for (const o of doc.objects) {
    if (o.type === "location") continue; // a zone marker, not a solid
    let w = 1;
    let h = 1;
    if (o.type === "mountains") {
      const m = o as { w?: number; h?: number };
      w = m.w ?? 1;
      h = m.h ?? 1;
    } else if (o.type === "landmark") {
      const bt = ((o as { baseType?: string }).baseType ?? "").toUpperCase();
      const sz = landmarkSizes?.[bt];
      if (sz) [w, h] = sz;
    } else {
      const sz = TYPE_FOOTPRINT[o.type];
      if (sz) [w, h] = sz;
    }
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) out.add(`${o.pos.x + dx},${o.pos.y + dy}`);
  }
  return out;
}

/**
 * The art sets a wall recipe may be drawn with: of the asked shape (any, stone first, when none
 * is asked), with a complete set of pieces of the asked size — the richest ones only, so a
 * handful of wreckage pieces does not stand in for a wall. Empty when the mod has none: a
 * palisade maze in a mod without palisades, a fine maze in a mod with only fortress walls.
 */
export function wallStylesFor(walls: WallSet, shape: "wall" | "fence" | undefined, size: number): WallStyle[] {
  const pool = (shape ? walls.styles.filter((s) => s.key.startsWith(`${shape}|`)) : walls.styles)
    .filter((s) => wallComplete(size >= 2 ? s.s2 : s.s1));
  const best = Math.max(0, ...pool.map(pieceCount));
  return pool.filter((s) => pieceCount(s) === best);
}

/** The art set for a recipe; `variant` leafs through the sets that fit (stone, mossy stone…). */
export function pickWallStyle(walls: WallSet, shape: "wall" | "fence" | undefined, size: number, variant = 0): WallStyle | undefined {
  const pool = wallStylesFor(walls, shape, size);
  return pool.length ? pool[((variant % pool.length) + pool.length) % pool.length] : undefined;
}

/** 1×1 decoration landmark ids grouped by catalog `shape` (rock / vegetation / …). */
export type DecorSet = Record<string, string[]>;

/**
 * What a mod LACKS for a recipe, in a mapmaker's words — undefined when it has everything the
 * recipe places. A scatter recipe needs 1×1 decorations of its shape in the mod's catalogue
 * (Nazar's Legacy has no rocks, so «Камни» would run and place nothing); the maze needs a
 * complete set of wall pieces.
 */
export function recipeLacks(
  recipeId: string,
  sets: { walls: WallSet; decor: DecorSet },
): string | undefined {
  const table = DECODE_TABLES[recipeId];
  if (!table) return undefined;
  for (const action of Object.values(table)) {
    if (action.kind === "decor" && !sets.decor[action.shape]?.length) {
      return "в этом моде нет таких украшений";
    }
    // a coarse maze falls back to one-cell pieces when the mod has no 2×2 ones (decodeGrid)
    const size = action.kind === "wall" ? action.size ?? 2 : 0;
    if (action.kind === "wall" && !pickWallStyle(sets.walls, action.shape, size) && !(size === 2 && pickWallStyle(sets.walls, action.shape, 1))) {
      return "в этом моде нет стен для лабиринта";
    }
  }
  return undefined;
}

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

/** How a wall recipe (a maze) is built. */
export interface MazeBuild {
  /** Which of its looks it takes: the art set (stone or mossy stone) and the buildings on the
   *  joints. The server passes the seed, so «another variant» is another maze in another
   *  dress; 0 is the stock look. */
  variant?: number;
  /**
   * true (the default): the walls are an OBSTACLE. Every cell of every wall block holds a
   * piece — a joint of a fortress is its tower and three pieces of wall around it, never a
   * free cell — so nothing passes anywhere but the entrances, whatever the game's rules for a
   * diagonal step are. false: the maze is for LOOKS. A joint is as light as it can be and still
   * read as closed (towers alone, inside each turn); no cell is spent on a block that only
   * plugs a gap, and no promise is made that a party cannot squeeze through somewhere.
   */
  sealed?: boolean;
  /** Filled by the decode: `gaps` = wall blocks it could NOT build, because something stands
   *  there already or the terrain is protected — where even a sealed maze lets through. */
  report?: { gaps: number };
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
  /** Cells occupied by existing OBJECTS (buildOccupiedSet) — water/forest never write
   *  there, and wall/mountain/decor placements must fit entirely outside. Unconditional
   *  (not gated by `protect`): overwriting objects is never a legitimate generation. */
  occupied?: ReadonlySet<string>,
  /** Collab id slot (M4): landmark ids are minted in this slot's disjoint band so two clients
   *  generating CONCURRENTLY never collide. 0 = solo / offline (the low band). */
  slot = 0,
  /** How a wall recipe is built — see {@link MazeBuild}. */
  maze: MazeBuild = {},
): EditOp[] {
  const variant = maze.variant ?? 0;
  // sealed unless asked otherwise: a maze is an obstacle first
  const sealed = maze.sealed !== false;
  const n = doc.size;
  const inb = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < n && y < n;
  const isProtected = (v: number): boolean => ((v >> 3) & 7) === 3 || v === 37;
  const allowed = (x: number, y: number): boolean =>
    inb(x, y) && !(mask && !mask.has(`${x},${y}`)) && !(protect && isProtected(doc.terrain.cells[y * n + x]!.value));
  const free = (x: number, y: number): boolean => !occupied?.has(`${x},${y}`);
  /** An object footprint fits: every cell in-bounds, mask/protect-allowed AND unoccupied. */
  const fits = (x0: number, y0: number, w: number, h: number): boolean => {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) {
        if (!allowed(x0 + dx, y0 + dy) || !free(x0 + dx, y0 + dy)) return false;
      }
    return true;
  };
  const ops: EditOp[] = [];
  const wallCells = new Set<string>();
  /** the art the recipe's wall symbol asks for (one per recipe) */
  let wallShape: "wall" | "fence" | undefined;
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
            // water would drown an object, forest puts a tree on it — never write there.
            // Plain terrain (snow/grass biome washes) stays legal UNDER objects.
            if ((action.kind === "water" || action.kind === "forest") && !free(x, y)) continue;
            const cv = doc.terrain.cells[y * n + x]!.value;
            const v =
              action.kind === "terrain" ? brushValue(cv, { type: "terrain", terrain: action.terrain }, x, y)
              : action.kind === "water" ? brushValue(cv, { type: "water" }, x, y)
              : brushValue(cv, { type: "forest" }, x, y);
            if (v !== cv) {
              // water also WASHES AWAY a road on the cell (a road under water is invalid
              // in the game; applyOp would otherwise inherit prev.roadType). Only when a
              // road actually exists — a bare roadType:-1 on a roadless cell would make
              // the byte writer look for a MidRoad record that isn't there.
              const hadRoad = doc.terrain.cells[y * n + x]!.roadType !== -1;
              if (action.kind === "water" && hadRoad)
                ops.push({ kind: "setCell", x, y, value: v, roadType: -1, roadVar: -1 }); // -1/-1 = the road-erase idiom
              else ops.push({ kind: "setCell", x, y, value: v });
            }
          }
        continue;
      }
      // object actions: the WHOLE scale×scale block must be allowed AND unoccupied (the
      // old anchor-only check let 2×2 wall pieces overhang masks and existing objects)
      if (action.kind === "wall") {
        wallShape = action.shape;
        if (fits(ax, ay, scale, scale)) wallCells.add(`${ax},${ay}`);
        // a block on the map that the wall cannot take (off the map nobody walks anyway)
        else if (maze.report && inb(ax, ay) && inb(ax + scale - 1, ay + scale - 1)) maze.report.gaps++;
      } else if (action.kind === "mountain") {
        if (fits(ax, ay, 1, 1)) mountainCells.push({ x: ax, y: ay });
      } else if (action.kind === "road") {
        if (allowed(ax, ay)) roadCells.push({ x: ax, y: ay });
      } else if (action.kind === "decor") {
        // decor never lands on water (a floating boulder) — regardless of `protect`
        const wet = ((doc.terrain.cells[ay * n + ax]!.value >> 3) & 7) === 3;
        if (fits(ax, ay, 1, 1) && !wet) decorCells.push({ x: ax, y: ay, shape: action.shape });
      }
    }
  }

  // pass 2: object placements. Thread a working doc so each placeXOps allocates a fresh
  // id (they read the current max/count from the doc).
  let work = doc;

  // 2a: wall landmarks — ONE consistent art set, auto-tiled by the 4-neighbour mask, with a
  // building on the joints the art has no piece for. At scale 2 the maze is coarse and uses
  // the 2×2 stone wall pieces; neighbours are checked at the coarse `scale` spacing.
  const wantS2 = scale >= 2;
  const look = Math.abs(Math.trunc(variant));
  // (a coarse maze in a mod without 2×2 pieces is built from one-cell ones — see recipeLacks)
  const style = pickWallStyle(walls, wallShape, scale, look) ?? pickWallStyle(walls, wallShape, 1, look) ?? (wallShape ? undefined : walls.styles[0]);
  const pieces = style ? (wantS2 && wallComplete(style.s2) ? style.s2 : style.s1) : undefined;
  const coarse = wantS2 && !!style && pieces === style.s2;
  if (style && pieces && wallComplete(pieces)) {
    const place = (x: number, y: number, type: string): void => {
      const op = placeLandmarkOps(work, x, y, type, slot);
      ops.push(...op);
      work = applyOps(work, op);
    };
    const fence = style.key.startsWith("fence|");
    const orn = walls.ornaments;
    const tone = style.tone ?? "neutral";
    /** of a pool, the ones of the set's tone when there are any */
    const toned = (pool: readonly MazeOrnament[]): MazeOrnament[] => {
      const same = pool.filter((o) => o.tone === tone);
      return same.length ? same : pool.slice();
    };
    const ofKind = (...kinds: string[]): MazeOrnament[] => (orn?.towers ?? []).filter((t) => kinds.includes(t.kind));
    const nth = <T,>(pool: readonly T[], i: number): T | undefined => (pool.length ? pool[((i % pool.length) + pool.length) % pool.length] : undefined);

    // ---- what stands on the joints, by the look of the wall. One building of a kind per
    // maze (the variant picks which), so a maze is of a piece and the next one differs.
    // • a palisade: wooden watchtowers on the outer corners and by the entrances; its inner
    //   corners turn with its own four corner pieces;
    // • ruined one-cell stone walls: a column (monolith, obelisk) on every joint, a turret on
    //   the outer corners, and runs that crumble at their free ends;
    // • a fortress of 2×2 walls: a round tower on every joint, of the set's own stone — two
    //   kinds take turns when the mod has them — and, in every third variant, a 2×2 bastion
    //   on the outer corners.
    const watch = ofKind("Watchtower");
    const small = toned(ofKind("Small tower", "Giants' tower"));
    const turret = style.tower;
    // the set's turret, and the other round towers of the same stone to take turns with it
    const turretTone = orn?.towers.find((t) => t.id === turret)?.tone;
    const jointTowers = !turret || fence ? [] : [turret, ...ofKind("Tower").filter((t) => t.id !== turret && t.tone === turretTone).map((t) => t.id)];
    // (a column is its own thing — a grey monolith or a dark obelisk, whichever the variant brings)
    const pillar = fence || coarse ? undefined : nth(orn?.pillars ?? [], look)?.id;
    const cornerTower = fence ? nth(watch, look)?.id : coarse ? undefined : (nth(small, look)?.id ?? turret);
    const gateTower = fence ? nth(watch, look + 1)?.id ?? cornerTower : coarse ? undefined : cornerTower;
    // (of the bastions an earth-toned one first: the other lighthouse of the stock tables is snowed in)
    const bastions = (orn?.bastions ?? []).slice().sort((a, b) => Number(b.tone === "earth") - Number(a.tone === "earth"));
    const bastion = coarse && look % 3 === 2 ? bastions[0]?.id : undefined;
    // one-cell pieces of a matching look, to close a coarse joint around its single tower
    const thin = coarse ? pickWallStyle(walls, wallShape, 1, look)?.s1 : undefined;

    // the bounding box of the whole wall figure: its corners and its edges (an entrance is a
    // gap in an edge, so a wall that ENDS on the edge flanks an entrance)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const key of wallCells) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const ordered = [...wallCells].map((k) => k.split(",").map(Number) as [number, number]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    let joints = 0;
    for (const [x, y] of ordered) {
      let m = 0;
      for (const [dx, dy, bit] of N4) if (wallCells.has(`${x + dx * scale},${y + dy * scale}`)) m |= bit;
      const ns = !!(m & 1) || !!(m & 4), ew = !!(m & 2) || !!(m & 8);
      const straight = ns !== ew; // a run, or the end of one
      const arms = (m & 1 ? 1 : 0) + (m & 2 ? 1 : 0) + (m & 4 ? 1 : 0) + (m & 8 ? 1 : 0);
      const onEdge = x === minX || x === maxX || y === minY || y === maxY;
      const outerCorner = (x === minX || x === maxX) && (y === minY || y === maxY);
      const gate = arms === 1 && onEdge; // the outer wall stops here: one side of an entrance

      if (coarse) {
        // ---- a fortress: a straight block is one 2×2 piece — so is the free tip of an inner
        // wall; a corner, a branch, a lone post and the two sides of an entrance are joints
        if (straight && !gate) {
          const piece = wallPiece(m, pieces);
          if (piece) place(x, y, piece);
          continue;
        }
        if (outerCorner && bastion) { place(x, y, bastion); continue; } // a 2×2 building fills the block
        const tower = nth(jointTowers, joints++);
        if (!tower) { // no tower in the mod: the art's own piece, as far as it goes
          const piece = wallPiece(m, pieces);
          if (piece) place(x, y, piece);
          continue;
        }
        // SEALED: the whole block is built. ONE tower, in the block's FRONT cell (drawn over
        // the rest), and one-cell walls of the same stone in the other three — a straight
        // along the arm a cell touches, a corner block where it touches two or none. Without
        // one-cell walls in the mod the block is four towers. Heavy, and beyond doubt.
        // FOR LOOKS: towers alone, one in every cell that lies BETWEEN two arms — the inside
        // of a turn. The walls are two cells thick, so that cell touches both of them and the
        // joint reads as closed, while the rest of the block stays open ground: no rubble
        // beside the tower, no bunch of four.
        const front = scale - 1;
        if (sealed && scale === 2 && thin && wallComplete(thin)) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              if (dx === front && dy === front) continue;
              const alongNS = dy === 0 ? !!(m & 1) : !!(m & 4); // the arm above / below this cell
              const alongEW = dx === 0 ? !!(m & 8) : !!(m & 2); // the arm to its left / right
              const piece = alongNS !== alongEW
                ? wallPiece(alongNS ? 1 : 2, thin) // one arm: a straight along it
                : thin.corner[(dx + dy) % thin.corner.length]; // both or none: a corner block
              if (piece) place(x + dx, y + dy, piece);
            }
          }
          place(x + front, y + front, tower);
        } else if (!sealed && scale === 2) {
          const inside: [number, number][] = [];
          if (m & 1 && m & 2) inside.push([1, 0]); // north and east
          if (m & 2 && m & 4) inside.push([1, 1]); // east and south
          if (m & 4 && m & 8) inside.push([0, 1]); // south and west
          if (m & 8 && m & 1) inside.push([0, 0]); // west and north
          // a tip or a lone post has no turn: one tower, in the cell its wall runs into
          if (!inside.length) inside.push(!m || m & 6 ? [1, 1] : m & 1 ? [1, 0] : [0, 1]);
          for (const [dx, dy] of inside) place(x + dx, y + dy, tower);
        } else {
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) place(x + dx, y + dy, tower);
        }
        continue;
      }

      // ---- one-cell walls (also a coarse recipe in a mod with no 2×2 pieces: block by block)
      const cells: [number, number][] = [];
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) cells.push([x + dx, y + dy]);
      let piece: string | undefined;
      if (outerCorner && cornerTower) piece = cornerTower;
      else if (gate && gateTower) piece = gateTower;
      else if (straight && arms === 2) piece = wallPiece(m, pieces);
      else if (arms === 1) piece = style.stubs?.[m] ?? wallPiece(m, pieces); // a free end: it crumbles
      else if (arms === 2 && style.corners?.[m]) piece = style.corners[m]; // a corner the art has
      else if (arms === 0 && cornerTower) piece = cornerTower; // a lone post
      else if (fence) piece = wallPiece(arms >= 3 ? ((m & 5) === 5 ? 5 : 10) : m, pieces); // no T in the art: the through run
      else piece = pillar ?? wallPiece(m, pieces); // a joint: a column, or the art's own corner block
      if (!piece) piece = wallPiece(m, pieces);
      if (piece) for (const [cx, cy] of cells) place(cx, cy, piece);
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
      const placeOps = placeLandmarkOps(work, x, y, id, slot);
      ops.push(...placeOps);
      work = applyOps(work, placeOps);
    }
  }
  return ops;
}
