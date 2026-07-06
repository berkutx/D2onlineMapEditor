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
import { runRecipe, getRecipe } from "@d2/mapgen";
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
}

/** A symbol grid as @d2/mapgen produces it (structural; no import coupling). */
interface SymbolGrid {
  width: number;
  height: number;
  rows: string[];
}

/** Build the symbol grid for one step: uniform fill, or run the MJ program (at region size,
 *  or `scale`× coarser for coarse recipes like the 2×2 wall maze). */
/** Does `symbol` touch at least two DISTINCT edges of the grid (a ribbon crossing it)? */
export function spansGrid(grid: SymbolGrid, symbol: string): boolean {
  let edges = 0;
  const hasIn = (s: string): boolean => s.includes(symbol);
  if (hasIn(grid.rows[0] ?? "")) edges++;
  if (grid.height > 1 && hasIn(grid.rows[grid.height - 1] ?? "")) edges++;
  if (grid.rows.some((r) => r[0] === symbol)) edges++;
  if (grid.width > 1 && grid.rows.some((r) => r[grid.width - 1] === symbol)) edges++;
  return edges >= 2;
}

/**
 * Seal a maze grid: force the barrier 'B' along the whole perimeter, then cut TWO
 * entrances (deterministic by seed, roughly opposite) where a corridor touches the
 * border. Canonical MazeGrowth leaves the border open on every side — a "maze" a stack
 * can walk around; sealing + two doors makes it a playable feature. Corridors are
 * always ONE connected component (audit: 100% of runs), so both doors reach everywhere.
 */
export function sealMazeGrid(grid: SymbolGrid, seed: number): SymbolGrid {
  const { width: w, height: h } = grid;
  if (w < 3 || h < 3) return grid;
  const cells = grid.rows.map((r) => r.split(""));
  const isPass = (x: number, y: number): boolean => cells[y]?.[x] === "A" || cells[y]?.[x] === "W";
  // entrance candidates BEFORE sealing: border cells whose inner neighbour is a corridor
  const candidates: { x: number; y: number }[] = [];
  for (let x = 1; x < w - 1; x++) {
    if (isPass(x, 1)) candidates.push({ x, y: 0 });
    if (isPass(x, h - 2)) candidates.push({ x, y: h - 1 });
  }
  for (let y = 1; y < h - 1; y++) {
    if (isPass(1, y)) candidates.push({ x: 0, y });
    if (isPass(w - 2, y)) candidates.push({ x: w - 1, y });
  }
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

async function buildGrid(
  recipe: { kind: string; fillSymbol?: string; xml?: string; fillFrac?: number; seedsFrac?: number; sealMaze?: boolean; spanSymbol?: string },
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
    // ribbon recipes must CROSS the zone; a degenerate Voronoi border (both growth seeds
    // near one edge) hugs a corner instead — re-roll the seed a few times
    const attempts = recipe.spanSymbol ? 8 : 1;
    let grid: SymbolGrid | undefined;
    for (let i = 0; i < attempts; i++) {
      grid = await runRecipe(xml, gw, gh, seed + i * 101);
      if (!recipe.spanSymbol || spansGrid(grid, recipe.spanSymbol)) break;
    }
    if (recipe.sealMaze) grid = sealMazeGrid(grid!, seed);
    return grid!;
  }
  throw new Error(`unknown recipe kind '${recipe.kind}'`);
}

/** Cheap deterministic hash → [0,1) from a global cell + seed (stable across requests). */
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
): Promise<EditOp[]> {
  let work = liveDoc;
  const all: EditOp[] = [];
  for (const step of steps) {
    let recipe: { kind: string; fillSymbol?: string; xml?: string; fillFrac?: number; seedsFrac?: number; sealMaze?: boolean; spanSymbol?: string; cellScale?: number; maskSymbol?: string; maskDensity?: number };
    let table: DecodeTable;
    if (step.recipeId) {
      const r = getRecipe(step.recipeId);
      const t = DECODE_TABLES[step.recipeId];
      if (!r || !t) throw new Error(`unknown recipe '${step.recipeId}'`);
      recipe = r;
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
    // "Follow the drawing": with a HAND-DRAWN mask, recipes that declare a maskSymbol stamp
    // it on the drawn cells directly (paths at density 1 = every cell; scatter decor at
    // density < 1 = sprinkled along the stroke) instead of running MJ on the bounding box and
    // keeping only the fragments that cross the stroke. No mask → normal MJ in the region.
    const maskFill = !!mask && typeof recipe.maskSymbol === "string";
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
    // occupancy rebuilt per step: a later step must respect the objects an earlier one placed
    const occupied = buildOccupiedSet(work, landmarkSizes);
    const ops = decodeGrid(work, grid, table, genRegion, walls, mask, protect, decor, maskFill ? 1 : scale, occupied, slot);
    all.push(...ops);
    work = applyOps(work, ops);
  }
  return all;
}
