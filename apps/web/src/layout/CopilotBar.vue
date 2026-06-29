<script setup lang="ts">
/**
 * Copilot — a light, frosted-glass floating command input docked at the bottom-centre of
 * the canvas (NOT a panel). Just a field: type a command, Enter to send. The chat log
 * floats above only while expanded (on focus / after a message). "/" focuses it (viewStore
 * focusCopilot); the ✕ hides it (and "/" brings it back). STUB responder for now (M6).
 */
import { ref, nextTick, watch } from "vue";
import { ElInput, ElPopover, ElSegmented } from "element-plus";
import { Promotion, Close, RefreshRight, Reading } from "@element-plus/icons-vue";
import { computed } from "vue";
import { useViewStore } from "../stores/viewStore";
import { useEditStore } from "../stores/editStore";
import { useToolStore } from "../stores/toolStore";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

const view = useViewStore();
const editStore = useEditStore();
const toolStore = useToolStore();

const zoneActive = computed(() => toolStore.tool === "region");
const region = computed(() => toolStore.region);

/** Toggle the "select zone" mode: on -> region tool; off -> back to select + clear zone. */
function toggleZone(): void {
  if (zoneActive.value) {
    toolStore.setRegion(null);
    toolStore.setTool("select");
  } else {
    toolStore.setTool("region");
  }
}
const input = ref("");
const expanded = ref(false);
const inputRef = ref<InstanceType<typeof ElInput> | null>(null);
const scroller = ref<HTMLElement | null>(null);
const log = ref<Msg[]>([
  {
    role: "assistant",
    text: "Copilot (превью). Скоро: «залей водой», «добавь горы слева», «выдели участок и перегенерируй».",
  },
]);

const sending = ref(false);
/** LLM mode (Phase-4 POC): route the command through the server's LLM file-bridge instead
 *  of the offline keyword router. Off by default (keyword router needs no agent watching). */
const llmMode = ref(false);
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
  if (!d) return `${clientMs}мс`;
  let s = `${d.opCount} кл · сервер ${d.serverMs}мс / всего ${clientMs}мс`;
  if (d.protect) s += ` · 🛡 ${d.protectedInRegion ?? 0} сохранено`;
  if (!d.validation.ok) {
    const bad = [
      !d.validation.identity && "identity",
      !d.validation.semantic && "semantic",
      !d.validation.structural && "structural",
    ].filter(Boolean).join("/");
    s += ` · ⚠ валидация: ${bad}`;
  }
  return s;
}

const placeholder = computed(() =>
  llmMode.value
    ? "🧠 опиши, что сгенерировать: «озеро на севере и гряда гор по диагонали»  ( / )"
    : "напр. «озеро», «река», «лабиринт», «озеро вокруг этой точки 20x20»  ( / )",
);

/** The last successful generation, so "↻ другой вариант" can roll it back and re-roll. */
const lastGen = ref<{ mode: "keyword" | "llm"; text: string; recipeId?: string; region?: Region; cells?: [number, number][] | null; protect?: boolean } | null>(null);

