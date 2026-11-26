/**
 * The command bar's interpreter (services/omnibar.ts): a typed line → ranked interpretations.
 *
 * The first table is a REGRESSION: phrases the bar's old keyword router (a chain of regexes in
 * CopilotBar.vue, Russian only) handled, each with the recipe that router gave — taken from its
 * regexes and its examples list before they were removed. The rest covers what the router
 * could not do: its bugs, English and Polish, typos, areas, amounts, tools, menu commands,
 * cells and search.
 */
import { describe, expect, it } from "vitest";
import {
  COMMAND_IDS, RECIPE_IDS, TOOL_IDS,
  editDistance, interpret, listActions, nearest, normalize, parseArea, textMatches, tokenize,
  type Interpretation,
} from "../src/services/omnibar";
import { EDIT_TOOLS } from "../src/layout/tools";
import en from "../src/i18n/locales/en.json";
import pl from "../src/i18n/locales/pl.json";

type Generate = Extract<Interpretation, { kind: "generate" }>;

/** What a reading comes to, as one word: the recipe, `tool:fog`, `view:grid`, `goto`, `find`. */
const idOf = (i: Interpretation | undefined): string | null =>
  !i ? null : i.kind === "generate" ? i.recipeId : i.kind === "tool" ? `tool:${i.tool}` : i.kind === "command" ? i.command : i.kind;
/** The best reading of a line. */
const first = (text: string): string | null => idOf(interpret(text)[0]);
/** All readings of a line, best first. */
const all = (text: string): (string | null)[] => interpret(text).map(idOf);
/** The best reading, which must be a generation. */
function generation(text: string): Generate {
  const i = interpret(text)[0];
  if (i?.kind !== "generate") throw new Error(`«${text}» is not read as a generation: ${JSON.stringify(i)}`);
  return i;
}

/** The 22 recipes the server had when the old keyword router was retired. */
const OLD_CATALOGUE = [
  "water_lake", "water_isles", "water_islands", "river", "decor_forest", "forest_scatter", "forest_clearings", "forest_fill",
  "wall_maze", "mountain_fill", "mountain_blob", "relief_ridge", "relief_hills", "road_path",
  "decor_rocks", "decor_bushes", "decor_ruins", "decor_graves", "snow_overlay", "snow_patches", "snow_scatter", "grass_fill",
];
/** …and what it has since: no «Густой лес с полянами», no «Редкий снег», two more mazes. */
const NEW_CATALOGUE = [
  ...OLD_CATALOGUE.filter((id) => id !== "forest_clearings" && id !== "snow_scatter"),
  "wall_maze_thin", "wall_maze_fence",
];

