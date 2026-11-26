<script setup lang="ts">
/**
 * Copilot — a light, frosted-glass floating command input docked at the bottom-centre of
 * the canvas (NOT a panel). Just a field: type a command, Enter to send. The chat log
 * floats above only while expanded (on focus / after a message). "/" focuses it (viewStore
 * focusCopilot); the ✕ hides it (and "/" brings it back).
 *
 * Three ways to ask for a generation meet here and all go through genStore, so each gets the
 * same variant controls (GenResultStrip): a TILE of the generator palette (one click, no
 * typing), a typed COMMAND (the keyword router below), and — from the tool dock — a stroke
 * drawn «по рисунку».
 */
import { ref, nextTick, watch, onMounted } from "vue";
import { ElInput, ElPopover, ElSegmented, ElMessage } from "element-plus";
import { Promotion, Close, RefreshRight, Reading, ChatLineSquare, Grid } from "@element-plus/icons-vue";
import { computed } from "vue";
import type { GenRecipeInfo } from "@d2/socket-contract";
import { useViewStore } from "../stores/viewStore";
import { useEditStore } from "../stores/editStore";
import { useToolStore } from "../stores/toolStore";
import { AMOUNT_STEPS, useGenStore } from "../stores/genStore";
import { useFloatingDock } from "../composables/useFloatingDock";
import { tr, trn } from "../i18n";
import GenResultStrip from "./GenResultStrip.vue";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

const view = useViewStore();
const editStore = useEditStore();
const toolStore = useToolStore();
const gen = useGenStore();

// Draggable + persistent (like the minimap / history docks): grab the ⠿ grip to park the bar
// anywhere; the position is remembered per browser. Default = bottom-centre (CSS). When dragged
// we override the translateX(-50%) centering with transform:none so left/top position it exactly.
const floatEl = ref<HTMLElement | null>(null);
const { style: dockStyle, onHandlePointerDown, pos: dockPos } = useFloatingDock("copilot", floatEl);
const floatStyle = computed(() =>
  dockPos.value ? { ...dockStyle.value, transform: "none" } : dockStyle.value,
);

const region = computed(() => toolStore.region);

/**
 * Copilot generation AREA has THREE mutually-exclusive modes (the filter the user picks, or
 * that a command auto-selects):
 *   👁 screen — the visible screen (the DEFAULT); the area = what you see.
 *   ⛶ zone   — draw a rectangle / brush / line / frame on the map.
 *   📍 point  — click ONE cell; generate an NxN patch centred on it.
 * `area` is the single source of truth; setArea() syncs it onto the tool state (eyeZone +
 * the region tool). "zone" and "point" both drive the region tool — a click makes a 1×1
 * (the point), a drag makes an area — so the difference is intent (hint + default size).
 */
type Area = "screen" | "zone" | "point";
const area = ref<Area>("screen");
const POINT_DEFAULT = 16; // NxN for 📍 point when the command gives no explicit size

/** Which mode button is pulsing (drew the user's eye after an auto-switch). */
const areaPulse = ref<Area | null>(null);
function pulseArea(m: Area): void {
  areaPulse.value = m;
  window.setTimeout(() => { if (areaPulse.value === m) areaPulse.value = null; }, 1600);
}

/** Switch the generation area mode and mirror it onto the tool state. `auto` = selected by a
 *  command (pulse the button + hint) vs a manual click (silent). */
function setArea(m: Area, opts: { auto?: boolean } = {}): void {
  area.value = m;
  markActive();
  if (m === "screen") {
    toolStore.setEyeZone(true);
    if (toolStore.tool === "region") { toolStore.setRegion(null); toolStore.setTool("select"); }
  } else {
    toolStore.setEyeZone(false);
    if (m === "point") toolStore.setZoneMode("rect"); // a click = one cell = the point
    toolStore.setTool("region");
  }
  if (opts.auto) {
    pulseArea(m);
    if (m === "point") notify(tr("📍 Точка — кликни клетку на карте, потом Enter"), "info");
    else if (m === "zone") notify(tr("⛶ Зона — обведи область на карте, потом Enter"), "info");
  }
}
const input = ref("");
const expanded = ref(false);
const inputRef = ref<InstanceType<typeof ElInput> | null>(null);
const scroller = ref<HTMLElement | null>(null);
const log = ref<Msg[]>([
  {
    role: "assistant",
    text: tr("Copilot (превью). Скоро: «залей водой», «добавь горы слева», «выдели участок и перегенерируй»."),
  },
]);

const sending = ref(false);
/** LLM mode (Phase-4 POC): route the command through the server's LLM file-bridge instead
 *  of the offline keyword router. Off by default (keyword router needs no agent watching). */
const llmMode = ref(false);
/** HARD OFF: LLM-режим временно отключён — кнопка остаётся видимой, но disabled.
 *  Вернуть: true (+ VITE_COPILOT_LLM). */
const LLM_ENABLED = false;
/** Whether the LLM bridge is available on this deployment (disabled in prod: no agent). */
const LLM_AVAILABLE = LLM_ENABLED && import.meta.env.VITE_COPILOT_LLM !== "off";
/** Protect existing features: generation skips cells that already hold water/mountains. */
const protect = ref(false);
type Region = { x: number; y: number; w: number; h: number };

/** Readability: the bar is SOLID while in use, and fades to translucent after 25s idle so it
 *  doesn't obscure the map. Any interaction (hover / focus / click / command) wakes it. */
const idle = ref(true);
let idleTimer: number | undefined;
function markActive(): void {
  idle.value = false;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => { idle.value = true; }, 25000);
}

/** True while the input is focused — keeps the bar fully opaque (never idle) in use. */
const inputFocused = ref(false);
/** Effective translucency: only fade when idle AND not actively typing. */
const idleEffective = computed(() => idle.value && !inputFocused.value && !input.value.trim());

/** Format the last generation's timing/debug for the chat (client round-trip + server detail). */
function debugLine(clientMs: number): string {
  const d = editStore.genDebug;
  if (!d) return tr("{ms}мс", { ms: clientMs });
  let s = trn("{n} кл · сервер {server}мс / всего {total}мс", d.opCount, { server: d.serverMs, total: clientMs });
  if (d.protect) s += " · " + tr("🛡 {n} сохранено", { n: d.protectedInRegion ?? 0 });
  if (!d.validation.ok) {
    const bad = [
      !d.validation.identity && "identity",
      !d.validation.semantic && "semantic",
      !d.validation.structural && "structural",
    ].filter(Boolean).join("/");
    s += " · " + tr("⚠ валидация: {bad}", { bad });
  }
  return s;
}

/** The PRECISE reason the last validation failed (semantic reason + structural errors), from
 *  the full report. Empty string when it passed / no report. Shown so failures are actionable. */
