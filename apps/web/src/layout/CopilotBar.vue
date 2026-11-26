<script setup lang="ts">
/**
 * Copilot — a light, frosted-glass floating command bar docked at the bottom-centre of the
 * canvas (NOT a panel): the editor's OMNIBAR. Type what you want, and a list above the input
 * shows what the bar understood BEFORE Enter runs it: a generation («озеро в центре»), a tool
 * («туман»), a menu command («сетка», «экспорт»), a cell to jump to («20 30») or an object to
 * find («найти столица»). The words are read by services/omnibar.ts — Russian, English and
 * Polish alike; this component turns a reading into an action through the stores.
 * The chat log floats above only while expanded (💬). "/" focuses the bar (viewStore
 * focusCopilot); the ✕ hides it (and "/" brings it back).
 *
 * Three ways to ask for a generation meet here and all go through genStore, so each gets the
 * same variant controls (GenResultStrip): a TILE of the generator palette (one click, no
 * typing), a typed COMMAND, and — from the tool dock — a stroke drawn «по рисунку».
 */
import { ref, nextTick, watch, onMounted } from "vue";
import { ElInput, ElPopover, ElSegmented, ElMessage } from "element-plus";
import { Promotion, Close, RefreshRight, Reading, ChatLineSquare, Grid, Menu as MenuIcon, Aim, Search, QuestionFilled } from "@element-plus/icons-vue";
import { computed } from "vue";
import type { Component } from "vue";
import type { GenRecipeInfo } from "@d2/socket-contract";
import type { MapDocument } from "@d2/map-schema";
import { cellToWorld } from "@d2/pixi-render";
import { useViewStore } from "../stores/viewStore";
import { useEditStore } from "../stores/editStore";
import { useToolStore } from "../stores/toolStore";
import { useCommandStore } from "../stores/commandStore";
import { AMOUNT_STEPS, useGenStore } from "../stores/genStore";
import { useFloatingDock } from "../composables/useFloatingDock";
import { getScene } from "../canvas/sceneHolder";
import { OBJ_ICONS } from "../services/refNames";
import {
  NO_AREA, interpret, nearest, parseArea, textMatches,
  type AmountStep, type CommandId, type Interpretation, type ParsedArea, type Side, type ToolId,
} from "../services/omnibar";
import { tr, trn } from "../i18n";
import { toolDef } from "./tools";
import GenResultStrip from "./GenResultStrip.vue";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

const view = useViewStore();
const editStore = useEditStore();
const toolStore = useToolStore();
const commands = useCommandStore();
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
    text: tr("Командная строка. Генерация: «озеро», «лес на севере», «побольше камней». Инструменты и меню: «туман», «сетка», «экспорт». Ещё: «найти столица», «клетка 20 30»."),
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
    : tr("что сделать: «озеро», «лес на севере», «туман», «сетка», «найти столица», «20 30»  ( / )"),
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
  dismissed.value = false; // the suggestions come back with the focus
  resetHighlight();
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
// из меню убраны — команда без пункта всё равно читается по словам.
// `text` is the COMMAND put into the input, in the interface language: the bar reads Russian,
// English and Polish alike, so an example's translation must read as the same command
// (test/omnibar.test.ts keeps the translations of these examples and checks just that).
const EXAMPLES: { group: string; items: { text: string; llm?: boolean; mj?: boolean; need?: "zone" }[] }[] = [
  { group: tr("🌊 Вода"), items: [
    { text: tr("озеро"), mj: true },
    { text: tr("озеро в центре"), mj: true },
    { text: tr("озеро вокруг этой точки 20x20"), mj: true },
    { text: tr("пруд 10x10"), mj: true },
    { text: tr("несколько озёр"), mj: true },
    { text: tr("острова 30x30"), mj: true },
    { text: tr("река"), mj: true },
    { text: tr("река по всей карте"), mj: true },
  ] },
  { group: tr("🌲 Лес"), items: [
    { text: tr("лес"), mj: true },
    { text: tr("густой лес"), mj: true },
    { text: tr("лес с полянами"), mj: true },
    { text: tr("редкий лес"), mj: true },
    { text: tr("сплошной лес") },
    { text: tr("роща вокруг этой точки 16x16"), mj: true },
    { text: tr("рощи по всей карте"), mj: true },
  ] },
  { group: tr("⛰️ Горы и холмы"), items: [
    { text: tr("горы 20x20"), mj: true },
    { text: tr("горная гряда"), mj: true },
    { text: tr("разбросай холмы"), mj: true },
    { text: tr("горы по краю 30x30") },
    { text: tr("горы вокруг этой точки 18x18"), mj: true },
  ] },
  { group: tr("🧱 Лабиринт"), items: [
    { text: tr("лабиринт"), mj: true },
    { text: tr("лабиринт 28x28"), mj: true },
    { text: tr("тонкий лабиринт"), mj: true },
    { text: tr("лабиринт из частокола"), mj: true },
  ] },
  { group: tr("❄️ Снег и трава"), items: [
    { text: tr("снег на севере") },
    { text: tr("снег пятнами"), mj: true },
    { text: tr("редкий снег"), mj: true },
    { text: tr("трава 20x20") },
    { text: tr("трава по всей карте") },
  ] },
  { group: tr("🛣 Дорога и декор"), items: [
    { text: tr("извилистая дорога"), mj: true },
    { text: tr("разбросай камни"), mj: true },
    { text: tr("побольше кустов"), mj: true },
    { text: tr("руины"), mj: true },
    { text: tr("кладбище 16x16"), mj: true },
  ] },
  { group: tr("✎ По рисунку (режим ⛶ Зона — проведи кистью/полосой, потом команду)"), items: [
    { text: tr("дорога"), need: "zone" },
    { text: tr("река"), need: "zone" },
    { text: tr("камни"), need: "zone" },
    { text: tr("кусты"), need: "zone" },
    { text: tr("руины"), need: "zone" },
  ] },
  { group: tr("🧭 Не только генерация"), items: [
    { text: tr("туман") },
    { text: tr("ластик") },
    { text: tr("сетка") },
    { text: tr("слой объектов") },
    { text: tr("отменить") },
    { text: tr("экспорт") },
    { text: tr("клетка 20 30") },
    { text: tr("найти столица") },
  ] },
  { group: tr("🗺️ Композиции — режим 🧠 LLM"), items: [
    { text: tr("озеро в центре, снег на севере, лес по южному краю"), llm: true },
    { text: tr("крепость: трава, водяной ров и стены вокруг центра"), llm: true },
    { text: tr("остров: вода по краям, горы и лес в центре"), llm: true },
    { text: tr("зимний север со снегом, лесистый юг, озёра в центре"), llm: true },
  ] },
];