describe("the old keyword router's phrases keep their recipes", () => {
  const REGRESSION: [string, string][] = [
    // walls
    ["лабиринт", "wall_maze"], ["лабиринт 28x28", "wall_maze"], ["каменный лабиринт", "wall_maze"],
    ["забор", "wall_maze"], ["частокол", "wall_maze"], ["стена", "wall_maze"], ["стены вокруг", "wall_maze"],
    // hills, ridges, mountains
    ["холмы", "relief_hills"], ["холм", "relief_hills"], ["разбросай холмы", "relief_hills"],
    ["редкие горы", "relief_hills"], ["разбросай скалы", "relief_hills"], ["горы местами", "relief_hills"],
    ["горная гряда", "relief_ridge"], ["гряда гор", "relief_ridge"], ["хребет", "relief_ridge"], ["горный хребет", "relief_ridge"],
    ["горы", "mountain_blob"], ["горы 20x20", "mountain_blob"], ["гора", "mountain_blob"], ["скалы", "mountain_blob"],
    ["утёс", "mountain_blob"], ["горный массив", "mountain_blob"], ["массив", "mountain_blob"],
    ["горы вокруг этой точки 18x18", "mountain_blob"], ["добавь горы слева", "mountain_blob"], ["снежные горы", "mountain_blob"],
    ["горы по краю 30x30", "mountain_fill"], ["горы по периметру", "mountain_fill"], ["горы рамкой", "mountain_fill"],
    ["горы кольцом", "mountain_fill"], ["сплошные горы", "mountain_fill"], ["залей горами", "mountain_fill"],
    // roads and decorations
    ["дорога", "road_path"], ["извилистая дорога", "road_path"], ["тропа", "road_path"], ["тропинка", "road_path"],
    ["тропу", "road_path"], ["путь", "road_path"], ["перекрёсток", "road_path"], ["просёлок", "road_path"], ["дорога через лес", "road_path"],
    ["камни", "decor_rocks"], ["разбросай камни", "decor_rocks"], ["валуны", "decor_rocks"], ["булыжники", "decor_rocks"],
    ["кусты", "decor_bushes"], ["кустарник", "decor_bushes"], ["поросль", "decor_bushes"], ["кусты у воды", "decor_bushes"],
    ["руины", "decor_ruins"], ["развалины", "decor_ruins"],
    ["могилы", "decor_graves"], ["кладбище", "decor_graves"], ["кладбище 16x16", "decor_graves"], ["кости", "decor_graves"],
    ["черепа", "decor_graves"], ["надгробия", "decor_graves"],
    // snow
    ["снег", "snow_overlay"], ["снег на севере", "snow_overlay"], ["снежный покров", "snow_overlay"], ["зима", "snow_overlay"], ["зимний лес", "snow_overlay"],
    ["редкий снег", "snow_scatter"], ["разбросай снег", "snow_scatter"], ["снег местами", "snow_scatter"],
    ["снег кое-где", "snow_scatter"], ["припорошить снегом", "snow_scatter"],
    ["снег пятнами", "snow_patches"], ["снег клочьями", "snow_patches"], ["снег островками", "snow_patches"],
    // water
    ["река", "river"], ["река по всей карте", "river"], ["речка", "river"], ["ручей", "river"], ["русло", "river"],
    ["острова", "water_islands"], ["острова 30x30", "water_islands"], ["архипелаг", "water_islands"], ["остров", "water_islands"], ["острова в море", "water_islands"],
    ["озёра", "water_isles"], ["озера", "water_isles"], ["несколько озёр", "water_isles"],
    ["озеро", "water_lake"], ["озеро в центре", "water_lake"], ["озеро вокруг этой точки 20x20", "water_lake"], ["пруд 10x10", "water_lake"],
    ["вода", "water_lake"], ["море", "water_lake"], ["болото", "water_lake"], ["залей водой", "water_lake"], ["залей", "water_lake"], ["озеро в лесу", "water_lake"],
    // forest
    ["лес", "decor_forest"], ["деревья", "decor_forest"], ["роща", "decor_forest"], ["роща вокруг этой точки 16x16", "decor_forest"],
    ["рощи по всей карте", "decor_forest"], ["лес островками", "decor_forest"],
    ["редкий лес", "forest_scatter"], ["разбросай деревья", "forest_scatter"], ["лес местами", "forest_scatter"], ["отдельные деревья", "forest_scatter"],
    ["густой лес", "forest_clearings"], ["лес с полянами", "forest_clearings"], ["густой лес с полянами", "forest_clearings"],
    ["чаща", "forest_clearings"], ["прогалины", "forest_clearings"], ["просека", "forest_clearings"],
    // ground
    ["трава", "grass_fill"], ["трава 20x20", "grass_fill"], ["трава по всей карте", "grass_fill"], ["земля", "grass_fill"],
    ["очисти", "grass_fill"], ["равнина", "grass_fill"], ["плато", "grass_fill"], ["луг", "grass_fill"],
  ];

  it("has at least 60 phrases, none twice, for every recipe of that catalogue", () => {
    expect(REGRESSION.length).toBeGreaterThanOrEqual(60);
    expect(new Set(REGRESSION.map(([phrase]) => phrase)).size).toBe(REGRESSION.length);
    // …but «Сплошной лес»: no phrase reached it (one of the router's bugs, see below)
    expect([...new Set(REGRESSION.map(([, recipe]) => recipe))].sort()).toEqual(OLD_CATALOGUE.filter((id) => id !== "forest_fill").sort());
  });
  // with the catalogue of that time: where a newer recipe now fits a phrase better («частокол»
  // has a maze of its own), the old one is what the phrase gave then
  it.each(REGRESSION)("«%s» → %s", (phrase, recipe) => {
    expect(idOf(interpret(phrase, { recipes: OLD_CATALOGUE })[0])).toBe(recipe);
  });

  it("with today's catalogue each of them is still a generation — of a recipe the server has", () => {
    const moved: Record<string, string> = {};
    for (const [phrase, recipe] of REGRESSION) {
      const now = interpret(phrase, { recipes: NEW_CATALOGUE })[0];
      expect(now?.kind, phrase).toBe("generate");
      const id = idOf(now)!;
      expect(NEW_CATALOGUE, phrase).toContain(id);
      if (id !== recipe) moved[phrase] = id;
    }
    // exactly these read differently: the recipe is gone (its nearest sibling stands in), or
    // a new one fits the words better
    expect(moved).toEqual({
      "забор": "wall_maze_fence", "частокол": "wall_maze_fence",
      "редкий снег": "snow_patches", "разбросай снег": "snow_patches", "снег местами": "snow_patches",
      "снег кое-где": "snow_patches", "припорошить снегом": "snow_patches",
      "густой лес": "forest_fill", "чаща": "forest_fill",
      "лес с полянами": "decor_forest", "густой лес с полянами": "decor_forest", "прогалины": "decor_forest", "просека": "decor_forest",
    });
  });
});

describe("the old router's bugs are fixed", () => {
  it("«на юге», «южная часть» name the south (its \\b never matched Cyrillic)", () => {
    expect(generation("снег на юге").area.where).toBe("south");
    expect(generation("лес, южная часть").area.where).toBe("south");
    expect(parseArea("на юге").where).toBe("south");
    expect(parseArea("южная часть").where).toBe("south");
  });
  it("«бор» is a forest, and «гор» a mountain word", () => {
    expect(first("бор")).toBe("decor_forest");
    expect(first("сосновый бор")).toBe("decor_forest");
    expect(first("среди гор")).toBe("mountain_blob");
    // …while words that merely begin so are not: no stem swallows them
    expect(all("борьба")).not.toContain("decor_forest");
    expect(all("гораздо")).not.toContain("mountain_blob");
  });
  it("«сплошной лес» reaches forest_fill", () => {
    expect(first("сплошной лес")).toBe("forest_fill");
    expect(first("лес по краю")).toBe("forest_fill"); // a frame band is a wall of it, as for mountains
  });
  it("«залей <чем-то>» fills with that thing, not with water", () => {
    expect(first("залей лесом")).toBe("forest_fill");
    expect(first("залей травой")).toBe("grass_fill");
    expect(first("залей снегом")).toBe("snow_overlay");
  });
});