function validationReason(): string {
  const r = editStore.report;
  if (!r || r.ok) return "";
  const parts: string[] = [];
  if (!r.identity) parts.push(tr("identity: байтовый round-trip не сошёлся"));
  if (r.semantic && !r.semantic.ok) parts.push(`semantic: ${r.semantic.reason ?? tr("несоответствие после применения")}`);
  if (r.structural && !r.structural.ok && r.structural.errors?.length) {
    const errs = r.structural.errors;
    parts.push(`structural: ${errs.slice(0, 3).join("; ")}${errs.length > 3 ? ` (+${errs.length - 3})` : ""}`);
  }
  return parts.length ? `\n↳ ${parts.join("\n↳ ")}` : "";
}

const placeholder = computed(() =>
  llmMode.value
    ? tr("🧠 опиши, что сгенерировать: «озеро на севере и гряда гор по диагонали»  ( / )")
    : tr("напр. «озеро», «река», «лабиринт», «озеро вокруг этой точки 20x20»  ( / )"),
);

/** The last successful LLM composition, so "↻" can roll it back and ask again. (A recipe
 *  generation is a genStore session instead — it has real variants.) */
const lastGen = ref<{ mode: "llm"; text: string; cells?: [number, number][] | null; protect?: boolean } | null>(null);

// --- zone drawing controls (mode / size / hide / accept) ---------------------
const zoneMode = computed(() => toolStore.zoneMode);
const regionMask = computed(() => toolStore.regionMask);
const zoneHidden = computed(() => toolStore.zoneHidden);
const visibleMaskLen = computed(() => view.visibleMask?.length ?? null);
/** One-time onboarding: the first time the user focuses the Copilot, draw their eye to the
 *  generator palette (pulse) and pop it open, so they see what can be made with one click.
 *  Persisted so it fires exactly once per browser. */
const EX_HINT_KEY = "d2.cp.palHinted.v1"; // v1 of the PALETTE hint (it used to open the phrase list)
const examplesPulse = ref(false);
const exBtn = ref<{ $el?: HTMLElement } | null>(null);
/** The generator palette (tiles) — the first thing a newcomer is shown. */
const palBtn = ref<{ $el?: HTMLElement } | null>(null);
const palPop = ref<InstanceType<typeof ElPopover> | null>(null);
function maybeHintExamples(): void {
  try {
    if (localStorage.getItem(EX_HINT_KEY)) return;
    localStorage.setItem(EX_HINT_KEY, "1");
  } catch {
    return; // storage unavailable — skip the one-time hint rather than repeat it every focus
  }
  examplesPulse.value = true;
  window.setTimeout(() => { examplesPulse.value = false; }, 5200);
  // …and open the palette (trigger="click") by clicking its reference button
  void nextTick(() => palBtn.value?.$el?.click?.());
}

/** First FEW times the Copilot is used, remind that the default area is 👁 Экран (= the
 *  visible screen) and how to change it. Shown up to 3 times, then never again. */
const AREA_HINT_KEY = "d2.cp.areaHint.v1";
function maybeHintArea(): void {
  let n = 0;
  try {
    n = Number(localStorage.getItem(AREA_HINT_KEY)) || 0;
    if (n >= 3) return;
    localStorage.setItem(AREA_HINT_KEY, String(n + 1));
  } catch {
    return;
  }
  ElMessage({
    message: tr("Область генерации — 👁 Экран: то, что видно на экране. Сменить: ⛶ Зона (обвести) · 📍 Точка (кликнуть)."),
    type: "info", duration: 5000, showClose: true,
  });
  pulseArea("screen");
}

function onFocus(): void {
  // NB: do NOT auto-open the chat log here — it obscures the map and jitters the layout
  // (user request). The log is opened only by the 💬 toggle; results surface as toasts.
  inputFocused.value = true;
  markActive();
  maybeHintExamples();
  maybeHintArea();
}

// Default the generation area to 👁 Экран so a bare command "just works" on the visible
// map (no "выдели зону" dead-end). Purely a default — the user can switch any time.
onMounted(() => {
  setArea("screen");
  // the palette is built from what the server can generate; without the list it stays empty
  // and typed commands keep working
  void gen.loadCatalog().catch(() => undefined);
});

/** Manual show/hide of the chat log (💬). The ONLY way it opens — never automatic. */
function toggleLog(): void {
  expanded.value = !expanded.value;
  markActive();
}

/** Surface a Copilot result: a toast (so it's seen without the log popping open) AND a log
 *  line the user can review later by opening 💬. */
function notify(text: string, kind: "success" | "warning" | "info" = "info"): void {
  ElMessage({ message: text, type: kind, duration: 3500, showClose: true });
  pushAi(text);
}
function onBlur(): void {
  inputFocused.value = false;
}
function setZoneMode(m: "rect" | "brush" | "line" | "frame"): void {
  toolStore.setZoneMode(m);
}
/** Segmented options for the zone drawing controls. */
const zoneModeOptions = [
  { label: "▭", value: "rect" },
  { label: "✎", value: "brush" },
  { label: "╱", value: "line" },
  { label: "▢", value: "frame" },
];
const zoneSizeOptions = [
  { label: "1", value: 1 },
  { label: "3", value: 3 },
  { label: "5", value: 5 },
];
function onZoneMode(v: string | number | boolean): void {
  setZoneMode(v as "rect" | "brush" | "line" | "frame");
}
function onZoneSize(v: string | number | boolean): void {
  toolStore.setSize(Number(v));
}
function toggleZoneHidden(): void {
  toolStore.setZoneHidden(!toolStore.zoneHidden);
}
function acceptZone(): void {
  toolStore.clearZone();
}
const zoneHelp = computed(() => {
  switch (toolStore.zoneMode) {
    case "brush": return tr("рисуй кистью по карте");
    case "line": return tr("протяни полосу");
    case "frame": return tr("растяни рамку (только контур)");
    default: return tr("растяни прямоугольник, или кликни точку");
  }
});

/** "x,y"[] -> [x,y][] pairs (the server's cell-mask shape); null if empty. */
function toPairs(cells: string[] | null | undefined): [number, number][] | null {
  if (!cells || !cells.length) return null;
  return cells.map((k) => { const [x, y] = k.split(",").map(Number); return [x, y] as [number, number]; });
}