/** The recipe each generation example is there to show (what its words mean when every recipe
 *  the bar knows exists). */
const EXAMPLE_RECIPES = new Map<string, string>();
for (const g of EXAMPLES) {
  for (const it of g.items) {
    const reading = it.llm ? undefined : interpret(it.text)[0];
    if (reading?.kind === "generate") EXAMPLE_RECIPES.set(it.text, reading.recipeId);
  }
}

/** Examples shown in the UI — drops the LLM-only items/groups when the bridge is disabled, and
 *  an example whose recipe the server no longer has (recipes come and go there: the words
 *  would be read as its nearest sibling, which is not what the example promises). */
const displayExamples = computed(() => {
  const catalogue = gen.catalog.length ? new Set(gen.catalog.map((r) => r.id)) : null;
  const shown = (it: { text: string; llm?: boolean }): boolean => {
    if (it.llm) return LLM_AVAILABLE;
    const recipe = EXAMPLE_RECIPES.get(it.text);
    return !catalogue || recipe === undefined || catalogue.has(recipe);
  };
  return EXAMPLES.map((g) => ({ ...g, items: g.items.filter(shown) })).filter((g) => g.items.length);
});

function regionCenter(r: Region): { x: number; y: number } {
  return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
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

/** How a zone was arrived at — the suggestions list says it in words. */
type How = "point" | "map" | "selection" | "size" | "center" | Side | "screen";
/** Where a command will generate, worked out from the area it names (parsed by
 *  services/omnibar.ts) and the bar's area mode. */
interface Plan {
  /** The area mode the command works in: 📍 for «тут / вокруг точки», 👁 when it names a
   *  place while the bar is in 📍, otherwise the current one. */
  mode: Area;
  /** Null: there is nowhere to generate yet (no cell clicked, no zone drawn). */
  zone: Zone | null;
  how: How | null;
  /** The cell a 📍 patch is centred on, and where it was taken from. */
  anchor?: { x: number; y: number; from: "selection" | "cursor" };
  /** The zone is cut down to its perimeter band («по краю»). */
  band: boolean;
}

/**
 * Plan the target zone — its bbox `region` + an optional cell `cells` mask — WITHOUT changing
 * anything, so the suggestions list can say what Enter will do and Enter then does exactly
 * that. Priority:
 *  1. 📍 point mode / «вокруг точки» — centre NxN (or POINT_DEFAULT) on the clicked cell, else
 *     on the cell under the cursor. «тут» with neither is no zone: the bar asks for a click.
 *  2. «по всей карте / везде» -> the WHOLE map (v1 silently generated on the visible screen).
 *  3. ⛶ an explicit drag selection — with its drawn mask (brush/line/frame).
 *  4. "NxM" centred on the map; «в центре» without a size -> a centred ~40% block.
 *  5. a direction («север/юг/запад/восток») -> half the map.
 *  6. 👁 screen -> the EXACT visible cells (diamond mask), so it matches what you see.
 * «по краю/периметру/рамкой» turns the resolved region into its perimeter-band cell mask.
 *
 * `follow`: let the command's words pick the area mode (a typed command does; a palette tile
 * and the LLM mode keep the mode the bar is in). `dry`: the list only needs the outline — skip
 * the cell masks (the visible screen is thousands of cells, and the list is rebuilt as the
 * pointer moves).
 */
function planZone(a: ParsedArea, size: number, opts: { follow?: boolean; dry?: boolean } = {}): Plan {
  const follow = opts.follow ?? true;
  let mode = area.value;
  let sel = toolStore.region;
  let eye = toolStore.eyeZone;
  if (follow && a.where === "point") mode = "point";
  else if (follow && a.where && mode === "point") {
    // a named place is the more explicit intent: back to 👁, which drops the clicked point
    mode = "screen";
    sel = null;
    eye = true;
  }
  const base = planBase(a, size, mode, sel, eye, !!opts.dry);
  if (!base) return { mode, zone: null, how: null, band: false };
  // frame intent: keep the region, clip generation to its perimeter band. A HAND-DRAWN ⛶
  // mask wins (the drawing IS the shape); the 👁 eye's derived diamond mask does NOT — else
  // a bare «горы по краю» in the default screen mode skipped the band and mountain_fill
  // flooded the whole visible screen. Eye cells are intersected so the band stays visible.
  const band = a.frame && !(sel && toolStore.regionMask?.length);
  let zone = base.zone;
  if (band && !opts.dry) {
    const cells = frameCells(zone.region, size);
    if (!zone.cells) zone = { region: zone.region, cells };
    else {
      const visible = new Set(zone.cells.map(([x, y]) => `${x},${y}`));
      const clipped = cells.filter(([x, y]) => visible.has(`${x},${y}`));
      zone = { region: zone.region, cells: clipped.length ? clipped : cells };
    }
  }
  return { mode, zone, how: base.how, anchor: base.anchor, band };
}
function planBase(
  a: ParsedArea, size: number, mode: Area, sel: Region | null, eye: boolean, dry: boolean,
): { zone: Zone; how: How; anchor?: Plan["anchor"] } | null {
  const clamp = (n: number): number => Math.max(2, Math.min(n, size));
  const anchor: Plan["anchor"] = sel
    ? { ...regionCenter(sel), from: "selection" }
    : view.cursorCell
      ? { x: view.cursorCell.x, y: view.cursorCell.y, from: "cursor" }
      : undefined;

  // 1) POINT: the 📍 mode, an explicit «вокруг точки», or a 1×1 selection + a size. Size = the
  //    command's NxN, else POINT_DEFAULT (so a bare «озеро» in 📍 mode isn't a single cell).
  const pointIntent = mode === "point" || a.where === "point" || (!!a.size && !!sel && sel.w <= 2 && sel.h <= 2);
  if (pointIntent && anchor) {
    const w = clamp(a.size?.w ?? POINT_DEFAULT), h = clamp(a.size?.h ?? POINT_DEFAULT);
    const x = Math.max(0, Math.min(anchor.x - Math.floor(w / 2), size - w));
    const y = Math.max(0, Math.min(anchor.y - Math.floor(h / 2), size - h));
    return { zone: { region: { x, y, w, h }, cells: null }, how: "point", anchor };
  }
  // «тут» with no cell to stand on: nothing to generate in yet (v1 fell through and put a
  // sized «озеро тут 20x20» in the centre of the map while asking to click a cell)
  if (a.where === "point") return null;
  // 2) «по всей карте / везде» — the WHOLE map, even over a drawn selection (the words are
  //    the more explicit intent). v1 silently generated on the visible screen, so «трава по
  //    всей карте» cleaned a screenful and left the rest untouched.
  if (a.where === "map") return { zone: { region: { x: 0, y: 0, w: size, h: size }, cells: null }, how: "map" };
  // 3) an explicit drag selection (+ its drawn mask)
  if (sel) {
    return { zone: { region: sel, cells: dry ? null : toPairs(toolStore.regionMask), drawn: !!toolStore.regionMask?.length }, how: "selection" };
  }
  // 4) "NxM" centred; «в центре» without a size = a centred ~40% block (v1 ignored the word
  //    and filled the whole screen)
  if (a.size) {
    const w = clamp(a.size.w), h = clamp(a.size.h);
    return { zone: { region: { x: Math.floor((size - w) / 2), y: Math.floor((size - h) / 2), w, h }, cells: null }, how: "size" };
  }
  if (a.where === "center") {
    const w = clamp(Math.round(size * 0.4));
    return { zone: { region: { x: Math.floor((size - w) / 2), y: Math.floor((size - w) / 2), w, h: w }, cells: null }, how: "center" };
  }
  // 5) direction halves
  const half = Math.floor(size / 2);
  if (a.where === "north") return { zone: { region: { x: 0, y: 0, w: size, h: half }, cells: null }, how: "north" };
  if (a.where === "south") return { zone: { region: { x: 0, y: size - half, w: size, h: half }, cells: null }, how: "south" };
  if (a.where === "west") return { zone: { region: { x: 0, y: 0, w: half, h: size }, cells: null }, how: "west" };
  if (a.where === "east") return { zone: { region: { x: size - half, y: 0, w: half, h: size }, cells: null }, how: "east" };
  // 6) 👁 eye: the exact visible cells (diamond mask), bbox as the region
  if (eye && view.visibleCells) return { zone: { region: view.visibleCells, cells: dry ? null : toPairs(view.visibleMask) }, how: "screen" };
  return null;
}

/** A plan in words, for the suggestions list. */
function whereText(p: Plan): string {
  if (!p.zone) {
    if (p.mode === "point") return tr("📍 точка не выбрана — кликни клетку на карте");
    if (p.mode === "zone") return tr("⛶ зона не обведена — обведи область на карте");
    return tr("👁 карта не видна на экране");
  }
  const { w, h } = p.zone.region;
  switch (p.how) {
    case "point":
      return p.anchor?.from === "cursor"
        ? tr("📍 вокруг курсора — {w}×{h}", { w, h })
        : tr("📍 вокруг клетки {x}, {y} — {w}×{h}", { x: p.anchor?.x ?? 0, y: p.anchor?.y ?? 0, w, h });
    case "map": return tr("вся карта — {w}×{h}", { w, h });
    case "selection":
      return regionMask.value?.length ? trn("⛶ в обведённой зоне — {n} кл.", regionMask.value.length) : tr("⛶ в обведённой зоне — {w}×{h}", { w, h });
    case "size":
    case "center": return tr("в центре карты — {w}×{h}", { w, h });
    case "north": return tr("северная половина карты");
    case "south": return tr("южная половина карты");
    case "west": return tr("западная половина карты");
    case "east": return tr("восточная половина карты");
    default: return tr("👁 на всём, что видно на экране");
  }
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
    const zone = editStore.liveDoc ? planZone(parseArea(text), editStore.liveDoc.size, { follow: false }).zone : null;
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

// --- the suggestions list: what the bar understood, before Enter ---------------------------

/** One row of the list: what would happen. */
interface Row {
  key: string;
  icon: string | Component;
  title: string;
  /** Dimmer: what exactly will happen — or, on a row that cannot run, why not. */
  detail: string;
  disabled?: boolean;
  /** A «type this…» row: it puts the text into the input instead of doing something. */
  fill?: string;
  /** It generates, so it waits while another generation is running. */
  generates?: boolean;
  /** `typed`: the line it was run from (empty for a row of the starter list). */
  run?: (typed: string) => void | Promise<void>;
}
const MAX_ROWS = 6;

type GenReading = { recipeId: string; area: ParsedArea; amount: AmountStep };

const AMOUNT_WORDS: Record<number, string> = {
  [-2]: tr("намного меньше"), [-1]: tr("меньше"), 1: tr("больше"), 2: tr("намного больше"),
};
/** The amount «побольше / чуть…» stands for — only where the recipe's amount can be tuned. */
function amountFor(g: GenReading): AmountStep {
  return gen.infoOf(g.recipeId)?.amountLabel ? g.amount : 0;
}

function genRow(g: GenReading): Row {
  const info = gen.infoOf(g.recipeId);
  const base = { key: `g:${g.recipeId}`, icon: gen.iconOf(g.recipeId), title: gen.titleOf(g.recipeId), generates: true };
  // a recipe this mod has nothing to place for stays in the list, greyed out, with the reason
  if (info?.lacks) return { ...base, detail: tr(info.lacks), disabled: true };
  const doc = editStore.liveDoc;
  if (!doc) return { ...base, detail: tr("Карта не загружена."), disabled: true };
  const plan = planZone(g.area, doc.size, { dry: true });
  const parts = [whereText(plan)];
  if (plan.zone && plan.band) parts.push(tr("по краю"));
  const amount = AMOUNT_WORDS[amountFor(g)];
  if (amount) parts.push(amount);
  return { ...base, detail: parts.join(" · "), run: (typed) => runGenerate(g, typed) };
}

function toolRow(id: ToolId): Row {
  const def = toolDef(id);
  return {
    key: `t:${id}`,
    icon: def?.icon ?? "🖌",
    title: tr("Инструмент: {name}", { name: def?.label ?? id }),
    detail: toolStore.tool === id ? tr("уже выбран") : def?.hint ?? "",
    run: () => runTool(id),
  };
}

/** The menu commands as the list names them: the menu's own words, the menu they are in,
 *  for a switch — whether it is on now, and for undo / redo — whether there is anything to. */
const COMMAND_ROWS: Record<CommandId, { title: string; menu: string; on?: () => boolean; blocked?: () => string | null }> = {
  "file:open": { title: tr("Открыть карту…"), menu: tr("Файл") },
  "file:new": { title: tr("Новая карта…"), menu: tr("Файл") },
  "file:upload": { title: tr("Загрузить .sg…"), menu: tr("Файл") },
  "file:export": { title: tr("Экспорт карты…"), menu: tr("Файл") },
  "file:passport": { title: tr("Паспорт карты…"), menu: tr("Файл") },
  "edit:undo": { title: tr("Отменить"), menu: tr("Правка"), blocked: () => (editStore.undoable ? null : tr("нечего отменять")) },
  "edit:redo": { title: tr("Вернуть"), menu: tr("Правка"), blocked: () => (editStore.redoable ? null : tr("нечего возвращать")) },
  "edit:validate": { title: tr("Проверить карту"), menu: tr("Правка") },
  "view:terrain": { title: tr("Слой рельефа"), menu: tr("Вид"), on: () => view.terrainVisible },
  "view:objects": { title: tr("Слой объектов"), menu: tr("Вид"), on: () => view.objectsVisible },
  "view:grid": { title: tr("Сетка"), menu: tr("Вид"), on: () => view.gridVisible },
  "view:locations": { title: tr("Слой локаций"), menu: tr("Вид"), on: () => view.locationsVisible },
  "view:animate": { title: tr("Анимация"), menu: tr("Вид"), on: () => view.animate },
  "view:objectPanel": { title: tr("Панель объектов"), menu: tr("Вид"), on: () => view.objectPanelVisible },
  "view:eventPanel": { title: tr("Сценарий (события)"), menu: tr("Вид"), on: () => view.eventPanelVisible },
  "view:anchors": { title: tr("Связи (якоря ⚓)"), menu: tr("Вид"), on: () => view.anchorsVisible },
  "view:roles": { title: tr("Роли локаций"), menu: tr("Вид"), on: () => view.rolesVisible },
  "view:minimap": { title: tr("Миникарта"), menu: tr("Вид"), on: () => view.minimapVisible },
  "view:fit": { title: tr("К размеру окна"), menu: tr("Вид") },
  "view:appearance": { title: tr("Тёмная тема"), menu: tr("Вид"), on: () => view.dark },
  "help:keys": { title: tr("Горячие клавиши…"), menu: tr("Справка") },
  "help:commands": { title: tr("Командная строка и генераторы…"), menu: tr("Справка") },
};

function commandRow(id: CommandId): Row {
  const c = COMMAND_ROWS[id];
  const blocked = c.blocked?.() ?? null;
  const parts = [c.menu];
  if (blocked) parts.push(blocked);
  else if (c.on) parts.push(c.on() ? tr("сейчас включено — выключить") : tr("сейчас выключено — включить"));
  // the menu owns the action (and its own guards): ask it, as if the item were picked there
  return { key: `c:${id}`, icon: MenuIcon, title: c.title, detail: parts.join(" · "), disabled: !!blocked, run: () => commands.run(id) };
}

function cellRow(x: number, y: number): Row {
  const base = { key: "cell", icon: Aim, title: tr("Перейти к клетке {x}, {y}", { x, y }) };
  const size = editStore.liveDoc?.size;
  if (size === undefined) return { ...base, detail: tr("Карта не загружена."), disabled: true };
  if (x >= size || y >= size) return { ...base, detail: tr("такой клетки нет — карта {n}×{n}", { n: size }), disabled: true };
  return { ...base, detail: tr("показать её в центре экрана"), run: () => goToCell(x, y) };
}

type MapObject = MapDocument["objects"][number];
/** What an object is, where the list says so (the inspector's words). */
const OBJECT_KINDS: Record<string, string> = {
  capital: tr("Столица"), village: tr("Город"), ruin: tr("Руина"), merchant: tr("Торговец"), mage: tr("Маг"),
  trainer: tr("Тренер"), mercenary: tr("Наёмники"), resourceMarket: tr("Рынок ресурсов"), landmark: tr("Декор"),
  location: tr("Локация"), stack: tr("Отряд"), treasure: tr("Сундук"),
};
/** The objects whose name — or, after those, description — contains the query. */
function findObjects(query: string): MapObject[] {
  const named: MapObject[] = [], described: MapObject[] = [];
  for (const o of editStore.liveDoc?.objects ?? []) {
    const t = o as { name?: string; desc?: string };
    if (textMatches(query, t.name)) named.push(o);
    else if (textMatches(query, t.desc)) described.push(o);
  }
  return [...named, ...described];
}
function objectRow(o: MapObject): Row {
  const t = o as { name?: string; desc?: string };
  return {
    key: `o:${o.id}`,
    icon: OBJ_ICONS[o.type] ?? "📍",
    title: t.name || t.desc || o.id,
    detail: `${OBJECT_KINDS[o.type] ?? o.type} · ${o.pos.x}, ${o.pos.y}`,
    // the canvas centres on it, selects it and blinks it (the same path as a link to an object)
    run: () => { toolStore.focusObjectId = o.id; },
  };
}

const CELL_EXAMPLE = tr("клетка 20 30");
const FIND_EXAMPLE = tr("найти столица");
/** The first word of an example and a space: what a «type this…» row puts into the input. */
const firstWord = (example: string): string => `${example.split(" ")[0]} `;

/** Empty input: a few things of each kind the bar can do. */
function starterRows(): Row[] {
  const rows: Row[] = [];
  for (const recipeId of ["water_lake", "relief_ridge"]) {
    if (gen.infoOf(recipeId)) rows.push(genRow({ recipeId, area: NO_AREA, amount: 0 }));
  }
  rows.push(toolRow("fog"), commandRow("view:grid"));
  rows.push({ key: "s:cell", icon: Aim, title: tr("Перейти к клетке"), detail: tr("набери, например: {example}", { example: CELL_EXAMPLE }), fill: firstWord(CELL_EXAMPLE) });
  rows.push({ key: "s:find", icon: Search, title: tr("Найти объект по названию"), detail: tr("набери, например: {example}", { example: FIND_EXAMPLE }), fill: firstWord(FIND_EXAMPLE) });
  return rows;
}

function rowOf(i: Interpretation): Row | null {
  switch (i.kind) {
    case "generate": return genRow(i);
    case "tool": return toolRow(i.tool);
    case "command": return commandRow(i.command);
    case "goto": return cellRow(i.x, i.y);
    case "find": return null; // «найти …» becomes a row per object found
  }
}
const isRow = (r: Row | null): r is Row => r !== null;

interface Suggestion {
  /** A line above the rows saying what they are; empty when the rows speak for themselves. */
  caption: string;
  rows: Row[];
  /** The rows are readings of the typed line, so Enter runs the first. Offers (the starter
   *  list, the nearest things to a line that was not understood) run only when picked. */
  understood: boolean;
}

const suggestion = computed<Suggestion>(() => {
  const text = input.value.trim();
  const offer = (caption: string): Suggestion => ({ caption, rows: starterRows(), understood: false });
  if (!text) return offer(tr("Что можно сделать — выбери или начни печатать"));
  // only what the server can generate (a recipe may be dropped there); before the catalogue
  // has loaded, everything the bar knows the words for
  const options = gen.catalog.length ? { recipes: gen.catalog.map((r) => r.id) } : {};
  const readings = interpret(text, options);
  const rows: Row[] = [];
  let caption = "";

  // «найти …»: a row per object found. Whatever else the words could mean stays below as an
  // offer — a line that asks to FIND something never generates on a bare Enter.
  const find = readings.find((i): i is Extract<Interpretation, { kind: "find" }> => i.kind === "find");
  if (find) {
    const found = find.query ? findObjects(find.query) : [];
    if (!find.query) caption = tr("Найти объект: допиши название, например: {example}", { example: FIND_EXAMPLE });
    else if (!found.length) caption = tr("Найти «{query}»: на карте такого нет", { query: find.query });
    else if (found.length > MAX_ROWS) caption = trn("Найти «{query}»: {n} объект, показаны первые {shown}|Найти «{query}»: {n} объекта, показаны первые {shown}|Найти «{query}»: {n} объектов, показаны первые {shown}", found.length, { query: find.query, shown: MAX_ROWS });
    else caption = trn("Найти «{query}»: {n} объект|Найти «{query}»: {n} объекта|Найти «{query}»: {n} объектов", found.length, { query: find.query });
    rows.push(...found.slice(0, MAX_ROWS).map(objectRow), ...readings.map(rowOf).filter(isRow));
    return { caption, rows: rows.slice(0, MAX_ROWS), understood: found.length > 0 };
  }
  rows.push(...readings.map(rowOf).filter(isRow));

  // no reading is never a dead end: the line may only say how / where / how much so far
  // («редкий…», «на севере…») — then what goes with that; or a word is misspelt — then the
  // nearest things; or else what the bar can do at all. (A line of a letter or two is just
  // not typed yet: no «не понял» for it.)
  if (!rows.length) {
    if (text.length < 3) return offer(tr("Что можно сделать — выбери или начни печатать"));
    const offers = nearest(text, options, MAX_ROWS);
    const offered = offers.map(rowOf).filter(isRow);
    if (!offered.length) return offer(tr("Не понял «{text}». Вот что можно:", { text }));
    caption = offers[0]?.match === "open" ? tr("Что именно? Например:") : tr("Не понял «{text}». Может быть, это:", { text });
    return { caption, rows: offered, understood: false };
  }

  // room left under a generation: its sibling recipes, for the same place
  const top = readings[0];
  if (top?.kind === "generate") {
    const group = gen.infoOf(top.recipeId)?.group;
    for (const r of gen.catalog) {
      if (rows.length >= MAX_ROWS) break;
      if (r.group === group && !rows.some((row) => row.key === `g:${r.id}`)) rows.push(genRow({ recipeId: r.id, area: top.area, amount: 0 }));
    }
  }
  return { caption, rows: rows.slice(0, MAX_ROWS), understood: true };
});

/** The highlighted row; −1 = none (an offer is not run by a bare Enter). */
const highlighted = ref(-1);
/** Back to where the highlight starts: the first reading of the line, or nothing on a list of offers. */
function resetHighlight(): void {
  highlighted.value = suggestion.value.understood ? 0 : -1;
}
/** Esc closed the list; typing or focusing the input brings it back. */
const dismissed = ref(false);
const listShown = computed(() =>
  inputFocused.value && !dismissed.value && !(llmMode.value && LLM_AVAILABLE)
  && (suggestion.value.rows.length > 0 || !!suggestion.value.caption),
);
watch(input, resetHighlight);

function onInput(): void {
  dismissed.value = false;
  markActive();
}

/** ↑/↓ move the highlight, Enter runs it (the first reading by default), Esc closes the list. */
function onKeydown(e: KeyboardEvent | Event): void {
  if (!(e instanceof KeyboardEvent) || e.isComposing) return;
  if (e.key === "Enter") {
    e.preventDefault();
    if (!e.repeat) void send();
    return;
  }
  if (llmMode.value && LLM_AVAILABLE) return;
  const n = suggestion.value.rows.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!n) return;
    e.preventDefault();
    if (!listShown.value) { dismissed.value = false; return; } // first bring the list back
    const step = e.key === "ArrowDown" ? 1 : -1;
    highlighted.value = highlighted.value < 0 ? (step > 0 ? 0 : n - 1) : (highlighted.value + step + n) % n;
  } else if (e.key === "Escape" && listShown.value) {
    e.preventDefault();
    e.stopPropagation(); // this Esc closes the list — not whatever else listens for it
    dismissed.value = true;
  }
}