// --- zone drawing controls (mode / size / hide / accept) ---------------------
const zoneMode = computed(() => toolStore.zoneMode);
const regionMask = computed(() => toolStore.regionMask);
const zoneHidden = computed(() => toolStore.zoneHidden);
const eyeActive = computed(() => toolStore.eyeZone);
const visibleMaskLen = computed(() => view.visibleMask?.length ?? null);
function toggleEye(): void {
  markActive();
  toolStore.setEyeZone(!toolStore.eyeZone);
}
function onFocus(): void {
  expanded.value = true;
  inputFocused.value = true;
  markActive();
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
    case "brush": return "рисуй кистью по карте";
    case "line": return "протяни полосу";
    case "frame": return "растяни рамку (только контур)";
    default: return "растяни прямоугольник, или кликни точку";
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
const EXAMPLES: { group: string; items: { text: string; llm?: boolean; mj?: boolean }[] }[] = [
  { group: "🌊 Вода", items: [
    { text: "озеро в центре", mj: true },
    { text: "озеро", mj: true },
    { text: "большое озеро 30x30", mj: true },
    { text: "озеро вокруг этой точки 20x20", mj: true },
    { text: "пруд", mj: true },
    { text: "несколько озёр", mj: true },
    { text: "архипелаг островов", mj: true },
    { text: "река", mj: true },
    { text: "ручей через всю карту", mj: true },
  ] },
  { group: "🌲 Лес", items: [
    { text: "лес", mj: true },
    { text: "рощи по всей карте", mj: true },
    { text: "чаща", mj: true },
    { text: "разбросай деревья", mj: true },
    { text: "редкий лес", mj: true },
    { text: "лес с полянами", mj: true },
    { text: "густой лес вокруг этой точки 24x24", mj: true },
  ] },
  { group: "⛰️ Горы и холмы", items: [
    { text: "горная гряда", mj: true },
    { text: "хребет по диагонали", mj: true },
    { text: "разбросай холмы", mj: true },
    { text: "редкие горы", mj: true },
    { text: "горы по краю", mj: true },
    { text: "горный массив 24x24", mj: true },
    { text: "скалы вокруг этой точки 18x18", mj: true },
  ] },
  { group: "🧱 Лабиринты и стены", items: [
    { text: "лабиринт", mj: true },
    { text: "лабиринт 28x28", mj: true },
    { text: "каменный лабиринт", mj: true },
    { text: "живая изгородь лабиринт", mj: true },
    { text: "горный лабиринт", mj: true },
    { text: "забор 24x24", mj: true },
    { text: "лабиринт вокруг этой точки 22x22", mj: true },
  ] },
  { group: "❄️ Снег и биомы", items: [
    { text: "снег на севере" },
    { text: "зима на юге" },
    { text: "снег пятнами", mj: true },
    { text: "редкий снег", mj: true },
    { text: "трава по всей карте" },
    { text: "трава 20x20" },
  ] },
  { group: "🪨 Декор и дороги", items: [
    { text: "извилистая дорога", mj: true },
    { text: "тропинка через лес", mj: true },
    { text: "разбросай камни", mj: true },
    { text: "кусты у воды", mj: true },
    { text: "руины", mj: true },
    { text: "кладбище 16x16", mj: true },
  ] },
  { group: "✎ По рисунку — ⛶ → кисть/полоса, проведи, потом команду (идёт по штриху)", items: [
    { text: "дорога" },
    { text: "река" },
    { text: "камни" },
    { text: "кусты" },
    { text: "руины" },
  ] },
  { group: "📍 Вокруг точки / стороны (зону можно не рисовать)", items: [
    { text: "озеро вокруг этой точки 20x20", mj: true },
    { text: "роща вокруг этой точки 16x16", mj: true },
    { text: "горы вокруг этой точки 18x18", mj: true },
    { text: "лес на юге", mj: true },
    { text: "горы на западе", mj: true },
    { text: "снег на севере" },
  ] },
  { group: "🗺️ Композиции — режим 🧠 LLM", items: [
    { text: "озеро в центре, снег на севере, лес по южному краю", llm: true },
    { text: "крепость: трава, водяной ров и стены вокруг центра", llm: true },
    { text: "остров: вода по краям, горы и лес в центре", llm: true },
    { text: "горная гряда по диагонали и река вдоль неё", llm: true },
    { text: "зимний север со снегом, лесистый юг, озёра в центре", llm: true },
    { text: "залей пустошью кроме центра", llm: true },
  ] },
];

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
  // mazes — branch by material (Cyrillic-safe: \w doesn't match Cyrillic without /u).
  // plain «лабиринт» = stone walls (auto-tiled); «горный» = mountains; «живая изгородь» = forest.
  if (/лабиринт|maze|изгород/.test(t)) {
    if (/горн|гора|гор\b/.test(t)) return "mountain_maze";
    if (/изгород|живая|жив\b/.test(t)) return "hedge_maze";
    return "wall_maze";
  }
  if (/забор|частокол|стен/.test(t)) return "wall_maze";
  // mountains & hills (before generic checks; «гряда гор», «разбросай холмы», «горы по краю»)
  if (/холм/.test(t) || (sparse && /гор|скал/.test(t))) return "relief_hills";
  if (/гряд|хребет/.test(t)) return "relief_ridge";
  if (/гор\b|горы|гора|горн|скал|утёс|утес|массив/.test(t)) return "mountain_fill";
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
  if (/архипелаг|остров|озёра|озера|несколько\s+озёр/.test(t)) return "water_isles";
  if (/вод|озер|море|залей|пруд|болот/.test(t)) return "water_lake";
  // forest (clearings, dense groves, or sparse trees)
  if (/полян|прогалин|просек/.test(t)) return "forest_clearings";
  if (/лес|дерев|рощ|чащ|\bбор\b/.test(t)) return sparse ? "forest_scatter" : "decor_forest";
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

type Zone = { region: Region; cells: [number, number][] | null };

/**
 * Resolve the target zone — its bbox `region` + an optional cell `cells` mask. Priority:
 *  1. point-anchored "… вокруг этой точки NxM" — centre NxM on the clicked point / cursor.
 *  2. an explicit drag selection (⛶) — with its drawn mask (brush/line/frame).
 *  3. "NxM" centred on the map.
 *  4. a direction ("север/юг/запад/восток") -> half the map.
 *  5. 👁 eye -> the EXACT visible cells (diamond mask), so it matches what you see.
 */
function resolveZone(text: string, size: number): Zone | null {
  const clamp = (n: number): number => Math.max(2, Math.min(n, size));
  const m = /(\d{1,3})\s*[x×х*]\s*(\d{1,3})/i.exec(text);
  const around = /вокруг|около|возле|здесь|тут|это[йм]\s*точк|в\s*точк|в\s*этом\s*месте/i.test(text);
  const sel = toolStore.region;
  const anchor = sel
    ? regionCenter(sel)
    : view.cursorCell
      ? { x: view.cursorCell.x, y: view.cursorCell.y }
      : null;

  // 1) point-anchored size (explicit "вокруг точки", or a 1×1 point selection + a size)
  if (m && anchor && (around || (sel ? sel.w <= 2 && sel.h <= 2 : false))) {
    const w = clamp(+m[1]!), h = clamp(+m[2]!);
    const x = Math.max(0, Math.min(anchor.x - Math.floor(w / 2), size - w));
    const y = Math.max(0, Math.min(anchor.y - Math.floor(h / 2), size - h));
    return { region: { x, y, w, h }, cells: null };
  }
  // 2) an explicit drag selection (+ its drawn mask)
  if (sel) return { region: sel, cells: toPairs(toolStore.regionMask) };
  // 3) "NxM" centred
  if (m) {
    const w = clamp(+m[1]!), h = clamp(+m[2]!);
    return { region: { x: Math.floor((size - w) / 2), y: Math.floor((size - h) / 2), w, h }, cells: null };
  }
  // 4) direction halves
  const half = Math.floor(size / 2);
  if (/север|сверху|вверх/i.test(text)) return { region: { x: 0, y: 0, w: size, h: half }, cells: null };
  if (/юг|снизу|вниз/i.test(text)) return { region: { x: 0, y: size - half, w: size, h: half }, cells: null };
  if (/запад|слев/i.test(text)) return { region: { x: 0, y: 0, w: half, h: size }, cells: null };
  if (/восток|справ/i.test(text)) return { region: { x: size - half, y: 0, w: half, h: size }, cells: null };
  // 5) 👁 eye: the exact visible cells (diamond mask), bbox as the region
  if (toolStore.eyeZone && view.visibleCells) return { region: view.visibleCells, cells: toPairs(view.visibleMask) };
  return null;
}

/** LLM-bridge send (Phase-4 POC): the server file-bridges the command to the agent. */
async function sendLlm(text: string): Promise<void> {
  if (!editStore.liveDoc) {
    pushAi("Карта не загружена.");
    return;
  }
  sending.value = true;
  const t0 = performance.now();
  const thinking: Msg = { role: "assistant", text: "🧠 LLM думает… 0s" };
  log.value.push(thinking);
  const timer = window.setInterval(() => {
    thinking.text = `🧠 LLM думает… ${Math.round((performance.now() - t0) / 1000)}s`;
  }, 1000);
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
  });
  try {
    const zone = editStore.liveDoc ? resolveZone(text, editStore.liveDoc.size) : null;
    const res = await editStore.copilot(text, zone?.region ?? null, zone?.cells ?? null, protect.value);
    if (!res) {
      thinking.text = "Карта не загружена.";
      return;
    }
    const ms = Math.round(performance.now() - t0);
    const head = res.reasoning?.trim() || "Готово.";
    thinking.text = res.report?.ok
      ? `${head} · ${debugLine(ms)}`
      : `${head} — валидация не прошла, откатил. · ${debugLine(ms)}`;
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
  expanded.value = true;

  if (llmMode.value) {
    await sendLlm(text);
    return;
  }

  const recipeId = routeRecipe(text);
  if (!recipeId) {
    pushAi("Не понял команду. Примеры: «лабиринт», «залей водой», «снег на севере», «лес», «трава».");
    return;
  }
  const doc = editStore.liveDoc;
  if (!doc) {
    pushAi("Карта не загружена.");
    return;
  }
  const zone = resolveZone(text, doc.size);
  if (!zone) {
    pushAi("Сначала выдели зону кнопкой ⛶ (или 👁) — или укажи размер/сторону (напр. «25x25» или «север»).");
    return;
  }
  const { region, cells } = zone;
  sending.value = true;
  const t0 = performance.now();
  try {
    const rep = await editStore.generate(recipeId, region, undefined, cells, protect.value);
    const ms = Math.round(performance.now() - t0);
    if (rep?.ok) lastGen.value = { mode: "keyword", text, recipeId, region, cells, protect: protect.value };
    pushAi(
      rep?.ok
        ? `Готово: ${recipeId.replace(/_/g, " ")} ${region.w}×${region.h} · ${debugLine(ms)} (↻ другой вариант)`
        : `Валидация не прошла — откатил. · ${debugLine(ms)}`,
    );
  } catch (e) {
    pushAi("⚠ " + (e instanceof Error ? e.message : String(e)));
  } finally {
    sending.value = false;
  }
}