describe("English and Polish", () => {
  const PHRASES: Record<string, { en: string[]; pl: string[] }> = {
    water_lake: { en: ["lake", "pond 10x10", "fill with water", "flood"], pl: ["jezioro", "staw", "zalej wodą"] },
    water_isles: { en: ["lakes", "several lakes", "a few ponds"], pl: ["jeziora", "kilka jezior", "stawy"] },
    water_islands: { en: ["islands", "archipelago"], pl: ["wyspy", "archipelag"] },
    river: { en: ["river", "a stream"], pl: ["rzeka", "strumień"] },
    decor_forest: { en: ["forest", "groves", "some trees"], pl: ["las", "zagajnik", "drzewa"] },
    forest_scatter: { en: ["sparse forest", "scattered trees"], pl: ["rzadki las", "rozrzuć drzewa"] },
    forest_clearings: { en: ["dense forest", "forest with clearings", "thicket"], pl: ["gęsty las", "las z polanami", "puszcza"] },
    forest_fill: { en: ["solid forest", "fill with forest", "forest along the edge"], pl: ["lity las", "wypełnij lasem", "las wzdłuż krawędzi"] },
    wall_maze: { en: ["maze", "labyrinth", "walls"], pl: ["labirynt", "mury"] },
    wall_maze_thin: { en: ["thin maze", "maze with thin walls", "narrow labyrinth"], pl: ["cienki labirynt", "labirynt z cienkimi ścianami"] },
    wall_maze_fence: { en: ["palisade maze", "fence", "a maze of fences"], pl: ["labirynt z palisady", "częstokół", "ogrodzenie"] },
    mountain_fill: { en: ["solid mountains", "mountains along the edge", "a ring of mountains"], pl: ["lite góry", "góry wzdłuż krawędzi", "góry ramką"] },
    mountain_blob: { en: ["mountains", "a mountain", "cliffs"], pl: ["góry", "masyw górski", "skały"] },
    relief_ridge: { en: ["ridge", "mountain ridge", "mountain range"], pl: ["grzbiet", "pasmo górskie", "łańcuch górski"] },
    relief_hills: { en: ["hills", "scatter hills", "sparse mountains"], pl: ["wzgórza", "rozrzuć wzgórza", "rzadkie góry"] },
    road_path: { en: ["road", "a winding path", "trail"], pl: ["droga", "kręta ścieżka", "szlak"] },
    decor_rocks: { en: ["rocks", "scatter stones", "boulders"], pl: ["kamienie", "rozrzuć kamienie", "głazy"] },
    decor_bushes: { en: ["bushes", "shrubs"], pl: ["krzaki", "krzewy"] },
    decor_ruins: { en: ["ruins", "rubble"], pl: ["ruiny", "gruzy"] },
    decor_graves: { en: ["graves", "graveyard", "skulls and bones"], pl: ["groby", "cmentarz", "czaszki"] },
    snow_overlay: { en: ["snow", "winter"], pl: ["śnieg", "zima"] },
    snow_patches: { en: ["patchy snow", "snow in patches"], pl: ["śnieg płatami", "śnieg plamami"] },
    snow_scatter: { en: ["sparse snow", "scatter snow"], pl: ["rzadki śnieg", "rozrzuć śnieg"] },
    grass_fill: { en: ["grass", "meadow", "clear"], pl: ["trawa", "łąka", "wyczyść"] },
  };

  it("has phrases for every recipe of the lexicon — every recipe the server has or had", () => {
    expect(Object.keys(PHRASES).sort()).toEqual([...RECIPE_IDS].sort());
    expect([...RECIPE_IDS].sort()).toEqual([...new Set([...OLD_CATALOGUE, ...NEW_CATALOGUE])].sort());
  });
  const rows = Object.entries(PHRASES).flatMap(([recipe, p]) => [...p.en, ...p.pl].map((phrase): [string, string] => [phrase, recipe]));
  it.each(rows)("“%s” → %s", (phrase, recipe) => {
    expect(first(phrase)).toBe(recipe);
  });

  it("reads Polish without its diacritics the same", () => {
    const pairs: [string, string][] = [
      ["śnieg płatami", "snieg platami"], ["gęsty las", "gesty las"], ["góry na południu", "gory na poludniu"],
      ["rozrzuć wzgórza", "rozrzuc wzgorza"], ["łąka", "laka"], ["wypełnij lasem", "wypelnij lasem"],
      ["kręta ścieżka", "kreta sciezka"], ["jezioro na środku", "jezioro na srodku"], ["mgła", "mgla"], ["cofnij", "cofnij"],
      ["otwórz mapę", "otworz mape"], ["skróty klawiszowe", "skroty klawiszowe"], ["znajdź Wieża", "znajdz Wieża"],
    ];
    for (const [marked, plain] of pairs) {
      expect(interpret(plain), plain).toEqual(interpret(marked));
      expect(interpret(plain).length, plain).toBeGreaterThan(0);
    }
    expect(normalize("ZAŻÓŁĆ GĘŚLĄ JAŹŃ")).toBe("zazolc gesla jazn");
    expect(normalize("Ёлка, Йод")).toBe("елка, йод"); // only ё → е; й stays a letter of its own
  });
});