/** Examples browser (the 💡 popover). Click an example -> fills the input. */
const examplesOpen = ref(false);
const exPop = ref<InstanceType<typeof ElPopover> | null>(null);
// Big catalogue of working commands (all tested). Click → fills the input. Badges:
//   MJ  = generated by MarkovJunior — the shape is procedural and varies on ↻ "другой вариант".
//   LLM = flips on 🧠 mode (multi-step composition through the agent).
//   ✎   = "follows your drawing" group: pick ⛶ → кисть/полоса, draw, then the command.
// Каждый пункт ДЕЛАЕТ ровно то, что говорит (пере-аудит всех рецептов ASCII-гридами):
// «по всей карте» = вся карта, «в центре» = центр, «по краю» = кайма-маска, острова = СУША
// среди воды. Обещания, которых движок не держит («у воды», «по диагонали», «через лес»),
// из меню убраны — команда без пункта всё равно роутится по ключевым словам.
// `text` is the COMMAND put into the input: the router below reads Russian words, so it stays
// Russian in every interface language. `label` is what the list shows for it.
const EXAMPLES: { group: string; items: { text: string; label: string; llm?: boolean; mj?: boolean; need?: "screen" | "zone" | "point" | "side" }[] }[] = [
  { group: tr("🌊 Вода"), items: [
    { text: "озеро", label: tr("озеро"), mj: true },
    { text: "озеро в центре", label: tr("озеро в центре"), mj: true },
    { text: "озеро вокруг этой точки 20x20", label: tr("озеро вокруг этой точки 20x20"), mj: true },
    { text: "пруд 10x10", label: tr("пруд 10x10"), mj: true },
    { text: "несколько озёр", label: tr("несколько озёр"), mj: true },
    { text: "острова 30x30", label: tr("острова 30x30"), mj: true },
    { text: "река", label: tr("река"), mj: true },
    { text: "река по всей карте", label: tr("река по всей карте"), mj: true },
  ] },
  { group: tr("🌲 Лес"), items: [
    { text: "лес", label: tr("лес"), mj: true },
    { text: "густой лес", label: tr("густой лес"), mj: true },
    { text: "лес с полянами", label: tr("лес с полянами"), mj: true },
    { text: "редкий лес", label: tr("редкий лес"), mj: true },
    { text: "роща вокруг этой точки 16x16", label: tr("роща вокруг этой точки 16x16"), mj: true },
    { text: "рощи по всей карте", label: tr("рощи по всей карте"), mj: true },
  ] },
  { group: tr("⛰️ Горы и холмы"), items: [
    { text: "горы 20x20", label: tr("горы 20x20"), mj: true },
    { text: "горная гряда", label: tr("горная гряда"), mj: true },
    { text: "разбросай холмы", label: tr("разбросай холмы"), mj: true },
    { text: "горы по краю 30x30", label: tr("горы по краю 30x30") },
    { text: "горы вокруг этой точки 18x18", label: tr("горы вокруг этой точки 18x18"), mj: true },
  ] },
  { group: tr("🧱 Лабиринт"), items: [
    { text: "лабиринт", label: tr("лабиринт"), mj: true },
    { text: "лабиринт 28x28", label: tr("лабиринт 28x28"), mj: true },
  ] },
  { group: tr("❄️ Снег и трава"), items: [
    { text: "снег на севере", label: tr("снег на севере") },
    { text: "снег пятнами", label: tr("снег пятнами"), mj: true },
    { text: "редкий снег", label: tr("редкий снег"), mj: true },
    { text: "трава 20x20", label: tr("трава 20x20") },
    { text: "трава по всей карте", label: tr("трава по всей карте") },
  ] },
  { group: tr("🛣 Дорога и декор"), items: [
    { text: "извилистая дорога", label: tr("извилистая дорога"), mj: true },
    { text: "разбросай камни", label: tr("разбросай камни"), mj: true },
    { text: "кусты", label: tr("кусты"), mj: true },
    { text: "руины", label: tr("руины"), mj: true },
    { text: "кладбище 16x16", label: tr("кладбище 16x16"), mj: true },
  ] },
  { group: tr("✎ По рисунку (режим ⛶ Зона — проведи кистью/полосой, потом команду)"), items: [
    { text: "дорога", label: tr("дорога"), need: "zone" },
    { text: "река", label: tr("река"), need: "zone" },
    { text: "камни", label: tr("камни"), need: "zone" },
    { text: "кусты", label: tr("кусты"), need: "zone" },
    { text: "руины", label: tr("руины"), need: "zone" },
  ] },
  { group: tr("🗺️ Композиции — режим 🧠 LLM"), items: [
    { text: "озеро в центре, снег на севере, лес по южному краю", label: tr("озеро в центре, снег на севере, лес по южному краю"), llm: true },
    { text: "крепость: трава, водяной ров и стены вокруг центра", label: tr("крепость: трава, водяной ров и стены вокруг центра"), llm: true },
    { text: "остров: вода по краям, горы и лес в центре", label: tr("остров: вода по краям, горы и лес в центре"), llm: true },
    { text: "зимний север со снегом, лесистый юг, озёра в центре", label: tr("зимний север со снегом, лесистый юг, озёра в центре"), llm: true },
  ] },
];

/** Examples shown in the UI — drops the LLM-only items/groups when the bridge is disabled. */
const displayExamples = computed(() =>
  LLM_AVAILABLE
    ? EXAMPLES
    : EXAMPLES.map((g) => ({ ...g, items: g.items.filter((i) => !i.llm) })).filter((g) => g.items.length),
);

function regionCenter(r: Region): { x: number; y: number } {
  return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
}

/**
 * Keyword router (Phase 3, no LLM): text -> recipe id. Density modifiers
 * (редкий/разбросай/пятнами/густой) pick the scatter / patch / full variant of a biome,
 * so "редкий снег" no longer falls through to the solid snow wash.
 */
function routeRecipe(text: string): string | null {
  const t = text.toLowerCase();
  const sparse = /редк|разброс|местами|кое-?где|отдельн|дусти|припорош/.test(t);
  const patchy = /пятн|клоч|островк|местечк/.test(t);
  // the ONE maze — каменные стены 2×2 (Cyrillic-safe: \w doesn't match Cyrillic without /u).
  if (/лабиринт|maze/.test(t)) return "wall_maze";
  if (/забор|частокол|стен/.test(t)) return "wall_maze";
  // mountains & hills (before generic checks; «гряда гор», «разбросай холмы», «горы по краю»)
  if (/холм/.test(t) || (sparse && /гор|скал/.test(t))) return "relief_hills";
  if (/гряд|хребет/.test(t)) return "relief_ridge";
  // «по краю/рамкой» + «сплошные/залей» need the solid FILL (the frame band must be a wall);
  // a bare «горы/массив/скалы» gets the ORGANIC blob — nobody asks for a razor-edged rectangle.
  if (/гор\b|горы|гора|горн|скал|утёс|утес|массив/.test(t)) {
    return /по\s*кра|перимет|рамк|кольц|сплошн|залей/.test(t) ? "mountain_fill" : "mountain_blob";
  }
  // roads & scattered decorations (before water/forest so «кусты у воды» isn't water)
  if (/дорог|тропа|тропинк|тропу|путь|перекрёст|перекрест|просёлок|просёл|просел/.test(t)) return "road_path";
  if (/камн|валун|булыжник/.test(t)) return "decor_rocks";
  if (/куст|поросль|кустарник/.test(t)) return "decor_bushes";
  if (/руин|развалин/.test(t)) return "decor_ruins";
  if (/могил|кладбищ|кост|череп|надгроб/.test(t)) return "decor_graves";
  // snow
  if (/снег|снеж|зим/.test(t)) return sparse ? "snow_scatter" : patchy ? "snow_patches" : "snow_overlay";
  // water
  if (/река|речк|ручей|русло/.test(t)) return "river";
  // «острова/архипелаг» = СУША среди воды (v1 routed it to scattered LAKES — the opposite).
  // (?!к) keeps the TEXTURE word «островками» («лес островками», «снег островками») out —
  // it's a patchiness modifier for the biome branches below, not a water request.
  if (/архипелаг|остров(?!к)/.test(t)) return "water_islands";
  if (/озёра|озера|несколько\s+озёр/.test(t)) return "water_isles";
  if (/вод|озер|море|залей|пруд|болот/.test(t)) return "water_lake";
  // forest: dense (чаща/густой = solid with organic glades), clearings, groves, or scatter
  if (/полян|прогалин|просек|чащ|густ/.test(t)) return "forest_clearings";
  if (/лес|дерев|рощ|\bбор\b/.test(t)) return sparse ? "forest_scatter" : "decor_forest";
  // ground
  if (/трав|земл|очист|равнин|плато|луг/.test(t)) return "grass_fill";
  return null;
}
function pushAi(text: string): void {
  log.value.push({ role: "assistant", text });
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
  });
}