/** Roll back the last generation and re-roll it (MJ recipes get a fresh seed → new shape). */
async function retry(): Promise<void> {
  const g = lastGen.value;
  if (!g || sending.value) return;
  expanded.value = true;
  if (editStore.undoable) editStore.undoEdit(); // undo the previous generation commit
  if (g.mode === "keyword" && g.recipeId && g.region) {
    log.value.push({ role: "user", text: "↻ другой вариант" });
    sending.value = true;
    const t0 = performance.now();
    try {
      const rep = await editStore.generate(g.recipeId, g.region, undefined, g.cells ?? null, g.protect); // new random seed
      const ms = Math.round(performance.now() - t0);
      pushAi(
        rep?.ok
          ? `↻ ${g.recipeId.replace(/_/g, " ")} ${g.region.w}×${g.region.h} · ${debugLine(ms)}`
          : `Не прошло — откатил. · ${debugLine(ms)}`,
      );
    } catch (e) {
      pushAi("⚠ " + (e instanceof Error ? e.message : String(e)));
    } finally {
      sending.value = false;
    }
  } else if (g.mode === "llm") {
    log.value.push({ role: "user", text: "↻ другой вариант: " + g.text });
    await sendLlm(g.text);
  }
}

/** Fill the input from an example (and switch to LLM mode for composition examples). */
function applyExample(ex: { text: string; llm?: boolean; mj?: boolean }): void {
  input.value = ex.text;
  if (ex.llm) llmMode.value = true;
  examplesOpen.value = false;
  (exPop.value as unknown as { hide?: () => void } | null)?.hide?.();
  expanded.value = true;
  void nextTick(() => inputRef.value?.focus());
}