describe("the area of a generation", () => {
  const AREAS: [string, Partial<Generate["area"]>][] = [
    ["озеро", { where: null, size: null, frame: false }],
    // around the cursor / here
    ["озеро вокруг этой точки 20x20", { where: "point", size: { w: 20, h: 20 } }],
    ["озеро тут", { where: "point" }], ["лес здесь 12х12", { where: "point", size: { w: 12, h: 12 } }], // the Cyrillic «х»
    ["горы около курсора", { where: "point" }], ["lake here 16 x 16", { where: "point", size: { w: 16, h: 16 } }],
    ["forest around the cursor", { where: "point" }], ["jezioro wokół tego punktu 20×20", { where: "point", size: { w: 20, h: 20 } }],
    ["las tutaj", { where: "point" }],
    // the whole map
    ["трава по всей карте", { where: "map" }], ["снег везде", { where: "map" }], ["лес на всю карту", { where: "map" }],
    ["grass over the whole map", { where: "map" }], ["snow everywhere", { where: "map" }], ["river across the entire map", { where: "map" }],
    ["trawa na całej mapie", { where: "map" }], ["rzeka przez całą mapę", { where: "map" }], ["śnieg wszędzie", { where: "map" }],
    // the centre
    ["озеро в центре", { where: "center" }], ["озеро по центру 30*20", { where: "center", size: { w: 30, h: 20 } }],
    ["lake in the center", { where: "center" }], ["lake in the middle", { where: "center" }], ["jezioro na środku", { where: "center" }],
    // sides
    ["снег на севере", { where: "north" }], ["северный лес", { where: "north" }], ["лес сверху", { where: "north" }],
    ["снег на юге", { where: "south" }], ["южный лес", { where: "south" }], ["лес снизу", { where: "south" }],
    ["горы на западе", { where: "west" }], ["западные горы", { where: "west" }], ["добавь горы слева", { where: "west" }],
    ["горы на востоке", { where: "east" }], ["восточные горы", { where: "east" }], ["горы справа", { where: "east" }],
    ["snow in the north", { where: "north" }], ["forest in the south", { where: "south" }], ["mountains in the west", { where: "west" }],
    ["hills on the right", { where: "east" }], ["snow at the top", { where: "north" }],
    ["śnieg na północy", { where: "north" }], ["las na południu", { where: "south" }], ["góry na zachodzie", { where: "west" }],
    ["wzgórza na wschodzie", { where: "east" }], ["las po lewej", { where: "west" }],
    // a perimeter band — on top of whatever the place is
    ["горы по краю 30x30", { where: null, size: { w: 30, h: 30 }, frame: true }], ["горы по периметру", { frame: true }],
    ["лес рамкой", { frame: true }], ["горы кольцом вокруг точки", { where: "point", frame: true }],
    ["mountains along the edge 30x30", { size: { w: 30, h: 30 }, frame: true }], ["a ring of mountains", { frame: true }],
    ["góry wzdłuż krawędzi 30x30", { size: { w: 30, h: 30 }, frame: true }], ["las ramką", { frame: true }],
  ];
  it.each(AREAS)("«%s»", (phrase, area) => {
    expect(generation(phrase).area).toMatchObject(area);
  });

  it("a size is one token however it is written, and never two numbers of a cell", () => {
    expect(tokenize("лес 20x30").at(-1)).toEqual({ text: "20x30", kind: "size", w: 20, h: 30 });
    for (const size of ["20x30", "20 x 30", "20×30", "20х30", "20*30", "20 Х 30"]) {
      expect(parseArea(`лес ${size}`).size, size).toEqual({ w: 20, h: 30 });
      expect(first(size), size).toBeNull();
    }
  });
  it("says which tokens named the area", () => {
    expect(parseArea("трава по всей карте 20x20").tokens).toEqual([2, 3, 4]);
    expect(generation("лес на севере").tokens).toEqual([0, 2]);
  });
});

describe("the amount of a generation", () => {
  const AMOUNTS: [string, number][] = [
    ["камни", 0],
    ["побольше камней", 1], ["много кустов", 1], ["кусты погуще", 1], ["большое озеро", 1], ["more rocks", 1], ["lots of bushes", 1],
    ["więcej kamieni", 1], ["dużo krzaków", 1],
    ["поменьше камней", -1], ["чуть камней", -1], ["немного кустов", -1], ["маленькое озеро", -1], ["камни пореже", -1],
    ["fewer rocks", -1], ["a little snow in patches", -1], ["mniej kamieni", -1], ["trochę krzaków", -1],
    ["очень много камней", 2], ["гораздо больше кустов", 2], ["огромное озеро", 2], ["much more rocks", 2], ["znacznie więcej kamieni", 2],
    ["очень мало камней", -2], ["намного меньше кустов", -2], ["чуть-чуть камней", -2], ["much less snow in patches", -2], ["bardzo mało kamieni", -2],
    ["чуть больше камней", 1], ["чуть меньше камней", -1],
  ];
  it.each(AMOUNTS)("«%s» → %i", (phrase, step) => {
    expect(generation(phrase).amount).toBe(step);
  });

  it("a word that chose the sibling recipe does not also change the amount", () => {
    expect(generation("редкий лес")).toMatchObject({ recipeId: "forest_scatter", amount: 0 });
    expect(generation("густой лес")).toMatchObject({ recipeId: "forest_clearings", amount: 0 });
    expect(generation("редкий снег")).toMatchObject({ recipeId: "snow_scatter", amount: 0 });
    // …but where it chooses nothing it means less / more
    expect(generation("редкие камни")).toMatchObject({ recipeId: "decor_rocks", amount: -1 });
    expect(generation("густые кусты")).toMatchObject({ recipeId: "decor_bushes", amount: 1 });
    // and «разбросай» is how decorations are made anyway — not «less»
    expect(generation("разбросай камни").amount).toBe(0);
  });
});

describe("tools", () => {
  it("knows every tool of the dock", () => {
    expect([...TOOL_IDS].sort()).toEqual(EDIT_TOOLS.map((t) => t.value).sort());
  });
  const TOOLS: [string, string[]][] = [
    ["select", ["обзор", "select", "wybierz"]],
    ["terrain", ["рельеф", "terrain", "teren"]],
    ["water", ["инструмент вода", "water tool", "narzędzie woda"]],
    ["forest", ["кисть леса", "forest brush", "pędzel las"]],
    ["road", ["рисовать дорогу", "draw road", "rysuj drogę"]],
    ["roadsel", ["выделить дорогу", "дорога ножницы", "select road", "cut road", "zaznacz drogę"]],
    ["erase", ["ластик", "стереть", "eraser", "gumka"]],
    ["decor", ["декор", "decoration", "dekoracja"]],
    ["object", ["объекты", "objects", "obiekty", "город"]],
    ["move", ["двигать", "move", "przesuń"]],
    ["locations", ["локации", "locations", "lokacje"]],
    ["zone", ["зона", "zone", "strefa"]],
    ["fog", ["туман", "туман войны", "fog", "mgła"]],
  ];
  it.each(TOOLS.flatMap(([tool, phrases]) => phrases.map((p): [string, string] => [p, `tool:${tool}`])))("«%s» → %s", (phrase, id) => {
    expect(first(phrase)).toBe(id);
  });
});