/** `drawn`: the mask is a shape the user drew (brush / line / frame) — a recipe that can
 *  follow a drawing follows it. A mask that only clips (the visible screen, a «по краю»
 *  band) is not: there the recipe runs normally and is cut to the mask. */
type Zone = { region: Region; cells: [number, number][] | null; drawn?: boolean };
type Need = "screen" | "zone" | "point" | "side";

/** What AREA a command implies, so the right filter (👁/⛶/📍) can be auto-selected. */
function needOf(text: string): Need {
  if (/вокруг|около|возле|здесь|тут|это[йм]\s*точк|в\s*точк|в\s*этом\s*месте/i.test(text)) return "point";
  if (/север|\bюг|\bюж|запад|восток|слев|справ|сверху|снизу|вверх|вниз/i.test(text)) return "side";
  return "screen"; // "zone" can't be inferred from words alone — it's set by the ✎ examples
}
/** A command's implied area maps onto one of the three filter buttons (side runs textually
 *  within the 👁 screen mode via the direction-halves branch). */
function areaForNeed(n: Need): Area {
  return n === "point" ? "point" : n === "zone" ? "zone" : "screen";
}

/** Perimeter band of a region as a global cell mask — «горы по краю» without hand-drawing
 *  the ▢ frame. Band ≈ 12% of the shorter side, clamped 2..4 (mountains pack 2×2/3×3). */
function frameCells(r: Region, sizeCap: number): [number, number][] {
  const band = Math.max(2, Math.min(4, Math.round(Math.min(r.w, r.h) * 0.12)));
  const out: [number, number][] = [];
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      if (x < band || y < band || x >= r.w - band || y >= r.h - band) {
        const gx = r.x + x, gy = r.y + y;
        if (gx >= 0 && gy >= 0 && gx < sizeCap && gy < sizeCap) out.push([gx, gy]);
      }
    }
  }
  return out;
}

/**
 * Resolve the target zone — its bbox `region` + an optional cell `cells` mask. Priority:
 *  1. 📍 point mode / "вокруг точки" — centre NxN (or POINT_DEFAULT) on the clicked cell.
 *  2. ⛶ an explicit drag selection — with its drawn mask (brush/line/frame).
 *  3. «по всей карте / везде» -> the WHOLE map (v1 silently generated on the visible screen).
 *  4. "NxM" centred on the map; «в центре» without a size -> a centred ~40% block.
 *  5. a direction ("север/юг/запад/восток") -> half the map.
 *  6. 👁 screen -> the EXACT visible cells (diamond mask), so it matches what you see.
 * «по краю/периметру/рамкой» turns the resolved region into its perimeter-band cell mask.
 */
function resolveZone(text: string, size: number): Zone | null {
  const zone = resolveZoneBase(text, size);
  // frame intent: keep the region, clip generation to its perimeter band. A HAND-DRAWN ⛶
  // mask wins (the drawing IS the shape); the 👁 eye's derived diamond mask does NOT — else
  // a bare «горы по краю» in the default screen mode skipped the band and mountain_fill
  // flooded the whole visible screen. Eye cells are intersected so the band stays visible.
  if (zone && /по\s*кра|перимет|рамк|кольц/i.test(text)) {
    const drawnMask = !!toolStore.region && !!toolStore.regionMask?.length;
    if (!drawnMask) {
      const band = frameCells(zone.region, size);
      if (!zone.cells) return { region: zone.region, cells: band };
      const visible = new Set(zone.cells.map(([x, y]) => `${x},${y}`));
      const clipped = band.filter(([x, y]) => visible.has(`${x},${y}`));
      return { region: zone.region, cells: clipped.length ? clipped : band };
    }
  }
  return zone;
}
function resolveZoneBase(text: string, size: number): Zone | null {
  const clamp = (n: number): number => Math.max(2, Math.min(n, size));
  const m = /(\d{1,3})\s*[x×х*]\s*(\d{1,3})/i.exec(text);
  const around = /вокруг|около|возле|здесь|тут|это[йм]\s*точк|в\s*точк|в\s*этом\s*месте/i.test(text);
  const sel = toolStore.region;
  const anchor = sel
    ? regionCenter(sel)
    : view.cursorCell
      ? { x: view.cursorCell.x, y: view.cursorCell.y }
      : null;

  // 1) POINT: the 📍 mode, an explicit "вокруг точки", or a 1×1 selection + a size. Size = the
  //    command's NxN, else POINT_DEFAULT (so a bare "озеро" in 📍 mode isn't a single cell).
  const pointIntent = area.value === "point" || around || (!!m && sel ? sel.w <= 2 && sel.h <= 2 : false);
  if (pointIntent && anchor) {
    const w = clamp(m ? +m[1]! : POINT_DEFAULT), h = clamp(m ? +m[2]! : POINT_DEFAULT);
    const x = Math.max(0, Math.min(anchor.x - Math.floor(w / 2), size - w));
    const y = Math.max(0, Math.min(anchor.y - Math.floor(h / 2), size - h));
    return { region: { x, y, w, h }, cells: null };
  }
  // 2) «по всей карте / везде» — the WHOLE map, even over a drawn selection (the words are
  //    the more explicit intent). v1 silently generated on the visible screen, so «трава по
  //    всей карте» cleaned a screenful and left the rest untouched.
  if (/по\s*всей\s*карте|всю\s*карту|на\s*всей\s*карте|везде|повсюду/i.test(text)) {
    return { region: { x: 0, y: 0, w: size, h: size }, cells: null };
  }
  // 3) an explicit drag selection (+ its drawn mask)
  if (sel) return { region: sel, cells: toPairs(toolStore.regionMask), drawn: !!toolStore.regionMask?.length };
  // 4) "NxM" centred; «в центре» without a size = a centred ~40% block (v1 ignored the word
  //    and filled the whole screen)
  if (m) {
    const w = clamp(+m[1]!), h = clamp(+m[2]!);
    return { region: { x: Math.floor((size - w) / 2), y: Math.floor((size - h) / 2), w, h }, cells: null };
  }
  if (/в\s*центре|по\s*центру/i.test(text)) {
    const w = clamp(Math.round(size * 0.4));
    return { region: { x: Math.floor((size - w) / 2), y: Math.floor((size - w) / 2), w, h: w }, cells: null };
  }
  // 5) direction halves
  const half = Math.floor(size / 2);
  if (/север|сверху|вверх/i.test(text)) return { region: { x: 0, y: 0, w: size, h: half }, cells: null };
  if (/юг|снизу|вниз/i.test(text)) return { region: { x: 0, y: size - half, w: size, h: half }, cells: null };
  if (/запад|слев/i.test(text)) return { region: { x: 0, y: 0, w: half, h: size }, cells: null };
  if (/восток|справ/i.test(text)) return { region: { x: size - half, y: 0, w: half, h: size }, cells: null };
  // 6) 👁 eye: the exact visible cells (diamond mask), bbox as the region
  if (toolStore.eyeZone && view.visibleCells) return { region: view.visibleCells, cells: toPairs(view.visibleMask) };
  return null;
}

