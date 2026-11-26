/**
 * The command bar's interpreter: what a typed line can mean, best reading first.
 *
 * Pure — no Vue, no stores, no DOM — and table-driven:
 *   LEXICON  word stems for every notion the bar knows, in Russian, English and Polish
 *            (all three are always understood, whatever the interface language);
 *   RECIPES / TOOLS / COMMANDS  rules: which notions together make which intent.
 * `interpret()` reads a line into ranked interpretations; the bar shows them as suggestions and
 * runs the first on Enter. For a line it makes nothing of, `nearest()` has offers — the things
 * closest to a misspelt word, or the things that go with a line that only says how / where /
 * how much — so the bar is never a dead end. The bar resolves a generation's AREA against the
 * map itself — here it is only data («around the cursor, 20×20», «the northern half», «a band
 * along the edge»).
 *
 * How a word matches a stem — never `\b` (it does not see Cyrillic), always whole tokens:
 *   exact    the token starts with the stem (a stem of 1–2 letters, or one written `=word`,
 *            must be the whole token: «гора» must not swallow «гораздо»);
 *   partial  the LAST token is the beginning of a stem — the word is still being typed;
 *   typo     the token is one slip (a wrong, missing, extra or swapped letter) away from a
 *            stem of 5+ letters.
 * A token the lexicon knows exactly is never also read as a partial or a typo of another word.
 *
 * RANKING. An interpretation scores `base × quality + 0.10 per further word its rule used
 * + 0.05 per area / amount word`, where quality is 1 (exact), 0.8 (partial) or 0.6 (typo)
 * and base is 1.3 for «найти …», 1.2 for a cell, 1 for a generator, 0.95 for a tool or a
 * menu command. So: an exact reading is always above a typo reading; the reading that
 * explains more of the line wins («инструмент лес» is the tool, «лес на севере» the
 * generator); and when a bare word names both a generator and an action («лес», «вода»,
 * «дорога») the generator comes first — the bar is a generator first — with the action right
 * below it. Equal scores keep the order of the tables, which for the recipes is the order
 * the old keyword router checked them in (decorations before water, so «кусты у воды» is bushes).
 */

// ----- text → tokens ---------------------------------------------------------------------

/** Lower case, `ё→е`, Latin letters without diacritics («północ» = «polnoc»). */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/ł/g, "l")
    .replace(/[\u00c0-\u024f]/g, (c) => c.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
}

export interface Token {
  /** The normalised text («20x30» for a size). */
  text: string;
  kind: "word" | "number" | "size";
  /** A size's two numbers. */
  w?: number;
  h?: number;
}

// a size («20x30», «20 × 30», «20х30» with the Cyrillic letter, «20*30») or a run of letters/digits
const TOKEN = /(\d{1,3})\s*[x×х*]\s*(\d{1,3})(?![\p{L}\p{N}])|[\p{L}\p{N}]+/gu;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of normalize(text).matchAll(TOKEN)) {
    if (m[1] !== undefined && m[2] !== undefined) out.push({ text: `${m[1]}x${m[2]}`, kind: "size", w: Number(m[1]), h: Number(m[2]) });
    else out.push({ text: m[0], kind: /^\d+$/.test(m[0]) ? "number" : "word" });
  }
  return out;
}

/** Does `text` contain `query`? Case, `ё` and Latin diacritics do not matter. */
export function textMatches(query: string, text: string | undefined | null): boolean {
  const q = normalize(query).trim();
  return !!q && !!text && normalize(text).includes(q);
}

/** Damerau–Levenshtein distance: a wrong, missing, extra or swapped-with-its-neighbour
 *  letter is one edit. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2]! + 1);
      cur.push(d);
    }
    before = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

// ----- the lexicon -----------------------------------------------------------------------

/**
 * Stems by notion; Russian, English, Polish in one list (write them naturally — they are
 * normalised on load). `=word` matches that whole word only: used where a stem would take
 * in unrelated words («=гора» vs «гораздо», «=las» vs «laser») and for the forms of short words.
 */
