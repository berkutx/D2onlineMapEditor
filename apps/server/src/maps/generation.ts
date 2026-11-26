/**
 * Generation executor — turns a list of generation STEPS into EditOps against a live
 * document, reusing the framework split: @d2/mapgen is the pure engine (recipe -> symbol
 * grid) and @d2/map-edit owns the game-specific DECODE (symbol grid -> EditOp[]). This
 * module is the SERVER-side glue that composes them, shared by both the single-recipe
 * `/generate` route (Phase 3 keyword router) and the `/copilot` LLM bridge (Phase 4 POC),
 * which may emit MULTIPLE steps and even author a recipe + decode table inline (Phase 5).
 *
 * Each step is decoded against a working doc threaded through the prior steps' ops, so a
 * later step (e.g. walls around a lake) sees the cells an earlier step changed.
 */
import { runRecipe, getRecipe, tuneRecipe } from "@d2/mapgen";
import { decodeGrid, applyOps, buildOccupiedSet, DECODE_TABLES, type DecodeTable, type WallSet, type DecorSet, type EditOp } from "@d2/map-edit";
import type { MapDocument } from "@d2/map-schema";

/** A region in cells: top-left + size. */
export interface StepRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An inline (LLM-authored) recipe: a uniform fill, or a MarkovJunior program. */
export interface InlineRecipe {
  kind: "fill" | "mj";
  /** fill: the single symbol stamped over the whole region. */
  fillSymbol?: string;
  /** mj: the MarkovJunior program XML (run at region size). May contain the token `STEPS`. */
  xml?: string;
  /** mj growth: fraction of region area to grow — replaces the `STEPS` token in the XML. */
  fillFrac?: number;
  /** mj: run on a grid this much coarser; decode places scale-sized pieces (wall_maze=2). */
  cellScale?: number;
}

/**
 * One generation step. EITHER reference a registered recipe by id (with its built-in
 * decode table), OR supply an inline recipe + its decode table (LLM authoring).
 */
export interface PlanStep {
  region: StepRegion;
  /** registered recipe id (water_lake / snow_overlay / grass_fill / decor_forest / wall_maze). */
  recipeId?: string;
  /** inline recipe (used when recipeId is absent). */
  recipe?: InlineRecipe;
  /** decode table for the inline recipe (symbol -> terrain/water/forest/wall/skip). */
  decode?: DecodeTable;
  /** MarkovJunior seed (mj recipes only; ignored by fills). */
  seed?: number;
  /** How much a registered recipe makes, relative to its stock amount (see tuneRecipe);
   *  1 or absent = as the library defines it. */
  amount?: number;
  /** A wall recipe: false = for looks (see MazeBuild.sealed); absent / true = an obstacle. */
  sealed?: boolean;
  /**
   * The mask is a shape the user DREW for this step (a brush stroke, a line, a frame), so a
   * recipe that can follow a drawing stamps its symbol along it. Absent/false: the mask only
   * CLIPS the result — the visible screen, a «по краю» band — and the recipe runs normally
   * inside the region. Without this distinction «река» on the default 👁 screen area
   * followed the screen's own mask and flooded everything the user could see.
   */
  followMask?: boolean;
}

/** A symbol grid as @d2/mapgen produces it (structural; no import coupling). */
interface SymbolGrid {
  width: number;
  height: number;
  rows: string[];
}

/** Build the symbol grid for one step: uniform fill, or run the MJ program (at region size,
 *  or `scale`× coarser for coarse recipes like the 2×2 wall maze). */
/** Does `symbol` connect two OPPOSITE edges of the grid (top↔bottom or left↔right)?
 *  «Two ANY edges» was the v1 check — a Voronoi frontier whose seed owned a corner produced
 *  a tiny arc touching top+left, passed, and shipped as the «river across the zone». Only
 *  opposite edges make a ribbon that actually CROSSES what the mapmaker selected. */