/** LLM-bridge send (Phase-4 POC): the server file-bridges the command to the agent. */
async function sendLlm(text: string): Promise<void> {
  if (!editStore.liveDoc) {
    pushAi(tr("Карта не загружена."));
    return;
  }
  sending.value = true;
  const t0 = performance.now();
  const thinking: Msg = { role: "assistant", text: tr("🧠 LLM думает… {s}s", { s: 0 }) };
  log.value.push(thinking);
  const timer = window.setInterval(() => {
    thinking.text = tr("🧠 LLM думает… {s}s", { s: Math.round((performance.now() - t0) / 1000) });
  }, 1000);
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
  });
  try {
    const zone = editStore.liveDoc ? resolveZone(text, editStore.liveDoc.size) : null;
    const res = await editStore.copilot(text, zone?.region ?? null, zone?.cells ?? null, protect.value);
    if (!res) {
      thinking.text = tr("Карта не загружена.");
      return;
    }
    const ms = Math.round(performance.now() - t0);
    const head = res.reasoning?.trim() || tr("Готово.");
    thinking.text = res.report?.ok
      ? `${head} · ${debugLine(ms)}`
      : tr("{head} — валидация не прошла, откатил. · {debug}", { head, debug: debugLine(ms) }) + validationReason();
    if (res.report?.ok) lastGen.value = { mode: "llm", text, cells: zone?.cells ?? null, protect: protect.value };
  } catch (e) {
    thinking.text = "⚠ " + (e instanceof Error ? e.message : String(e));
  } finally {
    clearInterval(timer);
    sending.value = false;
    void nextTick(() => {
      if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
    });
  }
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || sending.value) return;
  markActive();
  log.value.push({ role: "user", text });
  input.value = "";

  if (llmMode.value && LLM_AVAILABLE) {
    await sendLlm(text);
    return;
  }

  const recipeId = routeRecipe(text);
  if (!recipeId) {
    notify(tr("Не понял команду. Примеры: «лабиринт», «залей водой», «снег на севере», «лес», «трава»."), "warning");
    return;
  }
  const doc = editStore.liveDoc;
  if (!doc) {
    notify(tr("Карта не загружена."), "warning");
    return;
  }
  // Auto-select the area filter a TYPED command implies (point → 📍, direction → 👁 screen);
  // a generic command keeps the current mode (respect a drawn ⛶ zone).
  const need = needOf(text);
  if (need === "point" && area.value !== "point") setArea("point", { auto: true });
  else if (need === "side" && area.value === "point") setArea("screen");

  const zone = resolveZone(text, doc.size);
  if (!zone) {
    explainNoZone();
    return;
  }
  await generateIn(recipeId, zone);
}

/** Mode-aware dead-end hint: there is no area to generate in yet. */
function explainNoZone(): void {
  if (area.value === "point") notify(tr("📍 Точка — кликни клетку на карте, потом повтори."), "warning");
  else if (area.value === "zone") notify(tr("⛶ Зона — обведи область на карте, потом повтори."), "warning");
  else notify(tr("Не понял область. Наведи карту (👁 Экран) или выбери ⛶ Зона / 📍 Точка, либо укажи размер («25x25») / сторону («север»)."), "warning");
}

/** Generate `recipeId` in `zone` as a new session of variants, and say what came of it. */
async function generateIn(recipeId: string, zone: Zone): Promise<void> {
  const { region, cells } = zone;
  sending.value = true;
  const t0 = performance.now();
  try {
    const rep = await gen.run({ recipeId, region, cells, stroke: !!zone.drawn, protect: protect.value });
    const ms = Math.round(performance.now() - t0);
    const what = `${gen.titleOf(recipeId)} ${region.w}×${region.h}`;
    if (!rep) notify(tr("Карта недоступна для правок."), "warning");
    else if (!rep.ok) notify(tr("{what}: карта не прошла проверку — вариант не применён. · {debug}", { what, debug: debugLine(ms) }) + validationReason(), "warning");
    else if ((editStore.genDebug?.opCount ?? 0) === 0) notify(tr("{what}: ничего не изменилось — место занято или защищено (🛡).", { what }), "warning");
    else notify(tr("Готово: {what} · {debug}", { what, debug: debugLine(ms) }), "success");
  } catch (e) {
    notify("⚠ " + (e instanceof Error ? e.message : String(e)), "warning");
  } finally {
    sending.value = false;
  }
}

/** A tile of the palette: generate that recipe in the current area — one click, no typing. */
async function runTile(r: GenRecipeInfo): Promise<void> {
  if (sending.value || gen.busy) return;
  markActive();
  (palPop.value as unknown as { hide?: () => void } | null)?.hide?.();
  const doc = editStore.liveDoc;
  if (!doc) {
    notify(tr("Карта не загружена."), "warning");
    return;
  }
  log.value.push({ role: "user", text: tr(r.title) });
  const zone = resolveZone("", doc.size);
  if (!zone) {
    explainNoZone();
    return;
  }
  await generateIn(r.id, zone);
}

/** The ✎ corner of a tile: arm «по рисунку» for that recipe — the next stroke on the map is it. */
function drawTile(r: GenRecipeInfo): void {
  if (!r.stroke) return;
  markActive();
  (palPop.value as unknown as { hide?: () => void } | null)?.hide?.();
  area.value = "zone"; // the region tool is what draws the stroke
  toolStore.setEyeZone(false);
  toolStore.setDrawGen(r.id, { mode: r.stroke, size: r.strokeWidth ?? 1 });
  notify(r.stroke === "line" ? tr("✎ {title}: протяни линию на карте", { title: tr(r.title) }) : tr("✎ {title}: проведи кистью по карте", { title: tr(r.title) }), "info");
}