describe("menu commands", () => {
  it("knows the commands of the menu", () => {
    expect([...COMMAND_IDS].sort()).toEqual([
      "edit:redo", "edit:undo", "edit:validate",
      "file:export", "file:new", "file:open", "file:passport", "file:upload",
      "help:commands", "help:keys",
      "view:anchors", "view:animate", "view:appearance", "view:eventPanel", "view:fit", "view:grid", "view:locations",
      "view:minimap", "view:objectPanel", "view:objects", "view:roles", "view:terrain",
    ]);
    expect(listActions()).toHaveLength(TOOL_IDS.length + COMMAND_IDS.length);
  });
  const COMMANDS: [string, string[]][] = [
    ["file:open", ["открыть карту", "открой", "open map", "otwórz mapę"]],
    ["file:new", ["новая карта", "создать карту", "new map", "create a map", "nowa mapa"]],
    ["file:upload", ["загрузить", "upload", "wgraj"]],
    ["file:export", ["экспорт", "скачать карту", "export", "download map", "eksport", "pobierz mapę"]],
    ["file:passport", ["паспорт", "паспорт карты", "map passport", "paszport mapy"]],
    ["edit:undo", ["отмена", "отменить", "undo", "cofnij"]],
    ["edit:redo", ["вернуть", "redo", "ponów"]],
    ["edit:validate", ["проверить карту", "проверка", "validate map", "sprawdź mapę"]],
    ["view:terrain", ["слой рельефа", "скрыть рельеф", "terrain layer", "warstwa terenu"]],
    ["view:objects", ["слой объектов", "скрыть объекты", "object layer", "hide objects", "ukryj obiekty"]],
    ["view:grid", ["сетка", "показать сетку", "grid", "siatka"]],
    ["view:locations", ["слой локаций", "показать локации", "show locations", "pokaż lokacje"]],
    ["view:animate", ["анимация", "animation", "animacja"]],
    ["view:objectPanel", ["панель объектов", "object panel", "panel obiektów"]],
    ["view:eventPanel", ["события", "сценарий", "events", "scenario", "zdarzenia", "scenariusz"]],
    ["view:anchors", ["связи", "якоря", "anchors", "links", "kotwice", "powiązania"]],
    ["view:roles", ["роли локаций", "location roles", "role lokacji"]],
    ["view:minimap", ["миникарта", "мини-карта", "minimap", "minimapa"]],
    ["view:fit", ["к размеру окна", "показать всю карту", "fit to window", "dopasuj do okna"]],
    ["view:appearance", ["тёмная тема", "dark theme", "ciemny motyw"]],
    ["help:keys", ["горячие клавиши", "клавиши", "keyboard shortcuts", "hotkeys", "skróty klawiszowe"]],
    ["help:commands", ["справка", "помощь", "команды", "генераторы", "help", "commands", "pomoc", "polecenia"]],
  ];
  it("has phrases for every command", () => {
    expect(COMMANDS.map(([id]) => id).sort()).toEqual([...COMMAND_IDS].sort());
  });
  it.each(COMMANDS.flatMap(([id, phrases]) => phrases.map((p): [string, string] => [p, id])))("«%s» → %s", (phrase, id) => {
    expect(first(phrase)).toBe(id);
  });
});

describe("a cell and a search", () => {
  it.each(["20 30", "20,30", "20;30", "клетка 20 30", "перейти к клетке 20, 30", "go to 20 30", "cell 20 30", "idź do 20 30", "pole 20 30", "x 20 y 30"])(
    "«%s» is the cell 20, 30",
    (phrase) => {
      expect(interpret(phrase)[0]).toMatchObject({ kind: "goto", x: 20, y: 30, match: "exact" });
    },
  );
  it("two numbers next to anything else are not a cell", () => {
    expect(first("озеро 20 30")).toBe("water_lake");
    expect(all("озеро 20 30")).not.toContain("goto");
    expect(all("20 30 40")).not.toContain("goto");
    expect(all("20")).toEqual([]);
    expect(all("20x30")).toEqual([]);
  });

  it("«найти …» searches for the rest of the line, as typed", () => {
    expect(interpret("найти Столица")[0]).toMatchObject({ kind: "find", query: "Столица" });
    expect(interpret("Найди: «Башня Мага»")[0]).toMatchObject({ kind: "find", query: "Башня Мага" });
    expect(interpret("find Old Tower")[0]).toMatchObject({ kind: "find", query: "Old Tower" });
    expect(interpret("znajdź Wieża maga")[0]).toMatchObject({ kind: "find", query: "Wieża maga" });
    expect(interpret("где руины")[0]).toMatchObject({ kind: "find", query: "руины" });
    expect(interpret("найти")[0]).toMatchObject({ kind: "find", query: "" });
  });
  it("only as the first word, and above what the query itself could mean", () => {
    expect(all("найти руины")).toEqual(["find", "decor_ruins"]);
    expect(all("руины найти")).not.toContain("find");
  });
  it("matches a name whatever the case, ё or diacritics", () => {
    expect(textMatches("столица", "Столица Империи")).toBe(true);
    expect(textMatches("ЁЛКА", "зелёная елка")).toBe(true);
    expect(textMatches("wieza", "Wieża maga")).toBe(true);
    expect(textMatches("столица", "Руины")).toBe(false);
    expect(textMatches("столица", undefined)).toBe(false);
    expect(textMatches("  ", "что угодно")).toBe(false);
  });
});

