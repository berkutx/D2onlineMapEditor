/**
 * Recipe library (Layer 2) — the "what can be built" catalog. Each recipe is either a
 * MarkovJunior XML template (`kind:"mj"`, run on the region's WxH grid) or a uniform
 * `kind:"fill"` (no MJ; the whole region becomes one symbol). Both feed the same decoder
 * in @d2/map-edit (symbol → our terrain/object ops), keyed by recipe id.
 *
 * Growth-based recipes use a literal `STEPS` token in their XML; the executor replaces it
 * with `round(w*h*fillFrac)` so the organic shape scales to the selected region. This is
 * what makes a lake an irregular BLOB (grown from a seed) instead of a rectangle.
 */
export type RecipeInputMode = "zone" | "direction" | "point";
export type RecipeKind = "mj" | "fill";

export interface Recipe {
  id: string;
  kind: RecipeKind;
  /** MarkovJunior model XML (kind="mj"). May contain the literal token `STEPS`. */
  xml: string;
  /** the symbol to fill the region with (kind="fill"). */
  fillSymbol?: string;
  /** for growth recipes: fraction of the region area to grow (replaces `STEPS`). */
  fillFrac?: number;
  /** symbols the recipe can emit (its alphabet). */
  alphabet: string;
  inputMode: RecipeInputMode;
  notes?: string;
}