export function spansGrid(grid: SymbolGrid, symbol: string): boolean {
  const hasIn = (s: string): boolean => s.includes(symbol);
  const top = hasIn(grid.rows[0] ?? "");
  const bottom = grid.height > 1 && hasIn(grid.rows[grid.height - 1] ?? "");
  const left = grid.rows.some((r) => r[0] === symbol);
  const right = grid.width > 1 && grid.rows.some((r) => r[grid.width - 1] === symbol);
  return (top && bottom) || (left && right);
}

/**
 * Seal a maze grid: force the barrier 'B' along the whole perimeter, then cut TWO
 * entrances (deterministic by seed, roughly opposite) where a corridor touches the
 * border. Canonical MazeGrowth leaves the border open on every side — a "maze" a stack
 * can walk around; sealing + two doors makes it a playable feature. Corridors are
 * always ONE connected component (audit: 100% of runs), so both doors reach everywhere.
 *
 * An entrance is cut in front of a ROOM (W), not of a passage between rooms (A): on the maze
 * lattice the first is a span of the outer wall between two posts, the second is a post — and
 * a hole where a post stood is a one-cell gap with a stump of wall on either side.
 */
export function sealMazeGrid(grid: SymbolGrid, seed: number): SymbolGrid {
  const { width: w, height: h } = grid;
  if (w < 3 || h < 3) return grid;
  const cells = grid.rows.map((r) => r.split(""));
  // entrance candidates BEFORE sealing: border cells whose inner neighbour is a room — or, in
  // a grid that has none there (not a maze lattice), any corridor cell
  const collect = (open: (x: number, y: number) => boolean): { x: number; y: number }[] => {
    const out: { x: number; y: number }[] = [];
    for (let x = 1; x < w - 1; x++) {
      if (open(x, 1)) out.push({ x, y: 0 });
      if (open(x, h - 2)) out.push({ x, y: h - 1 });
    }
    for (let y = 1; y < h - 1; y++) {
      if (open(1, y)) out.push({ x: 0, y });
      if (open(w - 2, y)) out.push({ x: w - 1, y });
    }
    return out;
  };
  const byRooms = collect((x, y) => cells[y]?.[x] === "W");
  const candidates = byRooms.length ? byRooms : collect((x, y) => cells[y]?.[x] === "A" || cells[y]?.[x] === "W");
  for (let x = 0; x < w; x++) { cells[0]![x] = "B"; cells[h - 1]![x] = "B"; }
  for (let y = 0; y < h; y++) { cells[y]![0] = "B"; cells[y]![w - 1] = "B"; }
  if (candidates.length) {
    const a = ((seed % candidates.length) + candidates.length) % candidates.length;
    const b = (a + Math.floor(candidates.length / 2)) % candidates.length; // ~opposite
    const doors = a === b ? [candidates[a]!] : [candidates[a]!, candidates[b]!];
    for (const d of doors) cells[d.y]![d.x] = "A";
  }
  const rows = cells.map((r) => r.join(""));
  return { width: w, height: h, rows };
}

/**
 * The side of a maze lattice for a zone `units` grid cells long, with corridors `corridor`
 * cells wide. The maze program carves rooms two cells apart starting from the middle cell, so
 * the rooms sit on every other line; for BOTH outer lines to be wall lines the side must be
 * 3, 7, 11, … (4m + 3). Any other side leaves a line of rooms against the border, which the
 * sealing then walls up — a doubled wall with holes in it, and a cluster of joints at every
 * corner. Returns the largest such side whose widened maze still fits, or 0 when even the
 * smallest (one room) does not.
 */
export function mazeLatticeSide(units: number, corridor: number): number {
  const c = Math.max(1, Math.floor(corridor));
  let side = 0;
  for (let n = 3; (n + 1) / 2 + ((n - 1) / 2) * c <= units; n += 4) side = n;
  return side;
}

/**
 * Widen the corridors of a maze lattice (see mazeLatticeSide: wall lines are the even ones):
 * a wall line stays one cell thick, a room line becomes `corridor` cells. A wall between two
 * rooms turns into a run of `corridor` wall cells, a post stays a single cell — long walls,
 * joints `corridor + 1` apart.
 */