describe("typos and words still being typed", () => {
  it("is one slip away: a wrong, missing, extra or swapped letter", () => {
    expect(editDistance("озеор", "озеро")).toBe(1); // swapped neighbours
    expect(editDistance("лабринт", "лабиринт")).toBe(1);
    expect(editDistance("forrest", "forest")).toBe(1);
    expect(editDistance("лес", "лис")).toBe(1);
    expect(editDistance("озеро", "озеро")).toBe(0);
    expect(editDistance("гора", "река")).toBe(3);
    expect(editDistance("", "лес")).toBe(3);
  });
  const TYPOS: [string, string][] = [
    ["лабринт", "wall_maze"], ["лабииринт", "wall_maze"], ["лаберинт", "wall_maze"], ["озеор", "water_lake"], ["озро", "water_lake"],
    ["forrest", "decor_forest"], ["forets", "decor_forest"], ["montains", "mountain_blob"], ["labyrnith", "wall_maze"], ["jeziroo", "water_lake"],
    ["labiryt", "wall_maze"], ["тумна", "tool:fog"], ["экспрот", "file:export"], ["лабринты 20x20", "wall_maze"],
  ];
  it.each(TYPOS)("«%s» → %s, marked as a typo", (phrase, id) => {
    const i = interpret(phrase)[0];
    expect(idOf(i)).toBe(id);
    expect(i?.match).toBe("typo");
  });
  it("an ending after the stem is no typo: the word only has to begin with it", () => {
    expect(interpret("лабиринтами")[0]).toMatchObject({ recipeId: "wall_maze", match: "exact" });
    expect(interpret("labirynty")[0]).toMatchObject({ recipeId: "wall_maze", match: "exact" });
  });
  it("reads a typo in a modifier or a place too", () => {
    expect(generation("редкйи лес").recipeId).toBe("forest_scatter");
    expect(generation("снег на севрее").area.where).toBe("north");
  });
  it("a word the lexicon knows is not taken for a typo of another", () => {
    expect(all("озеро")).toEqual(["water_lake"]); // not also «озера» — several lakes
    expect(all("остров")).toEqual(["water_islands"]);
  });

  it("the last word may be unfinished", () => {
    expect(interpret("лаби")[0]).toMatchObject({ kind: "generate", recipeId: "wall_maze", match: "partial" });
    expect(interpret("ту")[0]).toMatchObject({ kind: "tool", tool: "fog", match: "partial" });
    expect(interpret("най")[0]).toMatchObject({ kind: "find", match: "partial" });
    expect(generation("снег на сев")).toMatchObject({ recipeId: "snow_overlay", area: { where: "north" } });
    expect(all("оз")).toEqual(["water_isles", "water_lake"]);
    // only the last one, and not a single letter
    expect(all("лаби 20x20")).toEqual([]);
    expect(all("лаби на севере")).toEqual([]);
    expect(all("л")).toEqual([]);
  });
});

describe("ranking", () => {
  it("an exact reading is above a typo reading, whatever the kind", () => {
    const list = interpret("лабринт туман");
    expect(list.map(idOf)).toEqual(["tool:fog", "wall_maze"]);
    expect(list.map((i) => i.match)).toEqual(["exact", "typo"]);
    expect(list[0]!.score).toBeGreaterThan(list[1]!.score);
    // and above a word still being typed
    expect(interpret("сетка лаби").map((i) => i.match)).toEqual(["exact", "partial"]);
  });

  /**
   * THE RULE for a word that names both a generator and an action: the generator first, the
   * action right below it — the bar is a generator first. An action wins when it explains more
   * of the line (a word that marks it: «инструмент», «кисть», «слой», «показать»).
   */
  it("a bare word shared by a generator and a tool is the generator, then the tool", () => {
    expect(all("лес")).toEqual(["decor_forest", "tool:forest"]);
    expect(all("вода")).toEqual(["water_lake", "tool:water"]);
    expect(all("дорога")).toEqual(["road_path", "tool:road"]);
    expect(all("forest")).toEqual(["decor_forest", "tool:forest"]);
    expect(all("las")).toEqual(["decor_forest", "tool:forest"]);
    expect(all("земля")).toEqual(["grass_fill", "tool:terrain"]);
    const [generator, tool] = interpret("лес");
    expect(generator!.score).toBeGreaterThan(tool!.score);
  });
  it("the action wins when it explains more of the line", () => {
    expect(all("инструмент лес")).toEqual(["tool:forest", "decor_forest"]);
    expect(all("forest tool")).toEqual(["tool:forest", "decor_forest"]);
    expect(all("кисть воды").slice(0, 2)).toEqual(["tool:water", "water_lake"]);
    expect(all("слой рельефа")).toEqual(["view:terrain", "tool:terrain"]);
    expect(all("панель объектов")).toEqual(["view:objectPanel", "tool:object"]);
  });
  it("the generator wins when the line names a place or an amount", () => {
    expect(all("лес на севере")).toEqual(["decor_forest", "tool:forest"]);
    expect(all("побольше воды")[0]).toBe("water_lake");
  });

  it("of sibling recipes, the one whose modifier was said comes first, the plain one stays below", () => {
    expect(all("редкий снег")).toEqual(["snow_scatter", "snow_patches", "snow_overlay"]);
    expect(all("снег пятнами")).toEqual(["snow_patches", "snow_overlay"]);
    expect(all("сплошной лес")).toEqual(["forest_fill", "decor_forest", "tool:forest"]);
    expect(all("горная гряда")).toEqual(["relief_ridge", "mountain_blob"]);
    expect(all("горы по краю")).toEqual(["mountain_fill", "mountain_blob"]);
  });
  it("two things named with equal weight keep the old router's order", () => {
    expect(all("кусты у воды").slice(0, 2)).toEqual(["decor_bushes", "water_lake"]); // decorations before water
    expect(all("снег на горах").slice(0, 2)).toEqual(["mountain_blob", "snow_overlay"]);
  });
  it("is sorted by score, each reading once", () => {
    for (const phrase of ["редкий лес на севере 20x20", "выделить дорогу", "показать всю карту", "найти лес", "густой лес с полянами"]) {
      const list = interpret(phrase);
      expect(list.map((i) => i.score), phrase).toEqual([...list.map((i) => i.score)].sort((a, b) => b - a));
      expect(new Set(list.map(idOf)).size, phrase).toBe(list.length);
    }
  });
});

describe("the newer recipes", () => {
  it("a maze has three looks: fortress walls, thin walls, a palisade", () => {
    expect(all("лабиринт")).toEqual(["wall_maze"]);
    expect(all("тонкий лабиринт")).toEqual(["wall_maze_thin", "wall_maze"]);
    expect(first("лабиринт с тонкими стенами")).toBe("wall_maze_thin");
    expect(first("узкий лабиринт 30x30")).toBe("wall_maze_thin");
    expect(all("лабиринт из частокола")).toEqual(["wall_maze_fence", "wall_maze"]);
    expect(all("частокол")).toEqual(["wall_maze_fence", "wall_maze"]);
    expect(first("забор по краю")).toBe("wall_maze_fence");
    expect(first("стена")).toBe("wall_maze");
  });
  it("«тонкий» on its own offers the thin maze", () => {
    expect(nearest("тонкий").map(idOf)).toEqual(["wall_maze_thin"]);
  });
});