function hide(): void {
  view.copilotVisible = false;
}

// "/" (viewStore.focusCopilot bumps the tick) -> reveal + focus the input.
watch(
  () => view.copilotFocusTick,
  () => {
    expanded.value = true;
    markActive();
    void nextTick(() => inputRef.value?.focus());
  },
);
</script>

<template>
  <div class="copilot-float" @mouseenter="markActive()" @pointerdown="markActive()">
    <transition name="cp-fade">
      <div v-if="expanded" ref="scroller" class="copilot-log d2-float" :class="{ idle: idleEffective }">
        <div v-for="(m, i) in log" :key="i" class="cp-msg" :class="m.role">
          <span class="cp-who">{{ m.role === "user" ? "you" : "ai" }}</span>
          <span class="cp-text">{{ m.text }}</span>
        </div>
      </div>
    </transition>

    <div v-if="zoneActive" class="cp-zonehint d2-float" :class="{ idle: idleEffective }">
      <div class="cp-zrow">
        <span class="cp-zlabel">Зона:</span>
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
          <span class="cp-zsel">{{ regionMask?.length ? regionMask.length + " кл." : region.w + "×" + region.h }}</span>
          <el-button size="small" text @click="toggleZoneHidden">{{ zoneHidden ? "Показать" : "Скрыть" }}</el-button>
          <el-button size="small" text type="success" @click="acceptZone">Принять</el-button>
        </template>
      </div>
    </div>

    <div class="copilot-bar d2-float" :class="{ idle: idleEffective }">
      <el-popover ref="exPop" :width="328" placement="top-start" trigger="click" popper-class="cp-ex-pop">
        <template #reference>
          <el-button class="cp-ico" text :icon="Reading" title="Примеры команд" />
        </template>
        <div class="cp-ex-head">
          Примеры — кликни, затем Enter
          <div class="cp-ex-legend"><b class="cp-ex-mj">MJ</b> марковская (↻ — новый вид) · <b class="cp-ex-llm">LLM</b> через агента · <b>✎</b> по рисунку</div>
        </div>
        <div class="cp-ex-scroll">
          <div v-for="g in EXAMPLES" :key="g.group" class="cp-ex-group">
            <div class="cp-ex-gtitle">{{ g.group }}</div>
            <button v-for="it in g.items" :key="it.text" class="cp-ex-item" @click="applyExample(it)">
              <span>{{ it.text }}</span>
              <span v-if="it.llm" class="cp-ex-llm">LLM</span>
              <span v-else-if="it.mj" class="cp-ex-mj">MJ</span>
            </button>
          </div>
        </div>
      </el-popover>

      <el-tooltip content="LLM-режим — генерация через агента (иначе офлайн-роутер)" placement="top" :show-after="300">
        <el-button class="cp-ico" text :type="llmMode ? 'primary' : 'default'" @click="llmMode = !llmMode">🧠</el-button>
      </el-tooltip>
      <el-tooltip content="Беречь рельеф — не перетирать воду и горы" placement="top" :show-after="300">
        <el-button class="cp-ico" text :type="protect ? 'primary' : 'default'" @click="protect = !protect">🛡</el-button>
      </el-tooltip>
      <el-tooltip content="Глаз: видимая область экрана = зона генерации" placement="top" :show-after="300">
        <el-button class="cp-ico" text :type="eyeActive ? 'primary' : 'default'" @click="toggleEye()">👁<span v-if="eyeActive && visibleMaskLen" class="cp-badge">{{ visibleMaskLen }}</span></el-button>
      </el-tooltip>
      <el-tooltip content="Выделить зону для генерации" placement="top" :show-after="300">
        <el-button class="cp-ico" text :type="zoneActive ? 'primary' : 'default'" @click="toggleZone()">⛶<span v-if="region" class="cp-badge">{{ region.w }}×{{ region.h }}</span></el-button>
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

      <el-button
        class="cp-ico"
        text
        :icon="RefreshRight"
        :disabled="!lastGen || sending"
        title="Другой вариант (откатит текущий и сгенерит заново)"
        @click="retry()"
      />
      <el-button
        class="cp-send"
        text
        :icon="Promotion"
        :disabled="!input.trim() || sending"
        :loading="sending"
        title="Отправить (Enter)"
        @click="send()"
      />
      <el-button class="cp-ico cp-close" text :icon="Close" title="Скрыть ( / вернёт )" @click="hide()" />
    </div>
  </div>