export function widenMazeGrid(grid: SymbolGrid, corridor: number): SymbolGrid {
  const c = Math.max(1, Math.floor(corridor));
  if (c === 1) return grid;
  const span = (i: number): number => (i % 2 === 0 ? 1 : c);
  const rows: string[] = [];
  for (let y = 0; y < grid.height; y++) {
    let row = "";
    for (let x = 0; x < grid.width; x++) row += (grid.rows[y]?.[x] ?? "B").repeat(span(x));
    for (let k = 0; k < span(y); k++) rows.push(row);
  }
  return { width: rows[0]?.length ?? 0, height: rows.length, rows };
}

async function buildGrid(
  recipe: { kind: string; fillSymbol?: string; xml?: string; fillFrac?: number; seedsFrac?: number; sealMaze?: boolean; spanSymbol?: string; corridor?: number },
  region: StepRegion,
  seed: number,
  scale: number,
): Promise<SymbolGrid> {
  if (recipe.kind === "fill") {
    const sym = recipe.fillSymbol ?? "X";
    return {
      width: region.w,
      height: region.h,
      rows: Array.from({ length: region.h }, () => sym.repeat(region.w)),
    };
  }
  if (recipe.kind === "mj") {
    if (!recipe.xml) throw new Error("mj recipe missing xml");
    if (recipe.sealMaze) {
      // a maze lives on its own lattice (mazeLatticeSide): the grid it returns is the widened
      // maze, which may be a little smaller than the zone — the caller centres it
      const corridor = recipe.corridor ?? 1;
      const lw = mazeLatticeSide(Math.floor(region.w / scale), corridor);
      const lh = mazeLatticeSide(Math.floor(region.h / scale), corridor);
      if (!lw || !lh) return { width: 0, height: 0, rows: [] }; // the zone is too small for one room
      return widenMazeGrid(sealMazeGrid(await runRecipe(recipe.xml, lw, lh, seed), seed), corridor);
    }
    const gw = Math.max(1, Math.floor(region.w / scale));
    const gh = Math.max(1, Math.floor(region.h / scale));
    let xml = recipe.xml;
    // growth recipes scale to the (coarse) grid: STEPS = round(area * fillFrac)
    if (xml.includes("STEPS")) {
      const frac = typeof recipe.fillFrac === "number" ? recipe.fillFrac : 0.4;
      const steps = Math.max(1, Math.round(gw * gh * frac));
      xml = xml.split("STEPS").join(String(steps));
    }
    // seeded recipes: a FIXED seed count (≥2) — a probabilistic scatter pass yields zero
    // seeds on small zones (water_isles silently produced nothing on 10×10)
    if (xml.includes("SEEDS")) {
      const k = typeof recipe.seedsFrac === "number" ? recipe.seedsFrac : 0.01;
      xml = xml.split("SEEDS").join(String(Math.max(2, Math.round(gw * gh * k))));
    }
    // ribbon recipes must CROSS the zone (opposite edges); a random two-seed Voronoi border
    // exits via adjacent edges (a corner arc) roughly half the time — re-roll the seed until
    // it crosses. Each run is milliseconds; 16 tries make a non-crossing outcome ~1e-5.
    const attempts = recipe.spanSymbol ? 16 : 1;
    let grid: SymbolGrid | undefined;
    for (let i = 0; i < attempts; i++) {
      grid = await runRecipe(xml, gw, gh, seed + i * 101);
      if (!recipe.spanSymbol || spansGrid(grid, recipe.spanSymbol)) break;
    }
    if (recipe.spanSymbol && grid && !spansGrid(grid, recipe.spanSymbol)) {
      // degenerate zone (e.g. 1×N) or a pathological seed streak — ship the last grid but
      // leave a trace so a «river didn't cross» report is diagnosable from docker logs
      // eslint-disable-next-line no-console
      console.warn(`[generate] ribbon did not span after ${attempts} attempts (${gw}x${gh}, seed=${seed})`);
    }
    return grid!;
  }
  throw new Error(`unknown recipe kind '${recipe.kind}'`);
}

/** Cheap deterministic hash → [0,1) from a global cell + seed (stable across requests). */
/** What a decode action puts on the map, as the preview legend names it (null = nothing). */
function legendOf(action: DecodeTable[string]): string | null {
  switch (action.kind) {
    case "skip": return null;
    case "terrain": return `terrain:${action.terrain}`;
    case "decor": return `decor:${action.shape}`;
    case "wall": return action.shape === "fence" ? "wall:fence" : "wall";
    default: return action.kind;
  }
}