const LEXICON = {
  // what to generate
  maze: "лабиринт стен  maze labyrinth wall  labirynt =mur =mury =murem =murami ścian",
  fence: "забор частокол оград изгород  fence palisad stockade  częstokoł ogrodzeni",
  hill: "холм пригорк бугор бугр  hill knoll  wzgórz pagórk",
  ridge: "гряд хребет хребт  ridge range  grzbiet pasm łańcuch",
  mountain:
    "=гор =гора =горы =горе =гору =горой =горою =горам =горами =горах горн скал утес массив  mountain =mount cliff crag peak massif  =góra =góry =gór =górę =górą =górom =górami =górach górsk górzyst skał masyw szczyt",
  road: "дорог троп =путь =пути =путем перекрест просел тракт  road path trail track  drog drodz ścieżk szlak trakt",
  rocks: "камн =камень валун булыжник  rock stone boulder pebble  kamie głaz",
  bushes: "куст поросл  bush shrub undergrowth  krzak krzew zarośl",
  ruins: "руин развалин  ruin rubble  gruz",
  graves: "могил кладбищ =кость =кости =костей костям костях череп надгроб погост  grave cemetery tomb bone skull headstone  grob cmentarz kości czaszk nagrob",
  snow: "снег снеж зим сугроб  snow winter wintr  śnieg śnież zim",
  river: "=река =реки =реку =реке =рекой =рекою =рек речк речн руче ручь русл  river stream creek brook  rzek rzece strumie strumy potok",
  island: "=остров =острова =острове =острову =островом =островов =островам =островами =островах архипелаг  island isle archipelag  wysp",
  /** Lakes in the plural — «Несколько озёр». */
  lakes: "озера =озер =пруды =прудов прудам прудах  lakes ponds  =jeziora =jezior jeziorami jeziorach =stawy =stawów stawami",
  water: "вод озер озеро =море =моря =морю =морем =морей пруд болот топь водоем  lake pond water =sea =seas swamp marsh  jezior staw wod morz bagn mokradł",
  /** «залей» on its own means water; next to another thing it means «fill solid with it». */
  flood: "залей залить залью затоп  flood  zalej zalać zatop",
  thicket: "чащ дебр  thicket  gęstwin puszcz",
  glade: "полян прогалин просек  clearing glade  polan przesiek",
  forest:
    "лес =дерево =дерева =деревья =деревьев =деревьям =деревьями =деревьях деревц рощ =бор =бора =бору =бором =боры ельник дубрав тайг  forest wood tree grove copse  =las =lasu =lasy =lasem =lesie =lasów =lasami =lasach lasek leśn lesist drzew =gaj =gaje =gaju =gajem zagajnik =bór =boru =bory",
  grass: "трав земл очист расчист равнин плато луг газон  grass meadow =clear lawn plain  traw =łąka =łąki =łąką równin wyczyść oczyść muraw",

  // which of the sibling recipes
  sparse: "редк реже пореже местами =кое коегде отдельн припорош  sparse =rare =thin  rzadk rzadziej gdzieniegdzie miejscami pojedyncz",
  scatter: "разброс раскид рассып  scatter sprinkle  rozrzuc rozsyp porozrzuc",
  patchy: "пятн клоч островк местечк  patch blotch clump  plam płatami =płaty =płatów kępami =kępy =kępa łatami",
  dense: "густ гуще погуще плотн  dense thick  gęst gęściej",
  thin: "тонк узк  =thin thinner narrow fine  cienk wąsk",
  solid: "сплошн заполн целиком  solid fill  wypełni =lity =lita =lite =litego =litym =litą",
  several: "несколько =пара =пару  several multiple =few  kilka kilku =parę",

  // where
  around: "вокруг около возле здесь тут точк =месте курсор  around here near cursor point  wokół tutaj =tu kursor punkt obok",
  whole: "=вся =всю =всей =весь =все =целая =целой =целую  whole entire =all  =cała =całą =całej =cały =całe",
  mapWord: "карт  map",
  everywhere: "везде повсюду всюду  everywhere  wszędzie",
  center: "центр середин  centr middle  środk środek",
  north: "север сверху вверх наверх верхн  north =top upper  północ",
  south: "=юг =юга =юге =югу =югом южн снизу вниз нижн  south bottom lower  południ =dół =dole =dołu doln",
  west: "запад слев влев налев =левая =левой =левую =левый =левом =левее  west left  zachod =lewo =lewa =lewej =lewy =lewą",
  east: "восто справ вправ направ =правая =правой =правую =правый =правом =правее  east right  wschod =prawo =prawa =prawej =prawy =prawą",
  frame: "=край =краю =края =краям =краях =краев =краем кромк окраин перимет рамк кольц контур кайм  edge border perimeter frame =ring =rim outline  krawędz brzeg obwod ramk pierście obrzeż",

  // how much
  more: "больш побольше много обильн крупн  more lots many big large  więcej dużo sporo =duży =duża =duże większ",
  less: "меньш поменьше =мало маленьк небольш мелк  less fewer small tiny  mniej =mało =mały =mała =małe mniejsz niewielk",
  slightly: "чуть немного слегка чуточку  slightly =bit little  trochę nieco odrobin",
  very: "очень гораздо намного сильно значительно совсем  much very =far  bardzo znacznie",
  most: "максим огромн гигант  =max maxim huge giant enormous  ogromn maksym",
  least: "миним крошечн  =min minim  malutk",

  // tools (the nouns are the dock's own names; the first list marks «I mean the tool»)
  toolWord: "инструмент кист рисова рисуй нарису  tool brush draw paint  narzędzi pędz rysuj maluj",
  toolSelect: "обзор осмотр выдел выбор выбра указател  select pointer inspect  wybierz wybór zaznacz przegląd wskaźnik",
  toolTerrain: "рельеф террейн земл  terrain ground  teren ziemi",
  toolWater: "вод  water  wod",
  toolForest: "лес  forest  =las =lasu =lasy =lasem leśn",
  toolRoad: "дорог  road  drog",
  roadCut: "ножниц резать режь разрез вырез  scissor cut  wytnij nożyc tnij",
  toolErase: "ластик стер стира сотри удал  eras delete remove rubber  gumk wymaż usuń skasuj kasuj",
  toolDecor: "декор украшен  decor ornament  dekorac ozdob",
  toolObject: "объект город деревн сундук отряд торгов  object city town village chest  obiekt miast skrzyni oddział",
  toolMove: "двига двинь перемест перенес перенос перетащ  move drag  przesuń przenieś przesuw",
  toolLocations: "локаци  location  lokac",
  toolZone: "зон территор  zone territory  stref terytor",
  toolFog: "туман  fog  mgł",

  // menu commands
  open: "открыть открой откро  open  otwórz",
  create: "созда  create  utwórz stwórz",
  fresh: "=новая =новую =новый =новой  new  =nowa =nowy =nową =nowe =nowej",
  upload: "загруз импорт  upload import  wgraj załaduj prześlij",
  export: "экспорт выгруз скача сохран  export download save  eksport pobierz zapisz",
  passport: "паспорт  passport  paszport",
  undo: "отмен откат  undo  cofn",
  redo: "вернуть верни повтор  redo  ponów przywróć",
  validate: "провер валидац  validat check verify  sprawdź walidac",
  layer: "слой слоя слои  layer  warstw",
  toggle: "показ покаж скрыть скрой спрят включ выключ переключ =вкл =выкл  show hide toggle  pokaż ukryj włącz wyłącz przełącz",
  grid: "сетк  grid  siatk",
  animation: "анимац  animat  animac",
  panel: "панел  panel",
  events: "событ сценари  event scenario  zdarze scenariusz",
  anchors: "связ якор  anchor link  kotwic powiąza",
  roles: "=роли =роль =ролей =ролям  role  =rol =rola =rolę",
  minimap: "миникарт  minimap",
  mini: "=мини  =mini",
  fit: "впис вмест уместить  =fit  dopasuj",
  windowWord: "окн  window  okn",
  theme: "=тема =тему =темы темн оформлен  theme dark  motyw ciemn",
  keys: "клавиш хотке шорткат  shortcut hotkey =key =keys  skrót klawisz",
  // the bar's own help: what it understands, every generator with a picture
  help: "справк помощ хелп подсказк =команды =команд генератор  help commands generators  pomoc polecenia poleceń generatory",

  // the two commands that carry data
  findVerb: "найти найди поиск искать ищи отыщи =где  find search locate where  znajdź szukaj wyszukaj gdzie",
  gotoWord: "клетк перейти перейди иди идти прыг  go goto jump cell tile  idź przejdź skocz pole =pola komórk  =к =в =на =to =do =na =x =y =х =у",
} as const;