/** Run a row of the list (Enter on it, or a click). */
async function runRow(row: Row): Promise<void> {
  markActive();
  if (row.fill !== undefined) {
    input.value = row.fill;
    dismissed.value = false;
    void nextTick(() => inputRef.value?.focus());
    return;
  }
  if (row.disabled || !row.run) {
    notify(`${row.title} — ${row.detail}`, "warning");
    return;
  }
  if (row.generates && (sending.value || gen.busy)) return;
  const typed = input.value.trim();
  log.value.push({ role: "user", text: typed || row.title });
  input.value = "";
  dismissed.value = true;
  highlighted.value = -1; // a row picked from the starter list must not stay armed for the next Enter
  await row.run(typed);
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (sending.value) return;

  if (llmMode.value && LLM_AVAILABLE) {
    if (!text) return;
    markActive();
    log.value.push({ role: "user", text });
    input.value = "";
    await sendLlm(text);
    return;
  }

  const { rows, understood } = suggestion.value;
  const row = rows[highlighted.value >= 0 ? Math.min(highlighted.value, rows.length - 1) : understood ? 0 : -1];
  if (row) {
    await runRow(row);
    return;
  }
  if (!text) return;
  // nothing to run: the list says what was not understood and what is close — show it
  dismissed.value = false;
  void nextTick(() => inputRef.value?.focus());
}