/** A sample plan of a registered recipe (see GenRecipePreview): the recipe run at its stock
 *  amount over a small empty zone. The same code path as a real generation up to the symbol
 *  grid — so the picture in the help is what the generator really draws. */
export async function recipePreview(
  recipeId: string,
  opts: { width?: number; height?: number; seed?: number } = {},
): Promise<{ id: string; width: number; height: number; scale: number; rows: string[]; legend: Record<string, string> } | null> {
  const base = getRecipe(recipeId);
  const table = DECODE_TABLES[recipeId];
  if (!base || !table) return null;
  const recipe = tuneRecipe(base, 1) as Parameters<typeof buildGrid>[0] & { cellScale?: number };
  const scale = Number.isInteger(recipe.cellScale) && (recipe.cellScale as number) > 1 ? (recipe.cellScale as number) : 1;
  const snap = (n: number): number => Math.max(scale, n - (n % scale));
  const region = { x: 0, y: 0, w: snap(opts.width ?? 36), h: snap(opts.height ?? 24) };
  const grid = await buildGrid(recipe, region, opts.seed ?? 7, scale);
  const legend: Record<string, string> = {};
  for (const [symbol, action] of Object.entries(table)) {
    const what = legendOf(action);
    if (what) legend[symbol] = what;
  }
  return { id: recipeId, width: grid.width, height: grid.height, scale, rows: grid.rows.slice(), legend };
}