export const RECIPES: Record<string, Recipe> = {
  // --- organic water (MarkovJunior growth) ----------------------------------
  // A single irregular lake: seed the centre, grow water into neighbouring land.
  water_lake: {
    id: "water_lake",
    kind: "mj",
    xml: `<one values="BW" origin="True" in="WB" out="WW" steps="STEPS"/>`,
    fillFrac: 0.5,
    alphabet: "BW",
    inputMode: "zone",
    notes: "An organic (non-square) lake grown from the centre.",
  },
  // Archipelago: scatter a few seeds (one pass), then grow each into a blob.
  water_isles: {
    id: "water_isles",
    kind: "mj",
    xml: `<sequence values="BW"><prl in="B" out="W" p="0.006" steps="1"/><one in="WB" out="WW" steps="STEPS"/></sequence>`,
    fillFrac: 0.32,
    alphabet: "BW",
    inputMode: "zone",
    notes: "Several scattered organic lakes (an archipelago of water).",
  },
  // Winding river: a self-avoiding growth path (head R lays a water trail W).
  river: {
    id: "river",
    kind: "mj",
    xml: `<one values="BRW" origin="True" in="RBB" out="WWR"/>`,
    alphabet: "BRW",
    inputMode: "zone",
    notes: "A winding river / watercourse across the zone.",
  },

  // --- organic forest (MarkovJunior) ----------------------------------------
  // Groves: scatter seeds (one pass), then grow each into an irregular clump.
  decor_forest: {
    id: "decor_forest",
    kind: "mj",
    xml: `<sequence values="BF"><prl in="B" out="F" p="0.02" steps="1"/><one in="FB" out="FF" steps="STEPS"/></sequence>`,
    fillFrac: 0.28,
    alphabet: "BF",
    inputMode: "zone",
    notes: "Organic forest groves (clumped, not a solid block).",
  },
  // Sparse natural scatter of single trees (one pass, no growth).
  forest_scatter: {
    id: "forest_scatter",
    kind: "mj",
    xml: `<prl values="BF" in="B" out="F" p="0.06" steps="1"/>`,
    alphabet: "BF",
    inputMode: "zone",
    notes: "Sparse scattered trees (light woodland).",
  },
  // Dense forest with organic glades: fill with forest, scatter a few seeds, grow them into clearings.
  forest_clearings: {
    id: "forest_clearings",
    kind: "mj",
    xml: `<sequence values="FB"><prl in="F" out="B" p="0.01" steps="1"/><one in="BF" out="BB" steps="STEPS"/></sequence>`,
    fillFrac: 0.22,
    alphabet: "FB",
    inputMode: "zone",
    notes: "Dense forest broken by organic glades/clearings.",
  },

  // --- mazes (MarkovJunior MazeGrowth) --------------------------------------
  // Same MazeGrowth grid (B=barrier, W/A=passage), three barrier materials. hedge/mountain
  // read MUCH better than wall objects (continuous terrain vs. ~16 iso wall sprites).
  hedge_maze: {
    id: "hedge_maze",
    kind: "mj",
    xml: `<one values="BWA" in="WBB" out="WAW" origin="True"/>`,
    alphabet: "BWA",
    inputMode: "zone",
    notes: "A hedge maze — corridors between forest walls.",
  },
  mountain_maze: {
    id: "mountain_maze",
    kind: "mj",
    xml: `<one values="BWA" in="WBB" out="WAW" origin="True"/>`,
    alphabet: "BWA",
    inputMode: "zone",
    notes: "A stone labyrinth — corridors between mountain walls.",
  },
  wall_maze: {
    id: "wall_maze",
    kind: "mj",
    xml: `<one values="BWA" in="WBB" out="WAW" origin="True"/>`,
    alphabet: "BWA",
    inputMode: "zone",
    notes: "Maze of wall/fence decorations (sparse — prefer hedge/mountain maze).",
  },

  // --- mountains & hills (decoded to 1×1 mountain objects) -------------------
  // Solid mountains over the zone (use with the ▢ frame mode for a mountain border).
  mountain_fill: {
    id: "mountain_fill",
    kind: "fill",
    xml: "",
    fillSymbol: "M",
    alphabet: "M",
    inputMode: "zone",
    notes: "Fill the zone with mountains (a massif / border).",
  },
  // A winding mountain ridge (self-avoiding growth path, like the river).
  relief_ridge: {
    id: "relief_ridge",
    kind: "mj",
    xml: `<one values="BRM" origin="True" in="RBB" out="MMR"/>`,
    alphabet: "BRM",
    inputMode: "zone",
    notes: "A winding mountain ridge across the zone.",
  },
  // Scattered hills (sparse single mountains).
  relief_hills: {
    id: "relief_hills",
    kind: "mj",
    xml: `<prl values="BM" in="B" out="M" p="0.05" steps="1"/>`,
    alphabet: "BM",
    inputMode: "zone",
    notes: "Scattered hills / lone peaks.",
  },

  // --- snow: full wash, organic patches, or sparse scatter ------------------
  snow_overlay: {
    id: "snow_overlay",
    kind: "fill",
    xml: "",
    fillSymbol: "S",
    alphabet: "S",
    inputMode: "zone",
    notes: "Cover the zone with snow (a solid biome wash).",
  },
  // Organic snow patches (clumps) — scatter seeds then grow each.
  snow_patches: {
    id: "snow_patches",
    kind: "mj",
    xml: `<sequence values="BS"><prl in="B" out="S" p="0.02" steps="1"/><one in="SB" out="SS" steps="STEPS"/></sequence>`,
    fillFrac: 0.3,
    alphabet: "BS",
    inputMode: "zone",
    notes: "Patchy snow (organic clumps), not a solid sheet.",
  },
  // Sparse snow dabs (one random pass).
  snow_scatter: {
    id: "snow_scatter",
    kind: "mj",
    xml: `<prl values="BS" in="B" out="S" p="0.08" steps="1"/>`,
    alphabet: "BS",
    inputMode: "zone",
    notes: "Light dusting of snow (sparse cells).",
  },
  grass_fill: {
    id: "grass_fill",
    kind: "fill",
    xml: "",
    fillSymbol: "G",
    alphabet: "G",
    inputMode: "zone",
    notes: "Reset the zone to neutral grassland.",
  },
};

export function getRecipe(id: string): Recipe | undefined {
  return RECIPES[id];
}
