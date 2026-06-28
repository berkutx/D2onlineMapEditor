/**
 * @d2/mapgen — headless MarkovJunior recipe runner (Layer 1) + recipe library (Layer 2).
 * Pure engine: turns a recipe + region size into a symbol grid. It knows nothing about
 * the game/tiles; decoding the symbol grid into EditOps lives in @d2/map-edit.
 */
export { runRecipe, type RecipeGrid } from "./runRecipe.js";
export { RECIPES, getRecipe, type Recipe, type RecipeInputMode, type RecipeKind } from "./recipes.js";