/** A typed generation: the area mode follows the command's words, then generate. */
async function runGenerate(g: GenReading, typed: string): Promise<void> {
  const doc = editStore.liveDoc;
  if (!doc) {
    notify(tr("Карта не загружена."), "warning");
    return;
  }
  // Auto-select the area filter the command implies («тут» → 📍, a named place while in 📍 →
  // 👁); a generic command keeps the current mode (respect a drawn ⛶ zone).
  const plan = planZone(g.area, doc.size);
  // «тут» with no cell clicked and the pointer off the map: 📍 asks for the click
  const asksForClick = plan.mode === "point" && plan.mode !== area.value && !plan.zone;
  if (plan.mode !== area.value) {
    setArea(plan.mode, { auto: asksForClick });
    if (!asksForClick) pulseArea(plan.mode);
  }
  if (!plan.zone) {
    input.value = typed; // keep the command: once there is an area, Enter runs it
    if (!asksForClick) explainNoZone();
    return;
  }
  const amount = amountFor(g);
  await generateIn(g.recipeId, plan.zone, amount ? AMOUNT_STEPS[2 + amount] : undefined);
}

function runTool(id: ToolId): void {
  // a dock tool takes the clicks on the map, so the bar stops waiting for a ⛶ zone / 📍 point
  if (area.value !== "screen") setArea("screen");
  toolStore.setTool(id);
}