type Notion = keyof typeof LEXICON;

interface Stem {
  s: string;
  /** The whole token must be this word. */
  whole: boolean;
}

const NOTIONS = Object.keys(LEXICON) as Notion[];
const STEMS = {} as Record<Notion, Stem[]>;
for (const id of NOTIONS) {
  STEMS[id] = normalize(LEXICON[id])
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.startsWith("=") ? { s: w.slice(1), whole: true } : { s: w, whole: w.length < 3 }));
}
// «залей горами», «залей лесом»: the flood words also ask for the solid sibling
STEMS.solid.push(...STEMS.flood);

const EXACT = 1;
const PARTIAL = 0.8;
const TYPO = 0.6;

function matchesExactly(token: string, stem: Stem): boolean {
  return stem.whole ? token === stem.s : token.startsWith(stem.s);
}

/** A token the lexicon does not know exactly: the beginning of a stem (only the token being
 *  typed — the last one), or one slip away from a stem of 5+ letters. 0 = neither. */
function matchesLoosely(token: string, stem: Stem, last: boolean): number {
  const s = stem.s;
  if (last && token.length >= 2 && s.length > token.length && s.startsWith(token)) return PARTIAL;
  if (stem.whole || s.length < 5) return 0;
  // the slip may be a missing or an extra letter, so the token's beginning is taken a letter
  // shorter and a letter longer than the stem as well
  for (const n of [s.length, s.length - 1, s.length + 1]) {
    if (token.length >= s.length - 1 && editDistance(token.slice(0, n), s) <= 1) return TYPO;
  }
  return 0;
}

/** A token that stands for a notion, and how surely (EXACT / PARTIAL / TYPO). */
interface Hit {
  i: number;
  q: number;
}
type Hits = Record<Notion, Hit[]>;

function scan(tokens: readonly Token[]): Hits {
  const hits = {} as Hits;
  for (const id of NOTIONS) hits[id] = [];
  tokens.forEach((tok, i) => {
    if (tok.kind !== "word") return;
    let known = false;
    for (const id of NOTIONS) {
      if (STEMS[id].some((st) => matchesExactly(tok.text, st))) {
        hits[id].push({ i, q: EXACT });
        known = true;
      }
    }
    if (known) return;
    const last = i === tokens.length - 1;
    for (const id of NOTIONS) {
      let q = 0;
      for (const st of STEMS[id]) q = Math.max(q, matchesLoosely(tok.text, st, last));
      if (q) hits[id].push({ i, q });
    }
  });
  return hits;
}

