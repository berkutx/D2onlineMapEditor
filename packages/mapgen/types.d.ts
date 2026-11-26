/**
 * Public types for @d2/mapgen. Committed (the package ships an esbuild bundle for runtime;
 * tsc resolves types from here, so `build:tsc` needs no prior build of this package).
 *
 * HAND-WRITTEN mirror of src/index.ts: when the public surface of the package changes,
 * change this file with it — and rebuild the bundle (`pnpm --filter @d2/mapgen run build`),
 * which is what the server actually runs.
 */
export interface RecipeGrid {
  width: number;
  height: number;
  rows: string[];
  at(x: number, y: number): string;
}

export declare function runRecipe(
  xml: string,
  width: number,
  height: number,
  seed?: number,
): Promise<RecipeGrid>;

export type RecipeInputMode = "zone" | "direction" | "point";
export type RecipeKind = "mj" | "fill";
/** What a recipe makes — how a generator palette groups them. */
export type RecipeGroup = "water" | "forest" | "mountains" | "snow" | "ground" | "structures" | "decor";
export declare const RECIPE_GROUPS: readonly RecipeGroup[];

export interface Recipe {
  id: string;
  /** What a mapmaker calls it — the name on the generator palette. */
  title: string;
  group: RecipeGroup;
  /** Present on recipes whose amount can be tuned: what "more" means for this recipe. */
  amountLabel?: string;
  /** Offered in «По рисунку» with this kind of stroke. */
  stroke?: "line" | "brush";
  /** Width of that stroke in cells. */
  strokeWidth?: 1 | 3 | 5;
  kind: RecipeKind;
  xml: string;
  fillSymbol?: string;
  /** mj growth: fraction of region area to grow (replaces the `STEPS` token in xml). */
  fillFrac?: number;
  /** mj seeded: fraction of region area that becomes seeds (replaces the `SEEDS` token). */
  seedsFrac?: number;
  /** maze: seal the perimeter and cut two entrances after the run. */
  sealMaze?: boolean;
  /** maze only: how wide a corridor is, in grid cells (a wall stays one grid cell thick).
   *  Default 1. A fine maze (one-cell walls) reads far better with 2: long walls, joints three
   *  cells apart, instead of a wall on every other cell. */
  corridor?: number;
  /** ribbon: the result must cross the zone with this symbol. */
  spanSymbol?: string;
  /** mj: run on a grid this much coarser; decode places scale-sized pieces (wall_maze=2). */
  cellScale?: number;
  /** follow a hand-drawn stroke: stamp this symbol on the drawn cells. */
  maskSymbol?: string;
  /** fraction of the drawn cells to stamp (0..1, default 1). */
  maskDensity?: number;
  alphabet: string;
  inputMode: RecipeInputMode;
  notes?: string;
}

export declare const RECIPES: Record<string, Recipe>;
export declare function getRecipe(id: string): Recipe | undefined;

/** The range tuneRecipe accepts. */
export declare const AMOUNT_MIN: number;
export declare const AMOUNT_MAX: number;
/** Can tuneRecipe change how much this recipe makes? */
export declare function isTunable(recipe: Recipe): boolean;
/** The same recipe making `amount` times as much (its quantity knobs scaled). */
export declare function tuneRecipe(recipe: Recipe, amount: number): Recipe;

/** What a client needs to offer a recipe. */
export interface RecipeInfo {
  id: string;
  title: string;
  group: RecipeGroup;
  amountLabel?: string;
  stroke?: "line" | "brush";
  strokeWidth?: 1 | 3 | 5;
  /** Another seed gives another result (false for a plain fill). */
  varies: boolean;
  /** The same for a drawn stroke (true only when the recipe is sprinkled along it). */
  strokeVaries: boolean;
}
/** Every recipe as a palette lists it, group by group. */
export declare function recipeCatalog(): RecipeInfo[];
