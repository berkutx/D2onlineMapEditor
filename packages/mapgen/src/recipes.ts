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
  /** for seeded recipes: fraction of the region area that becomes SEEDS — the executor
   *  replaces the `SEEDS` token with max(2, round(w*h*seedsFrac)). Deterministic seed
   *  count (a probabilistic prl p yields ZERO seeds on small zones → silent no-op). */
  seedsFrac?: number;
  /** maze recipes: after MJ, seal the grid perimeter with the barrier symbol and cut two
   *  entrances (canonical MazeGrowth leaves the border open on every side — not a maze
   *  a stack can meaningfully enter). Applied by the server executor. */
  sealMaze?: boolean;
  /** ribbon recipes (river/road/ridge): the result must touch ≥2 distinct grid edges with
   *  this symbol; the executor re-rolls the seed a few times otherwise (a degenerate
   *  Voronoi border can hug one edge). */
  spanSymbol?: string;
  /** cell scale: run the program on a grid this much coarser; each cell → a scale×scale
   *  block (decode places scale-sized pieces). Used by wall_maze (2 → 2×2 stone walls). */
  cellScale?: number;
  /** "Follow the drawing": when the user HAND-DRAWS a stroke (a cell mask), stamp this
   *  decode symbol on the drawn cells DIRECTLY instead of running MJ on the bounding box
   *  and keeping only the fragments that cross the stroke. Used by paths (road/river — the
   *  stroke IS the path) and scatter decor (rocks/bushes along the stroke). With no mask
   *  the recipe still runs MJ normally inside the region. */
  maskSymbol?: string;
  /** fraction of the drawn cells to stamp (0..1, default 1). Paths use 1 (every cell);
   *  scatter decor uses < 1 so it's sprinkled ALONG the stroke, not a solid wall. */
  maskDensity?: number;
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
  // Archipelago: a FIXED number of seeds (SEEDS token — prl p=0.006 yielded zero seeds on
  // small zones and merged blobs on big ones), then grow each into a blob.
  water_isles: {
    id: "water_isles",
    kind: "mj",
    xml: `<sequence values="BW"><one in="B" out="W" steps="SEEDS"/><one in="WB" out="WW" steps="STEPS"/></sequence>`,
    fillFrac: 0.32,
    seedsFrac: 0.006,
    alphabet: "BW",
    inputMode: "zone",
    notes: "Several scattered organic lakes (an archipelago of water).",
  },
  // River — canonical mxgmn River: two competing growths (W/R) fill the zone; their
  // contact line becomes the river (U), widened by 1 and diagonally smoothed. Crosses
  // the zone BY CONSTRUCTION (a Voronoi border always separates the two cells) — the old
  // self-avoiding walk (RBB→WWR) died in a dead-end mid-zone and never flowed across.
  river: {
    id: "river",
    kind: "mj",
    xml: `<sequence values="BWRU"><one in="B" out="W" steps="1"/><one in="B" out="R" steps="1"/><one><rule in="RB" out="RR"/><rule in="WB" out="WW"/></one><all in="RW" out="UU"/><all><rule in="W" out="B"/><rule in="R" out="B"/></all><all in="BU/UB" out="U*/**"/></sequence>`,
    alphabet: "BWRU",
    maskSymbol: "U", // a hand-drawn river follows the stroke (U = water), every cell
    spanSymbol: "U",
    inputMode: "zone",
    notes: "A river flowing across the whole zone (two-seed Voronoi border).",
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
    sealMaze: true,
    inputMode: "zone",
    notes: "A hedge maze — corridors between forest walls (sealed, two entrances).",
  },
  mountain_maze: {
    id: "mountain_maze",
    kind: "mj",
    xml: `<one values="BWA" in="WBB" out="WAW" origin="True"/>`,
    alphabet: "BWA",
    sealMaze: true,
    inputMode: "zone",
    notes: "A stone labyrinth — corridors between mountain walls (sealed, two entrances).",
  },
  wall_maze: {
    id: "wall_maze",
    kind: "mj",
    xml: `<one values="BWA" in="WBB" out="WAW" origin="True"/>`,
    cellScale: 2, // coarse maze + 2×2 stone wall pieces (matches how the game faces castles)
    alphabet: "BWA",
    sealMaze: true,
    inputMode: "zone",
    notes: "Крупный лабиринт из каменных стен 2×2, углы завёрнуты (запечатан, два входа).",
  },
  // Fine variant: scale 1 → 1×1 wall pieces + a 1×1 turret at each junction. A 1×1 tower fills
  // its single cell, so unlike the coarse 2×2 maze it leaves NO gap — and keeps the little
  // castle turrets on the corners. Denser + more pieces (≈4× the coarse maze).
  wall_maze_fine: {
    id: "wall_maze_fine",
    kind: "mj",
    xml: `<one values="BWA" in="WBB" out="WAW" origin="True"/>`,
    alphabet: "BWA",
    sealMaze: true,
    inputMode: "zone",
    notes: "Мелкий лабиринт из 1×1 стен с башенками на стыках (плотнее, с колоннами).",
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
  // A continuous mountain ridge across the zone: the same Voronoi border as the river
  // (the old walk snaked into a dense serpentine and died mid-zone), widened by 1 —
  // the decoder greedy-packs the 2–3 wide band into 2×2/3×3 peaks.
  relief_ridge: {
    id: "relief_ridge",
    kind: "mj",
    xml: `<sequence values="BWRU"><one in="B" out="W" steps="1"/><one in="B" out="R" steps="1"/><one><rule in="RB" out="RR"/><rule in="WB" out="WW"/></one><all in="RW" out="UU"/><all><rule in="W" out="B"/><rule in="R" out="B"/></all><all in="UB" out="UU" steps="1"/><all in="BU/UB" out="U*/**"/></sequence>`,
    alphabet: "BWRU",
    spanSymbol: "U",
    inputMode: "zone",
    notes: "A mountain ridge crossing the whole zone (Voronoi border, 2–3 wide).",
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

  // --- roads (decoded to auto-tiled road cells) -----------------------------
  // A road across the zone: the THIN (one-sided) Voronoi border — a single-cell winding
  // line from edge to edge, auto-tiled by roadBrush. The old self-avoiding walk filled a
  // third of the zone with a road serpentine that connected nothing.
  road_path: {
    id: "road_path",
    kind: "mj",
    xml: `<sequence values="BWRU"><one in="B" out="W" steps="1"/><one in="B" out="R" steps="1"/><one><rule in="RB" out="RR"/><rule in="WB" out="WW"/></one><all in="RW" out="UW"/><all><rule in="W" out="B"/><rule in="R" out="B"/></all><all in="BU/UB" out="U*/**"/></sequence>`,
    alphabet: "BWRU",
    maskSymbol: "U", // a hand-drawn road follows the stroke (U = road, auto-tiled), every cell
    spanSymbol: "U",
    inputMode: "zone",
    notes: "A winding road crossing the whole zone (thin Voronoi border).",
  },

  // --- scattered decorations (decoded to catalog landmark objects by shape) --
  // Same sparse-scatter program; the decode table maps D to a catalog shape.
  decor_rocks: {
    id: "decor_rocks",
    kind: "mj",
    xml: `<prl values="BD" in="B" out="D" p="0.04" steps="1"/>`,
    alphabet: "BD",
    maskSymbol: "D", // "rocks along this line": sprinkle decor along a hand-drawn stroke
    maskDensity: 0.5,
    inputMode: "zone",
    notes: "Scattered rocks / boulders.",
  },
  decor_bushes: {
    id: "decor_bushes",
    kind: "mj",
    xml: `<prl values="BD" in="B" out="D" p="0.05" steps="1"/>`,
    alphabet: "BD",
    maskSymbol: "D",
    maskDensity: 0.5,
    inputMode: "zone",
    notes: "Scattered bushes / vegetation.",
  },
  decor_ruins: {
    id: "decor_ruins",
    kind: "mj",
    xml: `<prl values="BD" in="B" out="D" p="0.02" steps="1"/>`,
    alphabet: "BD",
    maskSymbol: "D",
    maskDensity: 0.3,
    inputMode: "zone",
    notes: "Scattered ruins / broken buildings.",
  },
  decor_graves: {
    id: "decor_graves",
    kind: "mj",
    xml: `<prl values="BD" in="B" out="D" p="0.03" steps="1"/>`,
    alphabet: "BD",
    maskSymbol: "D",
    maskDensity: 0.4,
    inputMode: "zone",
    notes: "A graveyard / scattered bones & graves.",
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
  // Sparse snow dabs: tiny grown blobs (2–4 cells) — single-cell dots each grew a full
  // ring of snow/land transition tiles around themselves (visual noise, not a dusting).
  snow_scatter: {
    id: "snow_scatter",
    kind: "mj",
    xml: `<sequence values="BS"><prl in="B" out="S" p="0.02" steps="1"/><one in="SB" out="SS" steps="STEPS"/></sequence>`,
    fillFrac: 0.08,
    alphabet: "BS",
    inputMode: "zone",
    notes: "Light dusting of snow (small organic dabs).",
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