// ----- where and how much ----------------------------------------------------------------

export type Side = "north" | "south" | "west" | "east";
/** «тут / вокруг курсора» · the whole map · its centre · a half of it. */
export type Where = "point" | "map" | "center" | Side;

/** The area a generation command names. The bar resolves it against the map and its own
 *  area mode (👁 / ⛶ / 📍); `where: null` leaves the place to that mode. */
export interface ParsedArea {
  where: Where | null;
  /** «20x30»: the size of the patch (around the point, or centred on the map). */
  size: { w: number; h: number } | null;
  /** «по краю / рамкой / кольцом»: only the perimeter band of the area. */
  frame: boolean;
  /** The tokens that said so. */
  tokens: number[];
}

/** No area named: the bar's current area mode decides. */
export const NO_AREA: ParsedArea = { where: null, size: null, frame: false, tokens: [] };

const SIDES: readonly Side[] = ["north", "south", "west", "east"];

/** `skip`: a token that is the thing to generate, so it cannot also be the place. */
function areaOf(tokens: readonly Token[], hits: Hits, skip = -1): ParsedArea {
  const first = (id: Notion): number => hits[id].find((h) => h.i !== skip)?.i ?? -1;
  const used: number[] = [];
  let where: Where | null = null;
  const point = first("around"), everywhere = first("everywhere"), whole = first("whole"), map = first("mapWord"), center = first("center");
  if (point >= 0) {
    where = "point";
    used.push(point);
  } else if (everywhere >= 0) {
    where = "map";
    used.push(everywhere);
  } else if (whole >= 0 && map >= 0) {
    where = "map";
    used.push(whole, map);
  } else if (center >= 0) {
    where = "center";
    used.push(center);
  } else {
    for (const side of SIDES) {
      const i = first(side);
      if (i < 0) continue;
      where = side;
      used.push(i);
      break;
    }
  }
  const sizeAt = tokens.findIndex((t) => t.kind === "size");
  const sizeTok = tokens[sizeAt];
  const size = sizeTok ? { w: sizeTok.w ?? 0, h: sizeTok.h ?? 0 } : null;
  if (sizeAt >= 0) used.push(sizeAt);
  const frame = first("frame");
  if (frame >= 0) used.push(frame);
  return { where, size, frame: frame >= 0, tokens: [...new Set(used)].sort((a, b) => a - b) };
}

/** The area a line names, whatever else it says (the bar's LLM mode and its examples use it). */
export function parseArea(text: string): ParsedArea {
  const tokens = tokenize(text);
  return areaOf(tokens, scan(tokens));
}

/** How much to make, as steps from the stock amount: −2 much less · −1 less · 0 as is ·
 *  +1 more · +2 much more. The bar maps them onto the generator's five amounts. */
export type AmountStep = -2 | -1 | 0 | 1 | 2;

/**
 * The amount a line asks for. `taken` are the tokens the recipe's rule already used: a word
 * that chose the sibling recipe («редкий» → «Редкий лес», «густой» → «Густой лес с полянами»)
 * does not also change the amount; where it chose nothing («редкие камни») it means less / more.
 */
function amountOf(hits: Hits, taken: ReadonlySet<number>): { step: AmountStep; tokens: number[] } {
  const free = (...ids: Notion[]): number[] => ids.flatMap((id) => hits[id].filter((h) => !taken.has(h.i)).map((h) => h.i));
  const more = free("more", "dense"), less = free("less", "sparse");
  const slightly = free("slightly"), very = free("very"), most = free("most"), least = free("least");
  const is = (step: AmountStep, ...said: number[][]): { step: AmountStep; tokens: number[] } => ({ step, tokens: [...new Set(said.flat())] });
  if (most.length && !least.length) return is(2, most);
  if (least.length && !most.length) return is(-2, least);
  if (more.length && !less.length) return is(very.length ? 2 : 1, more, very, slightly);
  if (less.length && !more.length) return is(very.length ? -2 : -1, less, very, slightly);
  // «чуть», «немного» with nothing to compare: a little of it; «чуть-чуть», «совсем чуть»: very little
  if (!more.length && !less.length && slightly.length) return is(slightly.length > 1 || very.length ? -2 : -1, slightly, very);
  return is(0);
}

// ----- the rules -------------------------------------------------------------------------

/** One notion, or any of several. */
type Need = Notion | readonly Notion[];
interface Rule {
  /** All of these must be said; the first is the thing itself. */
  need: readonly Need[];
  /** Said along with it, these belong to the same reading. */
  also?: readonly Need[];
}

const SPARSE = ["sparse", "scatter"] as const;
const SOLID = ["solid", "frame"] as const;

/**
 * The generator recipes, in the order the old keyword router checked them (it breaks ties).
 * Several rules may give one recipe; siblings differ by the modifier they need. A recipe the
 * server's catalogue does not have is skipped, and the next rule that fits takes over — the
 * catalogue changes (a sparse-snow and a forest-with-glades recipe have come and gone, two
 * more mazes have come), so the rules below also say what stands in for a recipe that is gone.
 */
