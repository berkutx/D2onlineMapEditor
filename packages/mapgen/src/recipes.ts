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
/** What a recipe makes — how a generator palette groups them. */
export type RecipeGroup = "water" | "forest" | "mountains" | "snow" | "ground" | "structures" | "decor";
export const RECIPE_GROUPS: readonly RecipeGroup[] = ["mountains", "water", "forest", "snow", "ground", "structures", "decor"];

export interface Recipe {
  id: string;
  /** What a mapmaker calls it — the name on the generator palette (the editor is Russian). */
  title: string;
  group: RecipeGroup;
  /**
   * Present on recipes whose AMOUNT can be tuned ({@link tuneRecipe}): what "more / less"
   * means for this recipe, as a noun the palette shows next to the control («поляны» for a
   * dense forest — more of it means more glades, not more trees).
   */
  amountLabel?: string;
  /**
   * Offered in «По рисунку» with this kind of stroke: a `line` IS the thing (a road, a river,
   * a ridge); a `brush` area gets filled or sprinkled. Such a recipe either declares a
   * `maskSymbol` or is a fill.
   */
  stroke?: "line" | "brush";
  /** Width of that stroke in cells (1 = the path itself). */
  strokeWidth?: 1 | 3 | 5;
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
    title: "Озеро",
    group: "water",
    amountLabel: "размер озера",
    kind: "mj",
    xml: `<one values="BW" origin="True" in="WB" out="WW" steps="STEPS"/>`,
    fillFrac: 0.5,
    alphabet: "BW",
    inputMode: "zone",
    notes: "An organic (non-square) lake grown from the centre.",
  },
  // Several lakes: a FIXED number of seeds (SEEDS token — prl p=0.006 yielded zero seeds on
  // small zones), then grow each into a blob. Tuned to MORE seeds + LESS growth than v1
  // (0.006/0.32): on a 26×26 zone the old numbers merged everything into one giant lake,
  // which is what water_lake already does — "несколько озёр" must stay plural.
  water_isles: {
    id: "water_isles",
    title: "Несколько озёр",
    group: "water",
    amountLabel: "число и размер озёр",
    kind: "mj",
    xml: `<sequence values="BW"><one in="B" out="W" steps="SEEDS"/><one in="WB" out="WW" steps="STEPS"/></sequence>`,
    fillFrac: 0.22,
    seedsFrac: 0.012,
    alphabet: "BW",
    inputMode: "zone",
    notes: "Several scattered organic lakes.",
  },
  // ISLANDS (the inverse of water_isles): the region floods with water, but grown LAND blobs
  // survive as dry islands keeping their original terrain/objects. This is what a mapmaker
  // means by "острова/архипелаг" — the old menu routed it to water_isles (scattered LAKES),
  // the exact opposite of the request.
  water_islands: {
    id: "water_islands",
    title: "Острова",
    group: "water",
    amountLabel: "суша",
    kind: "mj",
    xml: `<sequence values="WB"><one in="W" out="B" steps="SEEDS"/><one in="BW" out="BB" steps="STEPS"/></sequence>`,
    fillFrac: 0.45,
    seedsFrac: 0.01,
    alphabet: "WB",
    inputMode: "zone",
    notes: "Water with dry organic islands (архипелаг: суша среди воды).",
  },
  // River — canonical mxgmn River: two competing growths (W/R) fill the zone; their
  // contact line becomes the river (U), widened by 1 and diagonally smoothed. Crosses
  // the zone BY CONSTRUCTION (a Voronoi border always separates the two cells) — the old
  // self-avoiding walk (RBB→WWR) died in a dead-end mid-zone and never flowed across.
  river: {
    id: "river",
    title: "Река",
    group: "water",
    stroke: "line",
    strokeWidth: 1,
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
    title: "Рощи",
    group: "forest",
    amountLabel: "лес",
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
    title: "Редкий лес",
    group: "forest",
    amountLabel: "деревья",
    stroke: "brush",
    strokeWidth: 5,
    kind: "mj",
    xml: `<prl values="BF" in="B" out="F" p="0.06" steps="1"/>`,
    alphabet: "BF",
    maskSymbol: "F", // light woodland along a brush stroke
    maskDensity: 0.3,
    inputMode: "zone",
    notes: "Sparse scattered trees (light woodland).",
  },
  // Dense forest with organic glades: fill with forest, scatter a few seeds, grow them into clearings.
  forest_clearings: {
    id: "forest_clearings",
    title: "Густой лес с полянами",
    group: "forest",
    amountLabel: "поляны",
    kind: "mj",
    xml: `<sequence values="FB"><prl in="F" out="B" p="0.01" steps="1"/><one in="BF" out="BB" steps="STEPS"/></sequence>`,
    fillFrac: 0.22,
    alphabet: "FB",
    inputMode: "zone",
    notes: "Dense forest broken by organic glades/clearings.",
  },

  // A SOLID forest over the zone/mask — what a mapmaker paints with a brush («лес под
  // кистью»); the grown recipes above are for a zone the generator shapes itself.
  forest_fill: {
    id: "forest_fill",
    title: "Сплошной лес",
    group: "forest",
    stroke: "brush",
    strokeWidth: 3,
    kind: "fill",
    xml: "",
    fillSymbol: "F",
    alphabet: "F",
    inputMode: "zone",
    notes: "Fill the zone/mask with forest (solid).",
  },

  // --- maze (MarkovJunior MazeGrowth) ---------------------------------------
  // The ONE maze: coarse (scale 2) stone-wall labyrinth. Walls are 2×2 stone pieces (auto-tiled),
  // junctions get a tower/corner. B=barrier, W/A=passage; the perimeter is sealed with two doors.
  wall_maze: {
    id: "wall_maze",
    title: "Лабиринт",
    group: "structures",
    kind: "mj",
    xml: `<one values="BWA" in="WBB" out="WAW" origin="True"/>`,
    cellScale: 2, // coarse maze + 2×2 stone wall pieces (matches how the game faces castles)
    alphabet: "BWA",
    sealMaze: true,
    inputMode: "zone",
    notes: "Лабиринт из каменных стен 2×2 с башнями на стыках (запечатан, два входа).",
  },

  // --- mountains & hills (decoded to 1×1 mountain objects) -------------------
  // Solid mountains over the zone/mask. Kept for the ▢ frame mode + «горы по краю» (the band
  // mask needs a FILL, not a blob); bare «горы/массив» routes to mountain_blob instead — a
  // mapmaker asking for a massif does not want a razor-edged solid rectangle.
  mountain_fill: {
    id: "mountain_fill",
    title: "Сплошные горы",
    group: "mountains",
    stroke: "brush",
    strokeWidth: 3,
    kind: "fill",
    xml: "",
    fillSymbol: "M",
    alphabet: "M",
    inputMode: "zone",
    notes: "Fill the zone/mask with mountains (frame border, solid wall).",
  },
  // An ORGANIC massif: one blob grown from the centre (the water_lake program with M) —
  // ragged natural edges instead of the fill's perfect rectangle.
  mountain_blob: {
    id: "mountain_blob",
    title: "Горный массив",
    group: "mountains",
    amountLabel: "размер массива",
    kind: "mj",
    xml: `<one values="BM" origin="True" in="MB" out="MM" steps="STEPS"/>`,
    fillFrac: 0.45,
    alphabet: "BM",
    inputMode: "zone",
    notes: "Горный массив с рваными краями (органическая клякса, не прямоугольник).",
  },
  // A continuous mountain ridge across the zone: the same Voronoi border as the river
  // (the old walk snaked into a dense serpentine and died mid-zone), widened by 1 —
  // the decoder greedy-packs the 2–3 wide band into 2×2/3×3 peaks.
  relief_ridge: {
    id: "relief_ridge",
    title: "Горная гряда",
    group: "mountains",
    stroke: "line",
    strokeWidth: 3,
    kind: "mj",
    xml: `<sequence values="BWRU"><one in="B" out="W" steps="1"/><one in="B" out="R" steps="1"/><one><rule in="RB" out="RR"/><rule in="WB" out="WW"/></one><all in="RW" out="UU"/><all><rule in="W" out="B"/><rule in="R" out="B"/></all><all in="UB" out="UU" steps="1"/><all in="BU/UB" out="U*/**"/></sequence>`,
    alphabet: "BWRU",
    maskSymbol: "U", // a hand-drawn ridge follows the stroke: a 3-wide line packs into 2×2/3×3 peaks
    spanSymbol: "U",
    inputMode: "zone",
    notes: "A mountain ridge crossing the whole zone (Voronoi border, 2–3 wide).",
  },
  // Scattered hills (sparse single mountains).
  relief_hills: {
    id: "relief_hills",
    title: "Холмы",
    group: "mountains",
    amountLabel: "холмы",
    stroke: "brush",
    strokeWidth: 5,
    kind: "mj",
    xml: `<prl values="BM" in="B" out="M" p="0.05" steps="1"/>`,
    alphabet: "BM",
    maskSymbol: "M", // hills sprinkled along a brush stroke
    maskDensity: 0.12,
    inputMode: "zone",
    notes: "Scattered hills / lone peaks.",
  },

  // --- roads (decoded to auto-tiled road cells) -----------------------------
  // A road across the zone: the THIN (one-sided) Voronoi border — a single-cell winding
  // line from edge to edge, auto-tiled by roadBrush. The old self-avoiding walk filled a
  // third of the zone with a road serpentine that connected nothing.
  road_path: {
    id: "road_path",
    title: "Дорога",
    group: "structures",
    stroke: "line",
    strokeWidth: 1,
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
    title: "Камни",
    group: "decor",
    amountLabel: "камни",
    stroke: "brush",
    strokeWidth: 3,
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
    title: "Кусты",
    group: "decor",
    amountLabel: "кусты",
    stroke: "brush",
    strokeWidth: 3,
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
    title: "Руины",
    group: "decor",
    amountLabel: "руины",
    stroke: "brush",
    strokeWidth: 3,
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
    title: "Могилы",
    group: "decor",
    amountLabel: "могилы",
    stroke: "brush",
    strokeWidth: 3,
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
    title: "Снег",
    group: "snow",
    stroke: "brush",
    strokeWidth: 3,
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
    title: "Снег пятнами",
    group: "snow",
    amountLabel: "снег",
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
    title: "Редкий снег",
    group: "snow",
    amountLabel: "снег",
    kind: "mj",
    xml: `<sequence values="BS"><prl in="B" out="S" p="0.02" steps="1"/><one in="SB" out="SS" steps="STEPS"/></sequence>`,
    fillFrac: 0.08,
    alphabet: "BS",
    inputMode: "zone",
    notes: "Light dusting of snow (small organic dabs).",
  },
  grass_fill: {
    id: "grass_fill",
    title: "Трава (очистить)",
    group: "ground",
    stroke: "brush",
    strokeWidth: 3,
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

/** The range {@link tuneRecipe} accepts: a quarter of the stock amount … three times it. */
export const AMOUNT_MIN = 0.25;
export const AMOUNT_MAX = 3;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Can {@link tuneRecipe} change how much this recipe makes? (It has a knob to turn.) */
export function isTunable(recipe: Recipe): boolean {
  return (
    recipe.fillFrac !== undefined ||
    recipe.seedsFrac !== undefined ||
    recipe.maskDensity !== undefined ||
    (recipe.kind === "mj" && /\bp="[0-9.]+"/.test(recipe.xml))
  );
}

/**
 * The same recipe making `amount` times as much: every quantity knob it has is scaled — the
 * growth (`fillFrac`), the number of seeds (`seedsFrac`), the scatter probabilities written
 * into the program (`p="…"`) and the density along a drawn stroke (`maskDensity`). The shape
 * of the program is untouched, so 1 returns the recipe itself and a recipe without knobs
 * (a river, a maze, a fill) is returned as it is. `amount` is clamped to
 * [{@link AMOUNT_MIN}, {@link AMOUNT_MAX}]; fractions stay inside what the programs can do.
 */
export function tuneRecipe(recipe: Recipe, amount: number): Recipe {
  const a = clamp(Number.isFinite(amount) ? amount : 1, AMOUNT_MIN, AMOUNT_MAX);
  if (a === 1 || !isTunable(recipe)) return recipe;
  const tuned: Recipe = { ...recipe };
  if (recipe.fillFrac !== undefined) tuned.fillFrac = round4(clamp(recipe.fillFrac * a, 0.02, 0.95));
  if (recipe.seedsFrac !== undefined) tuned.seedsFrac = round4(clamp(recipe.seedsFrac * a, 0.001, 0.2));
  if (recipe.maskDensity !== undefined) tuned.maskDensity = round4(clamp(recipe.maskDensity * a, 0.02, 1));
  if (recipe.kind === "mj") {
    tuned.xml = recipe.xml.replace(/\bp="([0-9.]+)"/g, (_m, v: string) => `p="${round4(clamp(Number(v) * a, 0.001, 0.9))}"`);
  }
  return tuned;
}

/** What a client needs to offer a recipe: its name, its group, and how it can be used. */
export interface RecipeInfo {
  id: string;
  title: string;
  group: RecipeGroup;
  /** Set when the amount can be tuned: what "more" means for it. */
  amountLabel?: string;
  /** Set when it is offered in «По рисунку»: the stroke to draw and its width. */
  stroke?: "line" | "brush";
  strokeWidth?: 1 | 3 | 5;
  /** Another seed gives another result (a program runs) — false for a plain fill, where
   *  asking for «another variant» would only repeat the same picture. */
  varies: boolean;
  /** The same question for a drawn stroke: only a recipe SPRINKLED along it varies; a path
   *  or a fill follows the stroke cell for cell whatever the seed. */
  strokeVaries: boolean;
}

/** Every recipe as a palette lists it, grouped in {@link RECIPE_GROUPS} order. */
export function recipeCatalog(): RecipeInfo[] {
  const out: RecipeInfo[] = [];
  for (const group of RECIPE_GROUPS) {
    for (const r of Object.values(RECIPES)) {
      if (r.group !== group) continue;
      const info: RecipeInfo = {
        id: r.id,
        title: r.title,
        group: r.group,
        varies: r.kind === "mj",
        strokeVaries: r.maskSymbol !== undefined ? (r.maskDensity ?? 1) < 1 : r.kind === "mj",
      };
      if (r.amountLabel !== undefined && isTunable(r)) info.amountLabel = r.amountLabel;
      if (r.stroke) {
        info.stroke = r.stroke;
        info.strokeWidth = r.strokeWidth ?? (r.stroke === "line" ? 1 : 3);
      }
      out.push(info);
    }
  }
  return out;
}