function rand01(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(seed, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Grid for "follow the drawing": each region cell gets `symbol` with probability `density`
 * (1 = every cell), else a blank "." that no decode table maps. The caller clips this to the
 * hand-drawn mask, so the symbol lands ALONG the drawn stroke — solid for paths (density 1),
 * sprinkled for scatter decor (density < 1). Deterministic by (global cell, seed).
 */
function maskFillGrid(region: StepRegion, symbol: string, density: number, seed: number): SymbolGrid {
  const rows: string[] = [];
  for (let gy = 0; gy < region.h; gy++) {
    let row = "";
    for (let gx = 0; gx < region.w; gx++) {
      row += density >= 1 || rand01(region.x + gx, region.y + gy, seed) < density ? symbol : ".";
    }
    rows.push(row);
  }
  return { width: region.w, height: region.h, rows };
}

/** The allowed decode-action kinds (mirrors @d2/map-edit DecodeAction) — guards inline tables. */
const DECODE_KINDS = new Set(["skip", "terrain", "water", "forest", "wall"]);

/** Light structural validation of an inline decode table (LLM-supplied). Throws on a bad shape. */
function assertDecodeTable(decode: unknown): asserts decode is DecodeTable {
  if (!decode || typeof decode !== "object") throw new Error("inline recipe needs a decode table");
  for (const [sym, action] of Object.entries(decode as Record<string, unknown>)) {
    const a = action as { kind?: string; terrain?: number };
    if (!a || typeof a !== "object" || !a.kind || !DECODE_KINDS.has(a.kind)) {
      throw new Error(`decode['${sym}'] must be one of ${[...DECODE_KINDS].join("/")}`);
    }
    if (a.kind === "terrain" && !Number.isInteger(a.terrain)) {
      throw new Error(`decode['${sym}'].terrain must be an integer tileset id`);
    }
  }
}

/**
 * Run all steps against `liveDoc`, threading the doc through each step's ops, and return
 * the concatenated EditOps. The caller validates + commits them as ONE undoable edit.
 * `mask` (optional "x,y" cell set) clips every step to a hand-drawn shape (brush/line/frame).
 */
export async function runGenerationSteps(
  liveDoc: MapDocument,
  steps: readonly PlanStep[],
  walls: WallSet,
  defaultSeed: number,
  mask?: ReadonlySet<string>,
  protect?: boolean,
  decor?: DecorSet,
  /** Landmark footprints by UPPERCASE baseType (catalog cx/cy) — feeds the occupancy
   *  guard so generation never writes under/over existing objects. */
  landmarkSizes?: Record<string, readonly [number, number]>,
  /** Collab id slot (M4): landmark ids mint in this slot's disjoint band so two clients
   *  generating concurrently never collide. 0 = solo (the caller passes the socket's slot). */
  slot = 0,
  /** Filled as the steps run: `wallGaps` = wall blocks a maze could not build (see MazeBuild.report). */
  report?: { wallGaps: number },
): Promise<EditOp[]> {
  let work = liveDoc;
  const all: EditOp[] = [];
  for (const step of steps) {
    let recipe: { kind: string; fillSymbol?: string; xml?: string; fillFrac?: number; seedsFrac?: number; sealMaze?: boolean; spanSymbol?: string; cellScale?: number; maskSymbol?: string; maskDensity?: number; corridor?: number };
    let table: DecodeTable;
    if (step.recipeId) {
      const r = getRecipe(step.recipeId);
      const t = DECODE_TABLES[step.recipeId];
      if (!r || !t) throw new Error(`unknown recipe '${step.recipeId}'`);
      recipe = tuneRecipe(r, step.amount ?? 1);
      table = t;
    } else if (step.recipe) {
      assertDecodeTable(step.decode);
      recipe = step.recipe;
      table = step.decode;
    } else {
      throw new Error("step needs a recipeId, or an inline recipe + decode");
    }
    const seed = Number.isInteger(step.seed) ? (step.seed as number) : defaultSeed;
    const scale = Number.isInteger(recipe.cellScale) && (recipe.cellScale as number) > 1 ? (recipe.cellScale as number) : 1;
    // "Follow the drawing": with a HAND-DRAWN mask (step.followMask), recipes that declare a maskSymbol stamp
    // it on the drawn cells directly (paths at density 1 = every cell; scatter decor at
    // density < 1 = sprinkled along the stroke) instead of running MJ on the bounding box and
    // keeping only the fragments that cross the stroke. No mask → normal MJ in the region.
    const maskFill = !!mask && step.followMask === true && typeof recipe.maskSymbol === "string";
    // Snap a scaled maze to the scale grid: align origin + size to a multiple of `scale` so the
    // 2×2 walls sit on even world cells and tile cleanly to the edge («кратно двум по стенам»).
    let genRegion = step.region;
    if (scale > 1 && !maskFill) {
      const sx = Math.floor(genRegion.x / scale) * scale;
      const sy = Math.floor(genRegion.y / scale) * scale;
      const sw = Math.max(scale, Math.floor((genRegion.x + genRegion.w - sx) / scale) * scale);
      const sh = Math.max(scale, Math.floor((genRegion.y + genRegion.h - sy) / scale) * scale);
      genRegion = { ...genRegion, x: sx, y: sy, w: sw, h: sh };
    }
    const grid = maskFill
      ? maskFillGrid(genRegion, recipe.maskSymbol!, recipe.maskDensity ?? 1, seed)
      : await buildGrid(recipe, genRegion, seed, scale);
    // a maze is as large as its lattice allows, which may be less than the zone: centre it
    if (recipe.sealMaze && !maskFill) {
      const spareX = Math.floor(genRegion.w / scale) - grid.width;
      const spareY = Math.floor(genRegion.h / scale) - grid.height;
      genRegion = {
        ...genRegion,
        x: genRegion.x + Math.floor(spareX / 2) * scale,
        y: genRegion.y + Math.floor(spareY / 2) * scale,
        w: grid.width * scale,
        h: grid.height * scale,
      };
    }
    // occupancy rebuilt per step: a later step must respect the objects an earlier one placed
    const occupied = buildOccupiedSet(work, landmarkSizes);
    // the seed also picks the maze's dress: which stone, which buildings on the joints
    const built = { gaps: 0 };
    const ops = decodeGrid(work, grid, table, genRegion, walls, mask, protect, decor, maskFill ? 1 : scale, occupied, slot,
      { variant: seed, sealed: step.sealed !== false, report: built });
    if (report) report.wallGaps += built.gaps;
    all.push(...ops);
    work = applyOps(work, ops);
  }
  return all;
}