const RECIPES: readonly (Rule & { id: string })[] = [
  { id: "wall_maze_fence", need: ["fence"], also: ["maze"] }, // «частокол», «лабиринт из частокола»
  { id: "wall_maze_thin", need: ["maze", "ruins"] }, // «лабиринт из руин», «руины лабиринта»
  { id: "wall_maze_thin", need: ["maze", "thin"] }, // «тонкий лабиринт», «тонкие стены»: the old name of it
  { id: "wall_maze", need: [["maze", "fence"]] }, // …and the one maze there used to be
  { id: "relief_hills", need: ["hill"], also: [SPARSE] },
  { id: "relief_hills", need: ["mountain", SPARSE] }, // «редкие горы», «разбросай скалы»
  { id: "relief_ridge", need: ["ridge"], also: ["mountain"] }, // «горная гряда», «гряда гор»
  // «по краю / рамкой» and «сплошные / залей» want the solid fill — a frame band must be a
  // wall; bare mountains get the organic massif
  { id: "mountain_fill", need: ["mountain", SOLID] },
  { id: "mountain_blob", need: ["mountain"] },
  { id: "road_path", need: ["road"] },
  { id: "decor_rocks", need: ["rocks"], also: ["scatter"] },
  { id: "decor_bushes", need: ["bushes"], also: ["scatter"] },
  { id: "decor_ruins", need: ["ruins"], also: ["scatter"] },
  { id: "decor_graves", need: ["graves"], also: ["scatter"] },
  { id: "snow_scatter", need: ["snow", SPARSE] },
  { id: "snow_patches", need: ["snow", "patchy"] },
  { id: "snow_patches", need: ["snow", SPARSE] }, // the nearest thing where «Редкий снег» is gone
  { id: "snow_overlay", need: ["snow"], also: ["solid"] },
  { id: "river", need: ["river"] },
  { id: "water_islands", need: ["island"], also: ["water"] }, // land in water: «острова в море»
  { id: "water_isles", need: ["lakes"], also: ["several"] },
  { id: "water_isles", need: ["water", "several"] },
  { id: "water_lake", need: ["water"], also: ["flood"] },
  { id: "water_lake", need: ["flood"] },
  { id: "forest_clearings", need: [["thicket", "glade"]], also: ["forest", "dense"] },
  { id: "forest_clearings", need: ["forest", "dense"] },
  { id: "forest_fill", need: ["forest", SOLID] },
  // without «Густой лес с полянами»: a thicket is the solid forest, glades are the groves
  { id: "forest_fill", need: ["thicket"], also: ["forest", "dense"] },
  { id: "forest_fill", need: ["forest", "dense"] },
  { id: "forest_scatter", need: ["forest", SPARSE] },
  { id: "decor_forest", need: ["forest"], also: ["glade"] },
  { id: "decor_forest", need: ["glade"] },
  { id: "grass_fill", need: ["grass"], also: ["solid"] },
];

/** Every recipe the bar can ask for by words. */
export const RECIPE_IDS: readonly string[] = [...new Set(RECIPES.map((r) => r.id))];

/** The dock's tools (the ids of EDIT_TOOLS). */
export type ToolId =
  | "select" | "terrain" | "water" | "forest" | "road" | "roadsel" | "erase"
  | "decor" | "object" | "move" | "locations" | "zone" | "fog";

const TOOLS: readonly (Rule & { id: ToolId })[] = [
  { id: "select", need: ["toolSelect"], also: ["toolWord"] },
  { id: "terrain", need: ["toolTerrain"], also: ["toolWord"] },
  { id: "water", need: ["toolWater"], also: ["toolWord"] },
  { id: "forest", need: ["toolForest"], also: ["toolWord"] },
  { id: "roadsel", need: ["toolRoad", ["roadCut", "toolSelect"]], also: ["toolWord"] },
  { id: "road", need: ["toolRoad"], also: ["toolWord"] },
  { id: "erase", need: ["toolErase"], also: ["toolWord"] },
  { id: "decor", need: ["toolDecor"], also: ["toolWord"] },
  { id: "object", need: ["toolObject"], also: ["toolWord"] },
  { id: "move", need: ["toolMove"], also: ["toolWord"] },
  { id: "locations", need: ["toolLocations"], also: ["toolWord"] },
  { id: "zone", need: ["toolZone"], also: ["toolWord"] },
  { id: "fog", need: ["toolFog"], also: ["toolWord"] },
];

/** The menu commands the bar can ask for (the ids `onSelect` of TopMenuBar handles). */
export type CommandId =
  | "file:open" | "file:new" | "file:upload" | "file:export" | "file:passport"
  | "edit:undo" | "edit:redo" | "edit:validate"
  | "view:terrain" | "view:objects" | "view:grid" | "view:locations" | "view:animate"
  | "view:objectPanel" | "view:eventPanel" | "view:anchors" | "view:roles" | "view:minimap"
  | "view:fit" | "view:appearance" | "help:keys" | "help:commands";

const SHOWN = ["layer", "toggle"] as const;