</template>

<style scoped>
.copilot-float {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  width: min(560px, 90%);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none; /* let the canvas receive events except on our controls */
}
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
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  padding-top: 2px;
  color: var(--el-text-color-secondary);
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
  gap: 4px;
  padding: 5px 8px;
  border-radius: 999px;
}
.cp-input {
  flex: 1;
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
}
.cp-badge {
  margin-left: 3px;
  font-size: 10px;
  opacity: 0.8;
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
  font-weight: 700;
}
.cp-zhelp {
  color: var(--el-text-color-secondary);
  flex: 1;
}
.cp-zsel {
  font-weight: 700;
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
  font-weight: 700;
  color: var(--el-text-color-regular);
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
.cp-ex-item:hover {
  background: var(--el-fill-color-light);
}
.cp-ex-llm {
  flex: 0 0 auto;
  font-size: 9px;
  font-weight: 700;
  color: var(--el-color-primary);
  border: 1px solid var(--el-color-primary);
  border-radius: 5px;
  padding: 0 4px;
}
.cp-ex-mj {
  flex: 0 0 auto;
  font-size: 9px;
  font-weight: 700;
  color: var(--el-color-success);
  border: 1px solid var(--el-color-success);
  border-radius: 5px;
  padding: 0 4px;
}
.cp-ex-legend {
  margin-top: 5px;
  font-size: 10px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}
</style>