/** What the palette says about where a click will generate. */
const areaLine = computed(() => {
  if (area.value === "point") {
    return region.value ? tr("📍 вокруг клетки {x}, {y} — {n}×{n}", { x: region.value.x, y: region.value.y, n: POINT_DEFAULT }) : tr("📍 точка не выбрана — кликни клетку на карте");
  }
  if (area.value === "zone") {
    if (!region.value) return tr("⛶ зона не обведена — обведи область на карте");
    return regionMask.value?.length
      ? trn("⛶ в обведённой зоне — {n} кл.", regionMask.value.length)
      : tr("⛶ в обведённой зоне — {w}×{h}", { w: region.value.w, h: region.value.h });
  }
  return visibleMaskLen.value ? trn("👁 на всём, что видно на экране — {n} кл.", visibleMaskLen.value) : tr("👁 на всём, что видно на экране");
});

/** The palette's «меньше … больше» control: the amount a NEW generation starts with. */
const amountOptions = AMOUNT_STEPS.map((value, i) => ({ value, label: ["−−", "−", "●", "+", "++"][i] ?? String(value) }));
function onAmount(v: string | number | boolean): void {
  gen.amount = Number(v);
}

/** ↻ in the bar: another variant of the generation being tried, or (LLM) ask again. */
async function retry(): Promise<void> {
  if (sending.value) return;
  if (gen.session) {
    if (!(await gen.another())) notify(tr("После генерации были другие правки — вариант оставлен на карте как есть."), "info");
    return;
  }
  const g = lastGen.value;
  if (!g) return;
  // Mute the canvas so the undo (revert to base) isn't painted — the map jumps straight from
  // the current variant to the new one, no rollback flash in between.
  editStore.setRenderMuted(true);
  try {
    if (editStore.undoable) editStore.undoEdit(); // undo the previous generation commit
    log.value.push({ role: "user", text: tr("↻ другой вариант: {text}", { text: g.text }) });
    await sendLlm(g.text);
  } finally {
    editStore.setRenderMuted(false); // paints the final variant once (MapCanvasHost watcher)
  }
}

/** Fill the input from an example, and AUTO-SELECT the area filter the command needs
 *  (👁 screen / ⛶ zone / 📍 point) — the button pulses so the switch is visible. */
function applyExample(ex: { text: string; llm?: boolean; mj?: boolean; need?: Need }): void {
  input.value = ex.text;
  if (ex.llm) llmMode.value = true;
  examplesOpen.value = false;
  (exPop.value as unknown as { hide?: () => void } | null)?.hide?.();
  const need = ex.need ?? needOf(ex.text);
  setArea(areaForNeed(need), { auto: true });
  void nextTick(() => inputRef.value?.focus());
}

function hide(): void {
  view.copilotVisible = false;
}

// "/" (viewStore.focusCopilot bumps the tick) -> reveal + focus the input (but NOT the log —
// that stays user-controlled via the 💬 toggle).
watch(
  () => view.copilotFocusTick,
  () => {
    markActive();
    void nextTick(() => inputRef.value?.focus());
  },
);
</script>