const COMMANDS: readonly (Rule & { id: CommandId })[] = [
  { id: "file:open", need: ["open"], also: ["mapWord"] },
  { id: "file:new", need: ["fresh"], also: ["mapWord"] },
  { id: "file:new", need: ["create", "mapWord"] },
  { id: "file:upload", need: ["upload"], also: ["mapWord"] },
  { id: "file:export", need: ["export"], also: ["mapWord"] },
  { id: "file:passport", need: ["passport"], also: ["mapWord"] },
  { id: "edit:undo", need: ["undo"] },
  { id: "edit:redo", need: ["redo"] },
  { id: "edit:validate", need: ["validate"], also: ["mapWord"] },
  // a layer needs «слой / показать / скрыть»: the bare noun is the tool of the same name
  { id: "view:terrain", need: [SHOWN, "toolTerrain"] },
  { id: "view:objects", need: [SHOWN, "toolObject"] },
  { id: "view:grid", need: ["grid"], also: ["toggle"] },
  { id: "view:locations", need: [SHOWN, "toolLocations"] },
  { id: "view:animate", need: ["animation"], also: ["toggle"] },
  { id: "view:objectPanel", need: ["panel", "toolObject"], also: ["toggle"] },
  { id: "view:eventPanel", need: ["events"], also: ["panel", "toggle"] },
  { id: "view:anchors", need: ["anchors"], also: ["toggle"] },
  { id: "view:roles", need: ["roles"], also: ["toolLocations", "toggle"] },
  { id: "view:minimap", need: ["minimap"], also: ["toggle"] },
  { id: "view:minimap", need: ["mini", "mapWord"], also: ["toggle"] },
  { id: "view:fit", need: ["fit"], also: ["windowWord", "mapWord"] },
  { id: "view:fit", need: ["windowWord"] },
  { id: "view:fit", need: ["toggle", "whole", "mapWord"] }, // «показать всю карту»
  { id: "view:appearance", need: ["theme"] },
  { id: "help:keys", need: ["keys"] },
  { id: "help:commands", need: ["help"] },
];

export const TOOL_IDS: readonly ToolId[] = TOOLS.map((t) => t.id);
export const COMMAND_IDS: readonly CommandId[] = [...new Set(COMMANDS.map((c) => c.id))];

/** Everything the bar can do besides generating, for a list of what is on offer. */
export type Action = { kind: "tool"; tool: ToolId } | { kind: "command"; command: CommandId };
export function listActions(): Action[] {
  return [...TOOL_IDS.map((tool): Action => ({ kind: "tool", tool })), ...COMMAND_IDS.map((command): Action => ({ kind: "command", command }))];
}

// ----- interpretations -------------------------------------------------------------------

interface Common {
  /** Higher = a better reading of the line (see RANKING at the top). */
  score: number;
  /** How the words matched: all exactly, one still being typed, one with a typo. From
   *  `nearest()` — an offer, not a reading: `open` (the line says how / where / how much but
   *  not yet what) or `near` (a word is only close to one the bar knows). */
  match: "exact" | "partial" | "typo" | "open" | "near";
  /** The tokens of `tokenize(text)` this reading used. */
  tokens: number[];
}

export type Interpretation =
  | (Common & { kind: "generate"; recipeId: string; area: ParsedArea; amount: AmountStep })
  | (Common & { kind: "tool"; tool: ToolId })
  | (Common & { kind: "command"; command: CommandId })
  | (Common & { kind: "goto"; x: number; y: number })
  | (Common & { kind: "find"; query: string });

export interface InterpretOptions {
  /** The recipe ids the server's catalogue has; without it every recipe of the lexicon counts. */
  recipes?: Iterable<string>;
}

/** Base scores, in hundredths (kept whole so that equal scores are exactly equal). */
const BASE = { find: 130, goto: 120, generate: 100, action: 95 } as const;
const PER_WORD = 10;
const PER_CONTEXT_WORD = 5;

const matchOf = (q: number): Common["match"] => (q >= EXACT ? "exact" : q >= PARTIAL ? "partial" : "typo");
const ascending = (list: Iterable<number>): number[] => [...new Set(list)].sort((a, b) => a - b);

/** The best free token for a need: the surest, then the earliest. */
function pick(hits: Hits, need: Need, taken: ReadonlySet<number>): Hit | null {
  let best: Hit | null = null;
  for (const id of typeof need === "string" ? [need] : need) {
    for (const h of hits[id]) {
      if (taken.has(h.i)) continue;
      if (!best || h.q > best.q || (h.q === best.q && h.i < best.i)) best = h;
    }
  }
  return best;
}

/** How a line fits a rule. */
interface Fit {
  /** The tokens the rule's words were found in. */
  taken: Set<number>;
  /** The token of the thing itself (the first need); −1 when the line does not name it. */
  head: number;
  /** The weakest of the needed matches. */
  q: number;
  /** How many of the needs the line does not say; 0 = the rule applies. */
  missing: number;
}
function fit(rule: Rule, hits: Hits): Fit {
  const taken = new Set<number>();
  let q = EXACT;
  let head = -1;
  let missing = 0;
  rule.need.forEach((need, k) => {
    const h = pick(hits, need, taken);
    if (!h) {
      missing++;
      return;
    }
    if (k === 0) head = h.i;
    taken.add(h.i);
    q = Math.min(q, h.q);
  });
  for (const also of rule.also ?? []) {
    const h = pick(hits, also, taken);
    if (h) taken.add(h.i);
  }
  return { taken, head, q, missing };
}