describe("a recipe the server's catalogue lacks", () => {
  const without = (...gone: string[]): string[] => RECIPE_IDS.filter((id) => !gone.includes(id));

  it("is never offered; the next sibling that fits takes over", () => {
    expect(all("редкий снег")[0]).toBe("snow_scatter");
    const list = interpret("редкий снег", { recipes: without("snow_scatter") });
    expect(list.map(idOf)).toEqual(["snow_patches", "snow_overlay"]);
    expect(interpret("сплошной лес", { recipes: without("forest_fill") }).map(idOf)).toEqual(["decor_forest", "tool:forest"]);
    expect(interpret("острова", { recipes: without("water_islands") })).toEqual([]);
  });
  it("leaves the actions alone", () => {
    expect(interpret("лес", { recipes: [] }).map(idOf)).toEqual(["tool:forest"]);
    expect(interpret("сетка", { recipes: [] }).map(idOf)).toEqual(["view:grid"]);
    expect(interpret("20 30", { recipes: [] }).map(idOf)).toEqual(["goto"]);
  });
  it("a catalogue with recipes the lexicon has no words for changes nothing", () => {
    expect(interpret("озеро", { recipes: [...RECIPE_IDS, "lava_pool"] })).toEqual(interpret("озеро"));
  });
  it("is not among the nearest things either", () => {
    expect(nearest("сенг").map(idOf)).toContain("snow_scatter");
    expect(nearest("сенг", { recipes: without("snow_scatter") }).map(idOf)).not.toContain("snow_scatter");
  });
});

describe("a line that is not understood", () => {
  it.each(["", "   ", "!!!", "абракадабра", "qwerty", "хочу чего-нибудь", "zrób coś", "please do it", "42", "на севере", "побольше"])("«%s» has no reading", (phrase) => {
    expect(interpret(phrase)).toEqual([]);
  });

  it("a word that is close to a known one — two slips, or a slip in a short word — offers that thing", () => {
    expect(nearest("сенг").map(idOf).slice(0, 3)).toEqual(["snow_overlay", "snow_scatter", "snow_patches"]); // «снег», the plain one first
    expect(nearest("лис").map(idOf).slice(0, 2)).toEqual(["decor_forest", "tool:forest"]);
    expect(interpret("лабериннт")).toEqual([]); // two slips: not a typo any more
    expect(nearest("лабериннт").map(idOf)).toEqual(["wall_maze", "wall_maze_thin"]); // the plain maze, then its sibling
    expect(nearest("fgo").map(idOf)).toEqual(["tool:fog"]);
    expect(nearest("grdi").map(idOf)).toEqual(["view:grid"]);
    for (const i of nearest("сенг")) {
      expect(i.match).toBe("near");
      expect(i.score).toBeLessThan(0.57); // below any reading interpret() gives (a typo of an action)
    }
  });
  it("…with the place, the amount and the modifier the line did say", () => {
    expect(nearest("сенг на севере")[0]).toMatchObject({ kind: "generate", recipeId: "snow_overlay", area: { where: "north" } });
    expect(nearest("побольше кмани")[0]).toMatchObject({ kind: "generate", recipeId: "decor_rocks", amount: 1 });
    // «редкий» said along with it puts the sparse sibling first, and is not also «less» of it
    expect(nearest("редкий сенг").map(idOf)).toEqual(["snow_scatter", "snow_patches", "snow_overlay"]);
    expect(nearest("редкий сенг")[0]).toMatchObject({ amount: 0, tokens: [0, 1] });
  });

  it("a line that only says how offers what goes with that word", () => {
    expect(nearest("редкий").map(idOf).slice(0, 4)).toEqual(["relief_hills", "snow_scatter", "snow_patches", "forest_scatter"]);
    expect(nearest("sparse").map(idOf).slice(0, 4)).toEqual(["relief_hills", "snow_scatter", "snow_patches", "forest_scatter"]);
    expect(nearest("густой").map(idOf)[0]).toBe("forest_clearings");
    expect(nearest("сплошной").map(idOf)).toEqual(["mountain_fill", "snow_overlay", "forest_fill", "grass_fill"]);
    expect(nearest("несколько").map(idOf)).toEqual(["water_isles"]);
    expect(nearest("по краю").map(idOf).slice(0, 2)).toEqual(["mountain_fill", "forest_fill"]);
    expect(nearest("инструмент").every((i) => i.kind === "tool")).toBe(true);
    expect(nearest("слой").map(idOf)).toEqual(["view:terrain", "view:objects", "view:locations"]);
    expect(nearest("панель").map(idOf)).toEqual(["view:objectPanel", "view:eventPanel"]);
    expect(nearest("карта").map(idOf)).toEqual(["file:open", "file:new", "file:upload", "file:export", "file:passport", "edit:validate"]);
    for (const i of nearest("редкий")) expect(i.match).toBe("open");
    // the word being typed counts already
    expect(nearest("ред").map(idOf).slice(0, 4)).toEqual(["relief_hills", "snow_scatter", "snow_patches", "forest_scatter"]);
  });
  it("a line that only says where or how much offers the plain things, there / that much", () => {
    const north = nearest("на севере");
    expect(north.map(idOf)).toEqual(["water_lake", "decor_forest", "mountain_blob", "relief_hills", "snow_overlay", "decor_rocks"]);
    for (const i of north) expect(i).toMatchObject({ kind: "generate", match: "open", area: { where: "north" }, amount: 0 });
    expect(nearest("in the north").map(idOf)).toEqual(north.map(idOf));
    expect(nearest("na północy").map(idOf)).toEqual(north.map(idOf));
    expect(nearest("20x30")[0]).toMatchObject({ recipeId: "water_lake", area: { size: { w: 20, h: 30 } } });
    expect(nearest("побольше")[0]).toMatchObject({ recipeId: "water_lake", amount: 1 });
    expect(nearest("добавь побольше на юге")[0]).toMatchObject({ recipeId: "water_lake", amount: 1, area: { where: "south" } });
    // the words of the place are spoken for: «по всей карте» is not the «карта» of the File menu
    expect(nearest("по всей карте").map(idOf)).toEqual(north.map(idOf));
    expect(nearest("по всей карте")[0]).toMatchObject({ area: { where: "map" } });
  });
  it("offers only what the catalogue has", () => {
    expect(nearest("на севере", { recipes: ["decor_forest", "river"] }).map(idOf)).toEqual(["decor_forest"]);
    expect(nearest("редкий", { recipes: ["snow_patches"] }).map(idOf)).toEqual(["snow_patches"]);
  });

  it("is empty when there is nothing to go on, and never longer than asked", () => {
    expect(nearest("абракадабра")).toEqual([]);
    expect(nearest("")).toEqual([]);
    expect(nearest("42")).toEqual([]);
    expect(nearest("редкий абракадабра")).toEqual([]); // a word nothing is close to: no guessing around it
    expect(nearest("лис", {}, 2)).toHaveLength(2);
    expect(nearest("редкий").length).toBeLessThanOrEqual(6);
  });
  it("has nothing to add to a line that is understood", () => {
    expect(nearest("озеро")).toEqual([]);
    expect(nearest("туман")).toEqual([]);
  });
});