/** Show a cell: centred, at 100% (as a link to an object opens), marked until the pointer moves. */
function goToCell(x: number, y: number): void {
  const scene = getScene();
  if (!scene) return;
  const w = cellToWorld(x + 0.5, y + 0.5);
  scene.setCursorCell({ x, y });
  scene.focusOn(w.x, w.y, 1);
}

/** Mode-aware dead-end hint: there is no area to generate in yet. */
function explainNoZone(): void {
  if (area.value === "point") notify(tr("📍 Точка — кликни клетку на карте, потом повтори."), "warning");
  else if (area.value === "zone") notify(tr("⛶ Зона — обведи область на карте, потом повтори."), "warning");
  else notify(tr("Не понял область. Наведи карту (👁 Экран) или выбери ⛶ Зона / 📍 Точка, либо укажи размер («25x25») / сторону («север»)."), "warning");
}

/** Generate `recipeId` in `zone` as a new session of variants, and say what came of it.
 *  `amount`: how much of it, when the command said («побольше»); else the palette's amount. */
async function generateIn(recipeId: string, zone: Zone, amount?: number): Promise<void> {
  const { region, cells } = zone;
  sending.value = true;
  const t0 = performance.now();
  try {
    const rep = await gen.run({ recipeId, region, cells, stroke: !!zone.drawn, protect: protect.value }, amount === undefined ? {} : { amount });
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
  const zone = planZone(NO_AREA, doc.size, { follow: false }).zone;
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

/** Fill the input from an example, and AUTO-SELECT the area filter a generation needs
 *  (👁 screen / ⛶ zone / 📍 point) — the button pulses so the switch is visible. The list
 *  above the input then shows what Enter will do. */
function applyExample(ex: { text: string; llm?: boolean; need?: "zone" }): void {
  input.value = ex.text;
  if (ex.llm) llmMode.value = true;
  examplesOpen.value = false;
  (exPop.value as unknown as { hide?: () => void } | null)?.hide?.();
  // «…вокруг этой точки» wants 📍, a ✎ example draws in ⛶, any other generation runs on 👁;
  // a tool, a menu command, a cell or a search has no area to choose
  const generates = ex.llm || ex.need || interpret(ex.text)[0]?.kind === "generate";
  if (generates) setArea(ex.need ?? (parseArea(ex.text).where === "point" ? "point" : "screen"), { auto: true });
  dismissed.value = false;
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

    <!-- what the bar understood, BEFORE Enter: right above the input. mousedown.prevent keeps
         the focus in the input (a blur would close the list before the click lands);
         mousemove, not mouseenter, so a list opening under a resting pointer steals no
         highlight — and a pointer that leaves gives the highlight back to the first reading -->
    <div
      v-if="listShown"
      id="cp-suggest"
      class="cp-suggest d2-float"
      role="listbox"
      :aria-label="tr('Что понял копайлот')"
      @mousedown.prevent
      @mouseleave="resetHighlight()"
    >
      <div v-if="suggestion.caption" class="cp-sg-cap">{{ suggestion.caption }}</div>
      <button
        v-for="(r, i) in suggestion.rows"
        :key="r.key"
        type="button"
        tabindex="-1"
        class="cp-sg-row"
        :class="{ active: i === highlighted, off: r.disabled }"
        role="option"
        :aria-selected="i === highlighted"
        :aria-disabled="!!r.disabled"
        :title="r.detail ? `${r.title} — ${r.detail}` : r.title"
        @mousemove="highlighted = i"
        @click="runRow(r)"
      >
        <span class="cp-sg-ico" aria-hidden="true">
          <template v-if="typeof r.icon === 'string'">{{ r.icon }}</template>
          <el-icon v-else><component :is="r.icon" /></el-icon>
        </span>
        <span class="cp-sg-title">{{ r.title }}</span>
        <span class="cp-sg-detail">{{ r.detail }}</span>
        <span v-if="i === highlighted" class="cp-sg-enter" aria-hidden="true">↵</span>
      </button>
    </div>
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
              <span>{{ it.text }}</span>
              <span v-if="it.llm" class="cp-ex-llm">LLM</span>
              <span v-else-if="it.mj" class="cp-ex-mj">MJ</span>
            </button>
          </div>
        </div>
      </el-popover>

      <el-button class="cp-ico" text :icon="QuestionFilled" :title="tr('Что умеет строка: все генераторы с картинками и команды')"
        :aria-label="tr('Что умеет строка: все генераторы с картинками и команды')" @click="view.setCommandHelp(true)" />

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
        autocomplete="off"
        aria-autocomplete="list"
        aria-controls="cp-suggest"
        @focus="onFocus"
        @blur="onBlur"
        @input="onInput"
        @keydown="onKeydown"
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
/* the suggestions list: what the bar understood, right above the input */
.cp-suggest {
  pointer-events: auto;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px;
  background: var(--el-bg-color);
}
.cp-sg-cap {
  padding: 3px 8px 2px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cp-sg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
  padding: 4px 8px;
  cursor: pointer;
}
.cp-sg-row.active {
  background: var(--el-fill-color);
}
.cp-sg-row.off {
  cursor: default;
}
.cp-sg-row.off .cp-sg-ico,
.cp-sg-row.off .cp-sg-title {
  opacity: 0.5;
}
.cp-sg-ico {
  flex: 0 0 18px;
  display: inline-flex;
  justify-content: center;
}
.cp-sg-title {
  flex: 0 1 auto;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cp-sg-detail {
  flex: 1 1 0;
  min-width: 0;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cp-sg-enter {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--el-text-color-secondary);
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
