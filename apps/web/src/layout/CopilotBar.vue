<script setup lang="ts">
/**
 * Copilot — a light, frosted-glass floating command input docked at the bottom-centre of
 * the canvas (NOT a panel). Just a field: type a command, Enter to send. The chat log
 * floats above only while expanded (on focus / after a message). "/" focuses it (viewStore
 * focusCopilot); the ✕ hides it (and "/" brings it back). STUB responder for now (M6).
 */
import { ref, nextTick, watch } from "vue";
import { ElInput, ElPopover } from "element-plus";
import { MagicStick, Promotion, Close, RefreshRight, Reading } from "@element-plus/icons-vue";
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
const visibleCells = computed(() => view.visibleCells);
function toggleEye(): void {
  toolStore.setEyeZone(!toolStore.eyeZone);
}
function setZoneMode(m: "rect" | "brush" | "line" | "frame"): void {
  toolStore.setZoneMode(m);
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

/** The drawn cell mask as [x,y] pairs (null if no freehand mask). */
function maskCells(): [number, number][] | null {
  const m = toolStore.regionMask;
  if (!m || !m.length) return null;
  return m.map((k) => { const [x, y] = k.split(",").map(Number); return [x, y] as [number, number]; });
}
function sameRegion(a: Region | null, b: Region | null): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
/** Send the mask only when the resolved region IS the drawn selection (not a size/direction). */
function maskFor(region: Region): [number, number][] | null {
  return sameRegion(region, toolStore.region) ? maskCells() : null;
}

/** Examples browser (the 💡 popover). Click an example -> fills the input. */
const examplesOpen = ref(false);
const exPop = ref<InstanceType<typeof ElPopover> | null>(null);
// Big catalogue of working commands (all tested). Click → fills the input; LLM-marked ones
// flip on 🧠 mode. Tip: 🛡 keeps existing water/mountains, 👁 uses the visible area as the zone.
const EXAMPLES: { group: string; items: { text: string; llm?: boolean }[] }[] = [
  { group: "🌊 Вода (органика, не прямоугольники)", items: [
    { text: "озеро в центре" },
    { text: "озеро" },
    { text: "большое озеро 30x30" },
    { text: "озеро вокруг этой точки 20x20" },
    { text: "пруд" },
    { text: "несколько озёр" },
    { text: "архипелаг островов" },
    { text: "река" },
    { text: "ручей через всю карту" },
  ] },
  { group: "🌲 Лес", items: [
    { text: "лес" },
    { text: "рощи по всей карте" },
    { text: "чаща" },
    { text: "разбросай деревья" },
    { text: "редкий лес" },
    { text: "лес с полянами" },
    { text: "густой лес вокруг этой точки 24x24" },
  ] },
  { group: "⛰️ Горы и холмы", items: [
    { text: "горная гряда" },
    { text: "хребет по диагонали" },
    { text: "разбросай холмы" },
    { text: "редкие горы" },
    { text: "горы по краю" },
    { text: "горный массив 24x24" },
    { text: "скалы вокруг этой точки 18x18" },
  ] },
  { group: "🧱 Лабиринты и стены", items: [
    { text: "лабиринт" },
    { text: "лабиринт 28x28" },
    { text: "каменный лабиринт" },
    { text: "живая изгородь лабиринт" },
    { text: "горный лабиринт" },
    { text: "забор 24x24" },
    { text: "лабиринт вокруг этой точки 22x22" },
  ] },
  { group: "❄️ Снег и биомы", items: [
    { text: "снег на севере" },
    { text: "снег пятнами" },
    { text: "редкий снег" },
    { text: "зима на юге" },
    { text: "трава по всей карте" },
    { text: "трава 20x20" },
  ] },
  { group: "🪨 Декор и дороги", items: [
    { text: "извилистая дорога" },
    { text: "тропинка через лес" },
    { text: "разбросай камни" },
    { text: "кусты у воды" },
    { text: "руины" },
    { text: "кладбище 16x16" },
  ] },
  { group: "📍 Вокруг точки / стороны (зону можно не рисовать)", items: [
    { text: "озеро вокруг этой точки 20x20" },
    { text: "роща вокруг этой точки 16x16" },
    { text: "горы вокруг этой точки 18x18" },
    { text: "лес на юге" },
    { text: "горы на западе" },
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

/**
 * Resolve the target zone. Priority:
 *  1. point-anchored "… вокруг этой точки NxM" — centre NxM on the clicked point / cursor;
 *     also triggered when there's a tiny (point) selection + a size.
 *  2. an explicit drag selection (⛶).
 *  3. "NxM" centred on the map.
 *  4. a direction ("север/юг/запад/восток") -> half the map.
 */
function resolveRegion(text: string, size: number): Region | null {
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
    return { x, y, w, h };
  }
  // 2) an explicit drag selection
  if (sel) return sel;
  // 3) "NxM" centred
  if (m) {
    const w = clamp(+m[1]!), h = clamp(+m[2]!);
    return { x: Math.floor((size - w) / 2), y: Math.floor((size - h) / 2), w, h };
  }
  // 4) direction halves
  const half = Math.floor(size / 2);
  if (/север|сверху|вверх/i.test(text)) return { x: 0, y: 0, w: size, h: half };
  if (/юг|снизу|вниз/i.test(text)) return { x: 0, y: size - half, w: size, h: half };
  if (/запад|слев/i.test(text)) return { x: 0, y: 0, w: half, h: size };
  if (/восток|справ/i.test(text)) return { x: size - half, y: 0, w: half, h: size };
  // 5) 👁 eye: nothing drawn/specified -> the currently visible screen area is the zone
  if (toolStore.eyeZone && view.visibleCells) return view.visibleCells;
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
    const mask = maskCells();
    const res = await editStore.copilot(text, toolStore.region, mask, protect.value);
    if (!res) {
      thinking.text = "Карта не загружена.";
      return;
    }
    const ms = Math.round(performance.now() - t0);
    const head = res.reasoning?.trim() || "Готово.";
    thinking.text = res.report?.ok
      ? `${head} · ${debugLine(ms)}`
      : `${head} — валидация не прошла, откатил. · ${debugLine(ms)}`;
    if (res.report?.ok) lastGen.value = { mode: "llm", text, cells: mask, protect: protect.value };
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
  const region = resolveRegion(text, doc.size);
  if (!region) {
    pushAi("Сначала выдели зону кнопкой ⛶ — или укажи размер/сторону (напр. «25x25» или «север»).");
    return;
  }
  sending.value = true;
  const t0 = performance.now();
  try {
    const mask = maskFor(region);
    const rep = await editStore.generate(recipeId, region, undefined, mask, protect.value);
    const ms = Math.round(performance.now() - t0);
    if (rep?.ok) lastGen.value = { mode: "keyword", text, recipeId, region, cells: mask, protect: protect.value };
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
function applyExample(ex: { text: string; llm?: boolean }): void {
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
    void nextTick(() => inputRef.value?.focus());
  },
);
</script>

<template>
  <div class="copilot-float">
    <transition name="cp-fade">
      <div v-if="expanded" ref="scroller" class="copilot-log">
        <div v-for="(m, i) in log" :key="i" class="cp-msg" :class="m.role">
          <span class="cp-who">{{ m.role === "user" ? "you" : "ai" }}</span>
          <span class="cp-text">{{ m.text }}</span>
        </div>
      </div>
    </transition>

    <div v-if="zoneActive" class="cp-zonehint">
      <div class="cp-zrow">
        <span class="cp-zlabel">Зона:</span>
        <el-button-group size="small">
          <el-button :type="zoneMode === 'rect' ? 'primary' : ''" title="Прямоугольник" @click="setZoneMode('rect')">▭</el-button>
          <el-button :type="zoneMode === 'brush' ? 'primary' : ''" title="Кисть" @click="setZoneMode('brush')">✎</el-button>
          <el-button :type="zoneMode === 'line' ? 'primary' : ''" title="Полоса" @click="setZoneMode('line')">╱</el-button>
          <el-button :type="zoneMode === 'frame' ? 'primary' : ''" title="Рамка (контур)" @click="setZoneMode('frame')">▢</el-button>
        </el-button-group>
        <el-button-group v-if="zoneMode === 'brush' || zoneMode === 'line'" size="small">
          <el-button
            v-for="s in [1, 3, 5]"
            :key="s"
            :type="toolStore.size === s ? 'primary' : ''"
            @click="toolStore.setSize(s)"
          >{{ s }}</el-button>
        </el-button-group>
      </div>
      <div class="cp-zrow">
        <span class="cp-zhelp">{{ zoneHelp }}</span>
        <template v-if="region">
          <span class="cp-zsel">{{ regionMask?.length ? regionMask.length + " кл." : region.w + "×" + region.h }}</span>
          <el-button size="small" text @click="toggleZoneHidden">{{ zoneHidden ? "👁 показать" : "🙈 скрыть" }}</el-button>
          <el-button size="small" text type="success" @click="acceptZone">✓ принять</el-button>
        </template>
      </div>
    </div>
    <div class="copilot-bar">
      <el-popover
        ref="exPop"
        :width="328"
        placement="top-start"
        trigger="click"
        popper-class="cp-ex-pop"
      >
        <template #reference>
          <el-button class="cp-ex" size="small" text :icon="Reading" title="Примеры команд" />
        </template>
        <div class="cp-ex-head">Примеры — кликни, затем Enter</div>
        <div class="cp-ex-scroll">
          <div v-for="g in EXAMPLES" :key="g.group" class="cp-ex-group">
            <div class="cp-ex-gtitle">{{ g.group }}</div>
            <button
              v-for="it in g.items"
              :key="it.text"
              class="cp-ex-item"
              @click="applyExample(it)"
            >
              <span>{{ it.text }}</span>
              <span v-if="it.llm" class="cp-ex-llm">LLM</span>
            </button>
          </div>
        </div>
      </el-popover>
      <el-button
        class="cp-llm"
        size="small"
        text
        :type="llmMode ? 'primary' : 'default'"
        title="Режим LLM — генерация через агента (иначе офлайн-роутер по ключевым словам)"
        @click="llmMode = !llmMode"
      >🧠<span v-if="llmMode" class="cp-llm-on">LLM</span></el-button>
      <el-button
        class="cp-protect"
        size="small"
        text
        :type="protect ? 'primary' : 'default'"
        title="Беречь воду и горы — не перетирать существующий рельеф при генерации"
        @click="protect = !protect"
      >🛡</el-button>
      <el-button
        class="cp-eye"
        size="small"
        text
        :type="eyeActive ? 'primary' : 'default'"
        title="Глаз: если зона не выделена — вся видимая область экрана = зона генерации"
        @click="toggleEye()"
      >👁<span v-if="eyeActive && visibleCells" class="cp-eye-n">{{ visibleCells.w }}×{{ visibleCells.h }}</span></el-button>
      <el-button
        class="cp-zone"
        size="small"
        text
        :type="zoneActive ? 'primary' : 'default'"
        title="Выделить зону для генерации"
        @click="toggleZone()"
      >⛶<span v-if="region" class="cp-zone-size">{{ region.w }}×{{ region.h }}</span></el-button>
      <el-icon class="cp-spark"><MagicStick /></el-icon>
      <el-input
        ref="inputRef"
        v-model="input"
        class="cp-input"
        :placeholder="placeholder"
        @focus="expanded = true"
        @keyup.enter="send()"
      />
      <el-button
        v-if="lastGen"
        class="cp-retry"
        text
        :icon="RefreshRight"
        :disabled="sending"
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
      <el-icon class="cp-close" title="Скрыть ( / вернёт )" @click="hide()"><Close /></el-icon>
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
  background: color-mix(in srgb, var(--el-bg-color) 68%, transparent);
  backdrop-filter: blur(14px) saturate(1.3);
  -webkit-backdrop-filter: blur(14px) saturate(1.3);
  border: 1px solid color-mix(in srgb, var(--el-border-color) 55%, transparent);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24);
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
  gap: 6px;
  padding: 5px 8px;
  border-radius: 999px;
}
.cp-spark {
  color: var(--el-color-primary);
  font-size: 16px;
  flex: 0 0 auto;
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
.cp-ex,
.cp-llm,
.cp-protect,
.cp-eye,
.cp-zone,
.cp-retry,
.cp-send {
  flex: 0 0 auto;
}
.cp-llm-on,
.cp-eye-n,
.cp-zone-size {
  margin-left: 3px;
  font-size: 10px;
  opacity: 0.8;
}
.cp-zonehint {
  pointer-events: auto;
  align-self: stretch;
  padding: 6px 10px;
  border-radius: 10px;
  font-size: 11px;
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-bg-color) 68%, transparent);
  backdrop-filter: blur(14px) saturate(1.3);
  -webkit-backdrop-filter: blur(14px) saturate(1.3);
  border: 1px solid color-mix(in srgb, var(--el-color-primary) 40%, transparent);
  display: flex;
  flex-direction: column;
  gap: 5px;
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
</style>