<template>
  <div ref="floatEl" class="copilot-float" :style="floatStyle" @mouseenter="markActive()" @pointerdown="markActive()">
    <!-- Log + zone/point hint float ABOVE the bar, OUT of the flex flow, so opening them never
         moves the bar (the "copilot slides lower + scrollbar" bug when the bar was dragged and
         thus top-anchored: a taller flex column pushed the bar down). -->
    <div class="cp-above">
    <transition name="cp-fade">
      <div v-if="expanded" ref="scroller" class="copilot-log d2-float" :class="{ idle: idleEffective }">
        <div v-for="(m, i) in log" :key="i" class="cp-msg" :class="m.role">
          <span class="cp-who">{{ m.role === "user" ? tr("вы") : tr("ии") }}</span>
          <span class="cp-text">{{ m.text }}</span>
        </div>
      </div>
    </transition>

    <div v-if="area !== 'screen'" class="cp-zonehint d2-float" :class="{ idle: idleEffective }">
      <template v-if="area === 'zone'">
        <div class="cp-zrow">
          <span class="cp-zlabel">{{ tr("⛶ Зона:") }}</span>
          <el-segmented :model-value="zoneMode" :options="zoneModeOptions" size="small" @change="onZoneMode" />
          <el-segmented
            v-if="zoneMode === 'brush' || zoneMode === 'line'"
            :model-value="toolStore.size"
            :options="zoneSizeOptions"
            size="small"
            @change="onZoneSize"
          />
        </div>
        <div class="cp-zrow">
          <span class="cp-zhelp">{{ zoneHelp }}</span>
          <template v-if="region">
            <span class="cp-zsel">{{ regionMask?.length ? trn("{n} кл.", regionMask.length) : region.w + "×" + region.h }}</span>
            <el-button size="small" text @click="toggleZoneHidden">{{ zoneHidden ? tr("Показать") : tr("Скрыть") }}</el-button>
            <el-button size="small" text type="success" @click="acceptZone">{{ tr("Принять") }}</el-button>
          </template>
        </div>
      </template>
      <template v-else>
        <div class="cp-zrow">
          <span class="cp-zlabel">{{ tr("📍 Точка:") }}</span>
          <span class="cp-zhelp">{{ tr("кликни клетку на карте — сгенерирую {n}×{n} вокруг (или укажи размер в команде)", { n: POINT_DEFAULT }) }}</span>
        </div>
        <div v-if="region" class="cp-zrow">
          <span class="cp-zsel">{{ tr("точка ({x}, {y})", { x: region.x, y: region.y }) }}</span>
          <el-button size="small" text type="success" @click="acceptZone">{{ tr("Сбросить") }}</el-button>
        </div>
      </template>
    </div>

    <!-- the generation being tried: variants, more/less, keep or take away -->
    <GenResultStrip />
    </div>

    <div class="copilot-bar d2-float" :class="{ idle: idleEffective }">
      <span class="cp-grip" :title="tr('Перетащите копайлот (позиция запомнится)')" @pointerdown="onHandlePointerDown">⠿</span>
      <el-popover ref="palPop" :width="372" placement="top-start" trigger="click" popper-class="cp-ex-pop cp-pal-pop">
        <template #reference>
          <el-button ref="palBtn" class="cp-ico cp-examples" :class="{ pulse: examplesPulse }" text :icon="Grid" :title="tr('Генератор — выбрать, что сгенерировать')" />
        </template>
        <div class="cp-ex-head">
          {{ tr("Генератор — нажми, что сделать") }}
          <div class="cp-pal-where">{{ areaLine }}</div>
          <div class="cp-pal-amount">
            <span>{{ tr("Сколько:") }}</span>
            <el-segmented :model-value="gen.amount" :options="amountOptions" size="small" @change="onAmount" />
            <span class="cp-pal-hint">{{ tr("для плиток с ±") }}</span>
          </div>
        </div>
        <div class="cp-ex-scroll">
          <div v-if="!gen.groups.length" class="cp-pal-empty">{{ tr("Список рецептов не загрузился — команды текстом работают.") }}</div>
          <div v-for="g in gen.groups" :key="g.id" class="cp-ex-group">
            <div class="cp-ex-gtitle">{{ g.icon }} {{ g.title }}</div>
            <div class="cp-pal-grid">
              <div v-for="r in g.recipes" :key="r.id" class="cp-pal-tile" :class="{ lacking: !!r.lacks }">
                <!-- a recipe this mod has nothing to place for stays in the list, greyed out,
                     with the reason: silently missing it would look like a bug -->
                <button
                  class="cp-pal-main"
                  :disabled="sending || gen.busy || !!r.lacks"
                  :title="r.lacks ? `${tr(r.title)}: ${tr(r.lacks)}` : tr('Сгенерировать: {title}', { title: tr(r.title) })"
                  @click="runTile(r)"
                >
                  <span class="cp-pal-name">{{ tr(r.title) }}</span>
                  <span v-if="r.lacks" class="cp-pal-tune" aria-hidden="true">{{ tr("нет в моде") }}</span>
                  <span v-else-if="r.amountLabel" class="cp-pal-tune" :title="tr('Количество настраивается: {what}', { what: tr(r.amountLabel) })">±</span>
                </button>
                <button
                  v-if="r.stroke && !r.lacks"
                  class="cp-pal-draw"
                  :title="r.stroke === 'line' ? tr('Нарисовать линией: {title}', { title: tr(r.title) }) : tr('Нарисовать кистью: {title}', { title: tr(r.title) })"
                  :aria-label="tr('Нарисовать: {title}', { title: tr(r.title) })"
                  @click="drawTile(r)"
                >✎</button>
              </div>
            </div>
          </div>
        </div>
      </el-popover>

      <el-popover ref="exPop" :width="328" placement="top-start" trigger="click" popper-class="cp-ex-pop">
        <template #reference>
          <el-button ref="exBtn" class="cp-ico" text :icon="Reading" :title="tr('Примеры команд текстом')" />
        </template>
        <div class="cp-ex-head">
          {{ tr("Примеры — кликни, затем Enter") }}
          <div class="cp-ex-legend"><b class="cp-ex-mj">MJ</b> {{ tr("марковская (↻ — новый вид)") }} · <b class="cp-ex-llm">LLM</b> {{ tr("через агента") }} · <b>✎</b> {{ tr("по рисунку") }}</div>
        </div>
        <div class="cp-ex-scroll">
          <div v-for="g in displayExamples" :key="g.group" class="cp-ex-group">
            <div class="cp-ex-gtitle">{{ g.group }}</div>
            <button v-for="it in g.items" :key="it.text" class="cp-ex-item" @click="applyExample(it)">
              <span>{{ it.label }}</span>
              <span v-if="it.llm" class="cp-ex-llm">LLM</span>
              <span v-else-if="it.mj" class="cp-ex-mj">MJ</span>
            </button>
          </div>
        </div>
      </el-popover>

      <el-tooltip
        :content="LLM_AVAILABLE ? tr('LLM-режим — генерация через агента (иначе офлайн-роутер)') : tr('LLM-режим временно отключён')"
        placement="top"
        :show-after="300"
      >
        <!-- span-обёртка: disabled кнопка не шлёт события, тултип вешаем на обёртку -->
        <span>
          <el-button class="cp-ico" text :disabled="!LLM_AVAILABLE" :type="llmMode ? 'primary' : 'default'" @click="llmMode = !llmMode">🧠</el-button>
        </span>
      </el-tooltip>
      <el-tooltip :content="tr('Беречь рельеф — не перетирать воду и горы')" placement="top" :show-after="300">
        <el-button class="cp-ico" text :type="protect ? 'primary' : 'default'" @click="protect = !protect">🛡</el-button>
      </el-tooltip>
      <!-- Область генерации (взаимоисключающий фильтр; по умолчанию 👁 Экран) -->
      <el-tooltip :content="tr('👁 Экран — генерировать в видимую область (по умолчанию)')" placement="top" :show-after="300">
        <el-button class="cp-ico cp-mode" :class="{ pulse: areaPulse === 'screen' }" text :type="area === 'screen' ? 'primary' : 'default'" @click="setArea('screen')">👁<span v-if="area === 'screen' && visibleMaskLen" class="cp-badge">{{ visibleMaskLen }}</span></el-button>
      </el-tooltip>
      <el-tooltip :content="tr('⛶ Зона — обвести область на карте (прямоуг./кисть/полоса/рамка)')" placement="top" :show-after="300">
        <el-button class="cp-ico cp-mode" :class="{ pulse: areaPulse === 'zone' }" text :type="area === 'zone' ? 'primary' : 'default'" @click="setArea('zone')">⛶<span v-if="area === 'zone' && region" class="cp-badge">{{ region.w }}×{{ region.h }}</span></el-button>
      </el-tooltip>
      <el-tooltip :content="tr('📍 Точка — кликнуть клетку, генерировать вокруг неё')" placement="top" :show-after="300">
        <el-button class="cp-ico cp-mode" :class="{ pulse: areaPulse === 'point' }" text :type="area === 'point' ? 'primary' : 'default'" @click="setArea('point')">📍<span v-if="area === 'point' && region" class="cp-badge">{{ region.x }},{{ region.y }}</span></el-button>
      </el-tooltip>

      <el-input
        ref="inputRef"
        v-model="input"
        class="cp-input"
        :placeholder="placeholder"
        @focus="onFocus"
        @blur="onBlur"
        @input="markActive()"
        @keyup.enter="send()"
      />

      <el-tooltip :content="expanded ? tr('Скрыть лог') : tr('Показать лог команд')" placement="top" :show-after="300">
        <el-button
          class="cp-ico"
          text
          :icon="ChatLineSquare"
          :type="expanded ? 'primary' : 'default'"
          @click="toggleLog()"
        />
      </el-tooltip>
      <el-button
        class="cp-ico"
        text
        :icon="RefreshRight"
        :disabled="(!gen.session && !lastGen) || sending || gen.busy"
        :title="tr('Другой вариант (откатит текущий и сгенерит заново)')"
        @click="retry()"
      />
      <el-button
        class="cp-send"
        text
        :icon="Promotion"
        :disabled="!input.trim() || sending"
        :loading="sending"
        :title="tr('Отправить (Enter)')"
        @click="send()"
      />
      <el-button class="cp-ico cp-close" text :icon="Close" :title="tr('Скрыть ( / вернёт )')" @click="hide()" />
    </div>
  </div>
</template>

<style scoped>
.copilot-float {
  position: absolute;
  left: 50%;
  bottom: 34px; /* lifted off the very bottom (status bar) — was 16 */
  transform: translateX(-50%);
  /* size to the VIEWPORT, not the (panel-shrunk) canvas parent — otherwise a narrow canvas
   * crushes the 11-control row and leaves no room for the input. */
  width: min(680px, 92vw);
  z-index: 31; /* above the minimap dock (26) — the copilot is the front-most floater */
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none; /* let the canvas receive events except on our controls */
}
/* Log + hint stack, anchored to sit ABOVE the bar and grow UPWARD out of flow, so they never
   shift the bar (whatever the bar's own anchor — bottom by default, top once dragged). */
