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
import { decodeGrid, applyOps, DECODE_TABLES, type DecodeTable, type WallSet, type DecorSet, type EditOp } from "@d2/map-edit";
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
async function buildGrid(
  recipe: { kind: string; fillSymbol?: string; xml?: string; fillFrac?: number },
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
    return await runRecipe(xml, gw, gh, seed);
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
): Promise<EditOp[]> {
  let work = liveDoc;
  const all: EditOp[] = [];
  for (const step of steps) {
    let recipe: { kind: string; fillSymbol?: string; xml?: string; fillFrac?: number; cellScale?: number; maskSymbol?: string; maskDensity?: number };
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
    const grid = maskFill
      ? maskFillGrid(step.region, recipe.maskSymbol!, recipe.maskDensity ?? 1, seed)
      : await buildGrid(recipe, step.region, seed, scale);
    const ops = decodeGrid(work, grid, table, step.region, walls, mask, protect, decor, maskFill ? 1 : scale);
    all.push(...ops);
    work = applyOps(work, ops);
  }
  return all;
}