describe("the bar's examples read the same in every interface language", () => {
  /** The examples of CopilotBar.vue (without the LLM compositions): the Russian key, and the
   *  translations the dictionaries had when this was written. */
  const EXAMPLES: [string, string, string][] = [
    ["озеро", "lake", "jezioro"],
    ["озеро в центре", "lake in the center", "jezioro na środku"],
    ["озеро вокруг этой точки 20x20", "lake around this point 20x20", "jezioro wokół tego punktu 20x20"],
    ["пруд 10x10", "pond 10x10", "staw 10x10"],
    ["несколько озёр", "several lakes", "kilka jezior"],
    ["острова 30x30", "islands 30x30", "wyspy 30x30"],
    ["река", "river", "rzeka"],
    ["река по всей карте", "river across the whole map", "rzeka przez całą mapę"],
    ["лес", "forest", "las"],
    ["густой лес", "dense forest", "gęsty las"],
    ["лес с полянами", "forest with glades", "las z polanami"],
    ["редкий лес", "sparse forest", "rzadki las"],
    ["сплошной лес", "solid forest", "lity las"],
    ["роща вокруг этой точки 16x16", "grove around this point 16x16", "zagajnik wokół tego punktu 16x16"],
    ["рощи по всей карте", "groves across the whole map", "zagajniki na całej mapie"],
    ["горы 20x20", "mountains 20x20", "góry 20x20"],
    ["горная гряда", "mountain ridge", "pasmo górskie"],
    ["разбросай холмы", "scatter hills", "rozrzuć wzgórza"],
    ["горы по краю 30x30", "mountains along the edge 30x30", "góry wzdłuż krawędzi 30x30"],
    ["горы вокруг этой точки 18x18", "mountains around this point 18x18", "góry wokół tego punktu 18x18"],
    ["лабиринт", "maze", "labirynt"],
    ["лабиринт 28x28", "maze 28x28", "labirynt 28x28"],
    ["тонкий лабиринт", "thin maze", "cienki labirynt"],
    ["лабиринт из частокола", "palisade maze", "labirynt z palisady"],
    ["снег на севере", "snow in the north", "śnieg na północy"],
    ["снег пятнами", "patchy snow", "śnieg płatami"],
    ["редкий снег", "sparse snow", "rzadki śnieg"],
    ["трава 20x20", "grass 20x20", "trawa 20x20"],
    ["трава по всей карте", "grass over the whole map", "trawa na całej mapie"],
    ["извилистая дорога", "winding road", "kręta droga"],
    ["разбросай камни", "scatter rocks", "rozrzuć kamienie"],
    ["побольше кустов", "more bushes", "więcej krzaków"],
    ["руины", "ruins", "ruiny"],
    ["кладбище 16x16", "graveyard 16x16", "cmentarz 16x16"],
    ["дорога", "road", "droga"],
    ["камни", "rocks", "kamienie"],
    ["кусты", "bushes", "krzaki"],
    ["туман", "fog", "mgła"],
    ["ластик", "eraser", "gumka"],
    ["сетка", "grid", "siatka"],
    ["слой объектов", "object layer", "warstwa obiektów"],
    ["отменить", "undo", "cofnij"],
    ["экспорт", "export", "eksport"],
    ["клетка 20 30", "cell 20 30", "pole 20 30"],
    ["найти столица", "find capital", "znajdź stolica"],
  ];
  /** What a line comes to, apart from its own words: the thing, the place, the amount. */
  const reading = (text: string): unknown => {
    const i = interpret(text)[0];
    if (!i) return null;
    if (i.kind === "generate") return { id: i.recipeId, where: i.area.where, size: i.area.size, frame: i.area.frame, amount: i.amount, match: i.match };
    if (i.kind === "goto") return { id: "goto", x: i.x, y: i.y };
    return { id: idOf(i), match: i.match };
  };

  it.each(EXAMPLES)("«%s» = “%s” = „%s”", (ru, english, polish) => {
    expect(reading(ru)).not.toBeNull();
    expect(reading(english)).toEqual(reading(ru));
    expect(reading(polish)).toEqual(reading(ru));
  });
  // an example is a COMMAND: a translator who rewords one in a dictionary must keep it one
  it("the dictionaries' own translations of them do too", () => {
    for (const [ru] of EXAMPLES) {
      for (const [lang, dictionary] of [["en", en], ["pl", pl]] as const) {
        const translated = (dictionary as Record<string, string>)[ru];
        if (translated !== undefined) expect(reading(translated), `${lang}: «${ru}» → “${translated}”`).toEqual(reading(ru));
      }
    }
  });
});