/** «20 30», «клетка 20,30», «go to 20 30»: two numbers and nothing but the words of going. */
function cellOf(tokens: readonly Token[], hits: Hits): Interpretation | null {
  const numbers = tokens.filter((t) => t.kind === "number");
  if (numbers.length !== 2 || tokens.some((t) => t.kind === "size")) return null;
  const going = new Set(hits.gotoWord.filter((h) => h.q === EXACT).map((h) => h.i));
  if (tokens.some((t, i) => t.kind === "word" && !going.has(i))) return null;
  return {
    kind: "goto",
    x: Number(numbers[0]!.text),
    y: Number(numbers[1]!.text),
    score: (BASE.goto + PER_CONTEXT_WORD * going.size) / 100,
    match: "exact",
    tokens: tokens.map((_, i) => i),
  };
}

/** What follows the first word of the line, as typed (the query of «найти …»). */
function afterFirstWord(text: string): string {
  const m = /^[^\p{L}\p{N}]*[\p{L}\p{N}]+/u.exec(text);
  return (m ? text.slice(m[0].length) : "").replace(/^[\s:«»"'“”„=—–-]+|[\s«»"'“”„]+$/gu, "");
}

const keyOf = (i: Interpretation): string =>
  i.kind === "generate" ? `g:${i.recipeId}` : i.kind === "tool" ? `t:${i.tool}` : i.kind === "command" ? `c:${i.command}` : i.kind;

/** Best first; of several readings that come to the same thing, the best one. */
function ranked(list: Interpretation[]): Interpretation[] {
  const seen = new Set<string>();
  return list
    .map((item, order) => ({ item, order }))
    .sort((a, b) => b.item.score - a.item.score || a.order - b.order)
    .map((x) => x.item)
    .filter((i) => !seen.has(keyOf(i)) && !!seen.add(keyOf(i)));
}

/**
 * Everything `text` can mean, best first; empty when nothing of it is understood (the bar
 * then offers `nearest()`).
 */
export function interpret(text: string, options: InterpretOptions = {}): Interpretation[] {
  const tokens = tokenize(text);
  if (!tokens.length) return [];
  const hits = scan(tokens);
  const catalogue = options.recipes ? new Set(options.recipes) : null;
  const out: Interpretation[] = [];

  const verb = hits.findVerb.find((h) => h.i === 0);
  if (verb) {
    out.push({ kind: "find", query: afterFirstWord(text), score: Math.round(BASE.find * verb.q) / 100, match: matchOf(verb.q), tokens: tokens.map((_, i) => i) });
  }
  const cell = cellOf(tokens, hits);
  if (cell) out.push(cell);

  for (const rule of RECIPES) {
    if (catalogue && !catalogue.has(rule.id)) continue;
    const m = fit(rule, hits);
    if (m.missing) continue;
    const area = areaOf(tokens, hits, m.head);
    const amount = amountOf(hits, m.taken);
    const context = new Set([...area.tokens, ...amount.tokens].filter((i) => !m.taken.has(i)));
    out.push({
      kind: "generate",
      recipeId: rule.id,
      area,
      amount: amount.step,
      score: (Math.round(BASE.generate * m.q) + PER_WORD * (m.taken.size - 1) + PER_CONTEXT_WORD * context.size) / 100,
      match: matchOf(m.q),
      tokens: ascending([...m.taken, ...context]),
    });
  }
  const action = (m: Fit): Common => ({
    score: (Math.round(BASE.action * m.q) + PER_WORD * (m.taken.size - 1)) / 100,
    match: matchOf(m.q),
    tokens: ascending(m.taken),
  });
  for (const rule of TOOLS) {
    const m = fit(rule, hits);
    if (!m.missing) out.push({ kind: "tool", tool: rule.id, ...action(m) });
  }
  for (const rule of COMMANDS) {
    const m = fit(rule, hits);
    if (!m.missing) out.push({ kind: "command", command: rule.id, ...action(m) });
  }
  return ranked(out);
}

/** How near a token is to a stem, 0…1: by slips (one; two in a stem of 7+ letters — in a
 *  shorter one two slips fit half the dictionary) or by a common beginning of 3+ letters.
 *  0 = not near. */
function nearness(token: string, stem: Stem): number {
  const s = stem.s;
  if (s.length < 3 || token.length < 2) return 0;
  let common = 0;
  while (common < token.length && common < s.length && token[common] === s[common]) common++;
  const d = Math.min(editDistance(token, s), !stem.whole && token.length > s.length ? editDistance(token.slice(0, s.length), s) : Infinity);
  const bySlips = d <= (s.length >= 7 ? 2 : 1) ? 1 - d / s.length : 0;
  const byBeginning = common >= 3 ? common / Math.max(token.length, s.length) : 0;
  return Math.max(bySlips, byBeginning);
}

/** What is offered under a line that names a place or an amount but nothing to make there. */
const PLAIN_OFFERS: readonly string[] = ["water_lake", "decor_forest", "mountain_blob", "relief_hills", "snow_overlay", "decor_rocks"];
const NONE: ReadonlySet<number> = new Set();
/** Words that carry nothing: a line of understood words and these is not «not understood». */
const FILLERS = new Set(
  normalize(
    "и а в во на по с со у к ко о об от до из за для над под при или же бы мне хочу нужно надо давай пожалуйста сделай сделать добавь добавить поставь поставить сгенерируй сгенерировать " +
      "a an the and or of in on at to by with some please make add put generate want need " +
      "i a w we z ze na do po u o od dla nad pod przy lub oraz proszę zrób dodaj wstaw wygeneruj chcę",
  ).split(/\s+/),
);

/**
 * For a line `interpret()` made nothing of — never a dead end. OFFERS, best first; they are
 * not readings of the line, so the bar runs one only when it is picked:
 *   near  a word is not understood, but is close to a word the bar knows (two slips in a
 *         long word, one in a short word, or the same beginning);
 *   open  every word is understood, but none names a thing — the line says how («редкий»,
 *         «инструмент», «слой»), where («на севере», «20x20») or how much («побольше»): the
 *         things those words go with, already there / that much.
 * Empty when there is nothing to go on — and for a line that does have a reading.
 */
export function nearest(text: string, options: InterpretOptions = {}, limit = 6): Interpretation[] {
  if (interpret(text, options).length) return [];
  const tokens = tokenize(text);
  const all = scan(tokens);
  const catalogue = options.recipes ? new Set(options.recipes) : null;
  const area = areaOf(tokens, all);
  // the words that named the place are spoken for («по всей карте» is not the «карта» of the
  // File menu); a frame word stays — «по краю» also asks for the solid sibling
  const place = new Set(area.tokens.filter((i) => tokens[i]!.kind === "word" && !all.frame.some((h) => h.i === i)));
  const hits = {} as Hits;
  for (const id of NOTIONS) hits[id] = all[id].filter((h) => !place.has(h.i));
  const understood = new Set(NOTIONS.flatMap((id) => all[id].map((h) => h.i)));
  const unknown = tokens
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => t.kind === "word" && t.text.length >= 2 && !understood.has(i) && !FILLERS.has(t.text));

  /** The offer a rule makes for this line, or null. */
  const offer = (rule: Rule): { said: Common; taken: ReadonlySet<number> } | null => {
    const m = fit(rule, hits);
    if (!m.missing) return null; // the rule applies as it is: that is a reading, interpret() has it
    if (!unknown.length) {
      // the words the rule knows, minus the thing itself: sharper the more of them were said
      if (!m.taken.size) return null;
      return { said: { score: (30 + 5 * m.taken.size - 2 * (m.missing - 1)) / 100, match: "open", tokens: ascending(m.taken) }, taken: m.taken };
    }
    if (m.head >= 0) return null;
    // is the word that was not understood close to the thing this rule is about?
    const head = rule.need[0]!;
    let best = { n: 0, i: -1 };
    for (const id of typeof head === "string" ? [head] : head) {
      for (const st of STEMS[id]) {
        for (const { t, i } of unknown) {
          const n = nearness(t.text, st);
          if (n > best.n) best = { n, i };
        }
      }
    }
    if (best.n < 0.5) return null;
    // the rule's other words lift it when said and lower it a notch when not, so the plain
    // thing comes before its siblings
    return { said: { score: (Math.round(50 * best.n) + 5 * m.taken.size - (m.missing - 1)) / 100, match: "near", tokens: ascending([best.i, ...m.taken]) }, taken: m.taken };
  };
  const generation = (recipeId: string, said: Common, taken: ReadonlySet<number>): Interpretation => ({
    kind: "generate", recipeId, area, amount: amountOf(all, taken).step, ...said,
  });

  const out: Interpretation[] = [];
  for (const rule of RECIPES) {
    if (catalogue && !catalogue.has(rule.id)) continue;
    const o = offer(rule);
    if (o) out.push(generation(rule.id, o.said, o.taken));
  }
  for (const rule of TOOLS) {
    const o = offer(rule);
    if (o) out.push({ kind: "tool", tool: rule.id, ...o.said });
  }
  for (const rule of COMMANDS) {
    const o = offer(rule);
    if (o) out.push({ kind: "command", command: rule.id, ...o.said });
  }
  // only a place or an amount: the plain things, there / that much — below whatever goes
  // with a word that was said
  const amount = amountOf(all, NONE);
  if (!unknown.length && (area.tokens.length || amount.step !== 0)) {
    PLAIN_OFFERS.forEach((id, k) => {
      if (!catalogue || catalogue.has(id)) out.push(generation(id, { score: (25 - k) / 100, match: "open", tokens: ascending([...area.tokens, ...amount.tokens]) }, NONE));
    });
  }
  return ranked(out).slice(0, limit);
}
