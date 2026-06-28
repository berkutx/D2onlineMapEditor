/**
 * Public types for @d2/mapgen. Committed (the package ships an esbuild bundle for runtime;
 * tsc resolves types from here, so `build:tsc` needs no prior build of this package).
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

export interface Recipe {
  id: string;
  kind: RecipeKind;
  xml: string;
  fillSymbol?: string;
  /** mj growth: fraction of region area to grow (replaces the `STEPS` token in xml). */
  fillFrac?: number;
  alphabet: string;
  inputMode: RecipeInputMode;
  notes?: string;
}

export declare const RECIPES: Record<string, Recipe>;
export declare function getRecipe(id: string): Recipe | undefined;