.cp-above {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 8px;
  pointer-events: none;
}
.cp-grip {
  pointer-events: auto;
  flex: 0 0 auto;
  cursor: grab;
  color: var(--el-text-color-secondary);
  opacity: 0.5;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  touch-action: none;
  transition: opacity 0.12s ease;
}
.cp-grip:hover { opacity: 1; }
.cp-grip:active { cursor: grabbing; }
.copilot-log,
.copilot-bar {
  pointer-events: auto;
  /* .d2-float supplies border/shadow/blur/radius; solid + opaque while in use,
   * fading to the frosted glass only when idle so it never obscures the map. */
  background: var(--el-bg-color);
  transition: background 0.35s ease;
}
.copilot-log.idle,
.copilot-bar.idle {
  background: var(--d2-glass-bg);
}
.copilot-log {
  max-height: 220px;
  overflow-y: auto;
  padding: 8px 12px;
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.cp-msg {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.45;
}
.cp-who {
  flex: 0 0 20px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  padding-top: 2px;
  color: var(--el-text-color-secondary);
}
.cp-text {
  /* preserve the "↳ reason" line breaks in validation failure details */
  white-space: pre-wrap;
  word-break: break-word;
}
.cp-msg.user .cp-text {
  color: var(--el-text-color-primary);
}
.cp-msg.assistant .cp-text {
  color: var(--el-text-color-regular);
}
.copilot-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px 8px;
  border-radius: 999px;
}
.cp-input {
  /* the input is the PRIMARY control — always keep it usable, never let the row of
   * icon toggles squeeze it to nothing (grows to fill, but never below 100px). */
  flex: 1 1 120px;
  min-width: 100px;
}
.cp-input :deep(.el-input__wrapper) {
  background: transparent;
  box-shadow: none;
  padding: 2px 4px;
}
.cp-input :deep(.el-input__inner) {
  color: var(--el-text-color-primary);
}
.cp-ico,
.cp-send {
  flex: 0 0 auto;
  /* compact the icon-only toggles: EP's default 15px side padding × 11 buttons is what
   * crowded the input out. Tighten to reclaim the width for the input. */
  min-width: 0;
  padding-left: 5px;
  padding-right: 5px;
  /* icon-only actions sit back until pointed at (calmer) */
  opacity: 0.6;
  transition: opacity 0.12s ease;
}
.cp-ico:hover,
.cp-send:hover,
.cp-ico.el-button--primary {
  opacity: 1;
}
.cp-badge {
  margin-left: 3px;
  font-size: 10px;
  opacity: 0.8;
}
/* one-time onboarding pulse on the «Примеры» button (first Copilot focus) */
.cp-examples.pulse {
  color: var(--el-color-primary);
  opacity: 1;
  animation: cpExPulse 0.85s ease-in-out 5;
}
@keyframes cpExPulse {
  0%, 100% { transform: scale(1); filter: none; }
  50% { transform: scale(1.28); filter: drop-shadow(0 0 6px var(--el-color-primary)); }
}
/* blink the area-mode button (👁/⛶/📍) when a command auto-switches the filter */
.cp-mode.pulse {
  color: var(--el-color-primary);
  opacity: 1;
  animation: cpModePulse 0.5s ease-in-out 3;
}
@keyframes cpModePulse {
  0%, 100% { transform: scale(1); filter: none; }
  50% { transform: scale(1.32); filter: drop-shadow(0 0 7px var(--el-color-primary)); }
}
.cp-close {
  color: var(--el-text-color-secondary);
}
.cp-zonehint {
  pointer-events: auto;
  align-self: stretch;
  padding: 8px 10px;
  font-size: 11px;
  color: var(--el-text-color-regular);
  background: var(--el-bg-color);
  transition: background 0.35s ease;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cp-zonehint.idle {
  background: var(--d2-glass-bg);
}
.cp-zrow {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cp-zlabel {
  font-weight: 600;
}
.cp-zhelp {
  color: var(--el-text-color-secondary);
  flex: 1;
}
.cp-zsel {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.cp-close {
  flex: 0 0 auto;
  cursor: pointer;
  color: var(--el-text-color-secondary);
  padding: 2px;
}
.cp-close:hover {
  color: var(--el-text-color-primary);
}
.cp-fade-enter-active,
.cp-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.cp-fade-enter-from,
.cp-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>

<!-- Unscoped: the examples popover is teleported to <body>, so scoped styles won't reach it. -->
<style>
.cp-ex-pop.el-popover.el-popper {
  padding: 8px;
  border-radius: 12px;
}
.cp-ex-head {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  padding: 2px 4px 6px;
}
.cp-ex-scroll {
  max-height: 320px;
  overflow-y: auto;
}
.cp-ex-group {
  margin-bottom: 6px;
}
.cp-ex-gtitle {
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  padding: 4px 4px 2px;
}
.cp-ex-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: var(--el-text-color-primary);
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 7px;
  cursor: pointer;
}
.cp-pal-where { margin-top: 4px; font-weight: 400; color: var(--el-text-color-regular); }
.cp-pal-amount { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-weight: 400; }
.cp-pal-hint { color: var(--el-text-color-secondary); font-size: 11px; }
.cp-pal-empty { padding: 10px 4px; color: var(--el-text-color-secondary); }
.cp-pal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.cp-pal-tile { display: flex; min-width: 0; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; overflow: hidden; }
.cp-pal-tile:hover { border-color: var(--el-color-primary); }
.cp-pal-tile.lacking:hover { border-color: var(--el-border-color-lighter); }
.cp-pal-main, .cp-pal-draw {
  border: 0;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 6px 8px;
}
.cp-pal-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; text-align: left; }
.cp-pal-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-pal-tune { color: var(--el-text-color-secondary); font-size: 11px; }
.cp-pal-draw { border-left: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); padding: 6px 7px; }
.cp-pal-main:hover:not(:disabled), .cp-pal-draw:hover { background: var(--el-fill-color); color: var(--el-color-primary); }
.cp-pal-main:disabled { opacity: 0.5; cursor: default; }
.cp-pal-main:focus-visible, .cp-pal-draw:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
.cp-ex-item:hover {
  background: var(--el-fill-color-light);
}
/* badges: soft fill instead of an outlined frame (fills, not borders) */
.cp-ex-llm {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 600;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border-radius: 5px;
  padding: 0 5px;
}
.cp-ex-mj {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 600;
  color: var(--el-color-success);
  background: var(--el-color-success-light-9);
  border-radius: 5px;
  padding: 0 5px;
}
.cp-ex-legend {
  margin-top: 5px;
  font-size: 10px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}
</style>
