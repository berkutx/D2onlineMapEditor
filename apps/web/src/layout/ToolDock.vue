<script setup lang="ts">
/**
 * Left tool dock. The single home for picking an edit tool, plus a quick "view layers"
 * popover (the rapid multi-toggle surface that mirrors the View menu), generation along a
 * stroke, the command bar toggle and undo/redo.
 *
 * The tools are grouped by what the map maker is doing (tools.ts: Осмотр, Земля, Дороги,
 * Объекты, Сценарий). The dock has two widths — icons only (48px) and icons with labels and
 * hotkeys — switched by the chevron at the bottom and remembered; a wide window starts with
 * the labels. When the window is too short for all the buttons they get smaller, and then the
 * tool list scrolls while undo/redo stay pinned at the bottom.
 *
 * Every button explains itself: the tooltip (or the flyout's head) says what the tool is for
 * and which key picks it.
 *
 * FLYOUTS: tools with parameters get a hover flyout (350ms, right of the button)
 * with 2–4 quick presets — land swatches + brush for «Рельеф», brush size for
 * water/forest/erase, decor family shortcuts, anchors toggle for «Двигать»,
 * role filter for «Локации», draw mode for «Зона». Clicking a preset ACTIVATES
 * the tool with that preset (enter-tool-with-preset), so the flyout is a faster
 * path than click-tool-then-tune-options. A corner caret marks flyout buttons.
 */
import { computed, nextTick } from "vue";
import { storeToRefs } from "pinia";
import { View, MagicStick, Check, EditPen, DArrowLeft, DArrowRight } from "@element-plus/icons-vue";
import { useViewStore } from "../stores/viewStore";
import { useToolStore, type EditTool, type ZoneMode, type PlaceObjectKind } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";
import { useDecorStore } from "../stores/decorStore";
import { useGenStore } from "../stores/genStore";
import { useFogStore, type FogPlayer } from "../stores/fogStore";
import { LOC_FILTERS, type LocFilter } from "../services/scenarioRoles";
import { EDIT_TOOLS, TOOL_GROUPS } from "./tools";
import { tr } from "../i18n";

const view = useViewStore();
const toolStore = useToolStore();
const editStore = useEditStore();
const decorStore = useDecorStore();
const { tool, size, terrainId, zoneMode, locFilter, drawGenRecipe } = storeToRefs(toolStore);
const { undoable, redoable } = storeToRefs(editStore);
const {
  terrainVisible, objectsVisible, gridVisible, locationsVisible,
  animate, objectPanelVisible, debugOverlay, copilotVisible,
  anchorsVisible, rolesVisible, dockWide,
} = storeToRefs(view);

/** The tools by section, in the dock's order. */
const groups = TOOL_GROUPS.map((g) => ({ ...g, tools: EDIT_TOOLS.filter((t) => t.group === g.id) }));

/** View-layer checklist shown in the eye popover (single source of truth = viewStore). */
const layers = [
  { label: tr("Рельеф"), key: "T", on: terrainVisible, toggle: () => view.setLayerVisible("terrain", !terrainVisible.value) },
  { label: tr("Объекты"), key: "O", on: objectsVisible, toggle: () => view.setLayerVisible("objects", !objectsVisible.value) },
  { label: tr("Сетка"), key: "G", on: gridVisible, toggle: () => view.toggleGrid() },
  { label: tr("Локации"), key: "L", on: locationsVisible, toggle: () => view.toggleLocations() },
  { label: tr("Анимация"), key: "A", on: animate, toggle: () => view.toggleAnimate() },
  { label: tr("Панель объектов"), key: "P", on: objectPanelVisible, toggle: () => view.toggleObjectPanel() },
  { label: tr("Отладка"), key: "D", on: debugOverlay, toggle: () => view.toggleDebugOverlay() },
];

/** Tools that get a hover flyout; the rest keep the plain name tooltip. */
const FLY = new Set<EditTool>(["terrain", "water", "forest", "erase", "decor", "object", "move", "locations", "zone", "fog"]);
const FLY_WIDTH: Partial<Record<EditTool, number>> = { terrain: 236, locations: 284, decor: 190, fog: 250 };

/** Land swatches (same set/order as ToolOptionsBar's dropdown, as color chips). */
const TERRAINS = [
  { value: 5, label: tr("Нейтральная"), color: "#9aa763" },
  { value: 1, label: tr("Империя"), color: "#6da45e" },
  { value: 4, label: tr("Нежить"), color: "#7f6f8f" },
  { value: 3, label: tr("Легионы"), color: "#a06a4e" },
  { value: 6, label: tr("Эльфы"), color: "#58b06f" },
  { value: 2, label: tr("Горы (снег)"), color: "#e8eef4" },
];
const sizeOptions = [
  { label: "1×1", value: 1 },
  { label: "3×3", value: 3 },
  { label: "5×5", value: 5 },
];
const ZONE_MODES: { label: string; value: ZoneMode }[] = [
  { label: "▭", value: "rect" }, { label: "🖌", value: "brush" },
  { label: "╱", value: "line" }, { label: "▢", value: "frame" },
];
const locFilterOptions = LOC_FILTERS.map((f) => ({ label: f.label, icon: f.icon, value: f.value }));

// Flyout actions — every preset click also ACTIVATES the tool.
function pickTerrain(id: number): void {
  toolStore.setTool("terrain");
  toolStore.setTerrainId(id);
}
function onFlySize(t: EditTool, v: string | number | boolean): void {
  toolStore.setTool(t);
  toolStore.setSize(v as number);
}
function onFlyZoneMode(v: string | number | boolean): void {
  toolStore.setTool("zone");
  toolStore.setZoneMode(v as ZoneMode);
}
function onFlyLocFilter(v: string | number | boolean): void {
  toolStore.setTool("locations");
  toolStore.setLocFilter(v as LocFilter);
}
function decorFamily(family: string): void {
  toolStore.setTool("decor");
  // nextTick: the palette mounts on tool switch; preset lands either way (store state)
  void nextTick(() => decorStore.presetFamily(family));
}
function decorSearch(): void {
  toolStore.setTool("decor");
  void nextTick(() => decorStore.focusSearch());
}

/** «Объекты»: interactive objects the tool places (kinds mirror ToolOptionsBar). */
const OBJECT_KINDS: { value: PlaceObjectKind; label: string }[] = [
  { value: "village", label: tr("🏘 Город") },
  { value: "ruin", label: tr("🏚 Руина") },
  { value: "treasure", label: tr("💰 Сундук") },
  { value: "stack", label: tr("⚔ Отряд") },
  { value: "merchant", label: tr("🛒 Торговец") },
  { value: "mage", label: tr("🔮 Маг") },
  { value: "trainer", label: tr("🎓 Тренер") },
  { value: "mercenary", label: tr("🛡 Наёмники") },
];

/** «По рисунку»: draw a stroke → generation follows it (a road, a river or a ridge IS the
 *  line; mountains, forest and snow fill the brush; decor and hills are sprinkled along it).
 *  The flyout picks WHAT to generate; the button toggles. The list is the server's: every
 *  recipe that can follow a stroke, with the stroke it wants. */
interface DrawGen { id: string; label: string; stroke?: { mode: "line" | "brush"; size: number } }
/** Shown while the server's list has not arrived (or is not available). */
const DRAW_GEN_FALLBACK: DrawGen[] = [
  { id: "road_path", label: tr("🛣 Дорога — линией") },
  { id: "river", label: tr("🌊 Река — линией") },
  // (no rock or headstone emoji here: Windows 10 has no glyphs for them)
  { id: "decor_rocks", label: tr("🗿 Камни — кистью") },
  { id: "decor_bushes", label: tr("🌿 Кусты — кистью") },
  { id: "decor_ruins", label: tr("🏚 Руины — кистью") },
  { id: "decor_graves", label: tr("⚰ Могилы — кистью") },
];
const gen = useGenStore();
void gen.loadCatalog().catch(() => undefined);
const drawGen = computed<DrawGen[]>(() =>
  gen.drawable.length
    ? gen.drawable.map((r) => ({
        id: r.id,
        label: r.stroke === "line"
          ? tr("{icon} {title} — линией", { icon: gen.iconOf(r.id), title: tr(r.title) })
          : tr("{icon} {title} — кистью", { icon: gen.iconOf(r.id), title: tr(r.title) }),
        stroke: { mode: r.stroke!, size: r.strokeWidth ?? 1 },
      }))
    : DRAW_GEN_FALLBACK,
);
const drawGenLabel = (id: string | null): string =>
  drawGen.value.find((d) => d.id === id)?.label ?? "";
function pickDrawGen(id: string): void {
  toolStore.setDrawGen(id, drawGen.value.find((d) => d.id === id)?.stroke);
}
function toggleDrawGen(): void {
  if (drawGenRecipe.value) toolStore.setDrawGen(null);
  else pickDrawGen("road_path");
}

/** «Туман войны»: the flyout lists the sides with how their fog stands; a click shows that
 *  side's fog on the map, ready for the brush. */
const fogStore = useFogStore();
const fogShort = (p: FogPlayer): string =>
  p.state === "unset" ? tr("не задан") : p.state === "hidden" ? tr("скрыт") : tr("задан");
function pickFogPlayer(id: string): void {
  fogStore.setPlayer(id);
  toolStore.setTool("fog");
}
</script>

<template>
  <div class="dock d2-rail d2-rail--left" :class="{ wide: dockWide }">
    <div class="dock-scroll">
      <el-popover :width="210" placement="right-start" trigger="click" popper-class="dock-pop">
        <template #reference>
          <button class="d2-tool-btn" :title="tr('Слои вида')">
            <el-icon><View /></el-icon>
            <span class="dock-lbl">{{ tr("Слои") }}</span>
          </button>
        </template>
        <div class="pop-head">{{ tr("Слои вида") }}</div>
        <button v-for="l in layers" :key="l.label" class="pop-row" @click="l.toggle()">
          <el-icon class="pop-ck" :style="{ visibility: l.on.value ? 'visible' : 'hidden' }"><Check /></el-icon>
          <span class="pop-lbl">{{ l.label }}</span>
          <span class="pop-key">{{ l.key }}</span>
        </button>
      </el-popover>

      <template v-for="g in groups" :key="g.id">
        <div class="dock-cap"><span>{{ g.label }}</span></div>
        <template v-for="t in g.tools" :key="t.value">
          <el-popover
            v-if="FLY.has(t.value)"
            :width="FLY_WIDTH[t.value] ?? 200"
            placement="right-start"
            trigger="hover"
            :show-after="350"
            :hide-after="120"
            popper-class="dock-pop"
          >
            <template #reference>
              <button
                class="d2-tool-btn has-fly"
                :class="{ 'is-active': tool === t.value }"
                @click="toolStore.setTool(t.value)"
              >
                <el-icon><component :is="t.icon" /></el-icon>
                <span class="dock-lbl">{{ t.label }}</span>
                <kbd v-if="t.key" class="dock-key">{{ t.key }}</kbd>
              </button>
            </template>
            <div class="pop-head">{{ t.label }}<kbd v-if="t.key" class="pop-kbd">{{ t.key }}</kbd></div>
            <div class="pop-about">{{ t.about }}</div>

            <template v-if="t.value === 'terrain'">
              <div class="fly-row">
                <button
                  v-for="terr in TERRAINS"
                  :key="terr.value"
                  type="button"
                  class="fly-swatch"
                  :class="{ on: terrainId === terr.value && tool === 'terrain' }"
                  :style="{ background: terr.color }"
                  :title="terr.label"
                  @click="pickTerrain(terr.value)"
                />
              </div>
              <div class="fly-row">
                <span class="fly-lbl">{{ tr("Кисть") }}</span>
                <el-segmented :model-value="size" :options="sizeOptions" size="small" @change="onFlySize('terrain', $event)" />
              </div>
            </template>

            <template v-else-if="t.value === 'water' || t.value === 'forest' || t.value === 'erase'">
              <div class="fly-row">
                <span class="fly-lbl">{{ tr("Кисть") }}</span>
                <el-segmented :model-value="size" :options="sizeOptions" size="small" @change="onFlySize(t.value, $event)" />
              </div>
            </template>

            <template v-else-if="t.value === 'decor'">
              <button class="pop-row" @click="decorFamily('nature')"><span class="pop-lbl">{{ tr("🌿 Природа") }}</span></button>
              <button class="pop-row" @click="decorFamily('structures')"><span class="pop-lbl">{{ tr("🏛 Постройки") }}</span></button>
              <button class="pop-row" @click="decorFamily('terrain')"><span class="pop-lbl">{{ tr("⛰ Рельеф") }}</span></button>
              <button class="pop-row" @click="decorSearch()"><span class="pop-lbl">{{ tr("🔍 Поиск…") }}</span></button>
            </template>

            <template v-else-if="t.value === 'object'">
              <button v-for="k in OBJECT_KINDS" :key="k.value" class="pop-row" @click="toolStore.setObjectKind(k.value)">
                <el-icon class="pop-ck" :style="{ visibility: toolStore.objectKind === k.value && tool === 'object' ? 'visible' : 'hidden' }"><Check /></el-icon>
                <span class="pop-lbl">{{ k.label }}</span>
              </button>
            </template>

            <template v-else-if="t.value === 'move'">
              <button class="pop-row" @click="view.toggleAnchors()">
                <el-icon class="pop-ck" :style="{ visibility: anchorsVisible ? 'visible' : 'hidden' }"><Check /></el-icon>
                <span class="pop-lbl">{{ tr("Якоря (связи зданий)") }}</span>
              </button>
            </template>

            <template v-else-if="t.value === 'locations'">
              <div class="fly-row">
                <el-segmented :model-value="locFilter" :options="locFilterOptions" size="small" class="loc-filter" @change="onFlyLocFilter($event)">
                  <template #default="{ item }">
                    <span class="lf-cell"><span class="lf-ico">{{ item.icon }}</span><span class="lf-lbl">{{ item.label }}</span></span>
                  </template>
                </el-segmented>
              </div>
              <button class="pop-row" @click="view.toggleRoles()">
                <el-icon class="pop-ck" :style="{ visibility: rolesVisible ? 'visible' : 'hidden' }"><Check /></el-icon>
                <span class="pop-lbl">{{ tr("Роли на карте") }}</span>
              </button>
            </template>

            <template v-else-if="t.value === 'zone'">
              <div class="fly-row">
                <span class="fly-lbl">{{ tr("Рисовать") }}</span>
                <el-segmented :model-value="zoneMode" :options="ZONE_MODES" size="small" @change="onFlyZoneMode($event)" />
              </div>
            </template>

            <template v-else-if="t.value === 'fog'">
              <button v-for="p in fogStore.players" :key="p.id" class="pop-row" @click="pickFogPlayer(p.id)">
                <span class="pop-dot" :style="{ background: p.color || 'var(--el-text-color-placeholder)' }" />
                <span class="pop-lbl">{{ p.name }}</span>
                <span class="pop-key" :class="{ warn: p.state === 'unset' && !p.neutral }">{{ fogShort(p) }}</span>
              </button>
              <div v-if="!fogStore.players.length" class="pop-about">{{ tr("В этой карте нет блоков тумана") }}</div>
            </template>
          </el-popover>

          <el-tooltip v-else placement="right" :show-after="200">
            <template #content>
              <div class="dock-tip">
                <div class="dock-tip-head">{{ t.label }}<kbd v-if="t.key" class="pop-kbd">{{ t.key }}</kbd></div>
                <div>{{ t.about }}</div>
              </div>
            </template>
            <button
              class="d2-tool-btn"
              :class="{ 'is-active': tool === t.value }"
              @click="toolStore.setTool(t.value)"
            >
              <el-icon><component :is="t.icon" /></el-icon>
              <span class="dock-lbl">{{ t.label }}</span>
              <kbd v-if="t.key" class="dock-key">{{ t.key }}</kbd>
            </button>
          </el-tooltip>
        </template>
      </template>

      <div class="dock-cap"><span>{{ tr("Генерация") }}</span></div>
      <el-popover :width="236" placement="right-start" trigger="hover" :show-after="350" :hide-after="120" popper-class="dock-pop">
        <template #reference>
          <button
            class="d2-tool-btn has-fly"
            :class="{ 'is-active': !!drawGenRecipe }"
            @click="toggleDrawGen()"
          >
            <el-icon><EditPen /></el-icon>
            <span class="dock-lbl">{{ tr("По рисунку") }}</span>
          </button>
        </template>
        <div class="pop-head">{{ drawGenRecipe ? tr("По рисунку: {what}", { what: drawGenLabel(drawGenRecipe) }) : tr("По рисунку") }}</div>
        <div class="pop-about">{{ tr("Нарисуй штрих — генерация пойдёт по нему: дорога и река лягут линией, остальное заполнит мазок.") }}</div>
        <button v-for="d in drawGen" :key="d.id" class="pop-row" @click="pickDrawGen(d.id)">
          <el-icon class="pop-ck" :style="{ visibility: drawGenRecipe === d.id ? 'visible' : 'hidden' }"><Check /></el-icon>
          <span class="pop-lbl">{{ d.label }}</span>
        </button>
      </el-popover>

      <el-tooltip placement="right" :show-after="200">
        <template #content>
          <div class="dock-tip">
            <div class="dock-tip-head">{{ tr("Командная строка") }}<kbd class="pop-kbd">/</kbd></div>
            <div>{{ tr("Напишите, что сделать: «озеро», «туман», «найти Столица», «20 30» — или выберите генератор из палитры.") }}</div>
          </div>
        </template>
        <button
          class="d2-tool-btn"
          :class="{ 'is-active': copilotVisible }"
          @click="view.toggleCopilot()"
        >
          <el-icon><MagicStick /></el-icon>
          <span class="dock-lbl">{{ tr("Команды") }}</span>
          <kbd class="dock-key">/</kbd>
        </button>
      </el-tooltip>
    </div>

    <div class="dock-foot">
      <el-tooltip :content="tr('Отменить (Ctrl+Z)')" placement="right" :show-after="200">
        <button class="d2-tool-btn dock-glyph" :disabled="!undoable" @click="editStore.undoEdit()">↶</button>
      </el-tooltip>
      <el-tooltip :content="tr('Вернуть (Ctrl+⇧Z)')" placement="right" :show-after="200">
        <button class="d2-tool-btn dock-glyph" :disabled="!redoable" @click="editStore.redoEdit()">↷</button>
      </el-tooltip>
      <el-tooltip :content="dockWide ? tr('Свернуть панель до значков') : tr('Развернуть панель: подписи и клавиши')" placement="right" :show-after="200">
        <button class="d2-tool-btn dock-fold" @click="view.toggleDockWide()">
          <el-icon><component :is="dockWide ? DArrowLeft : DArrowRight" /></el-icon>
        </button>
      </el-tooltip>
    </div>
  </div>
</template>

<style scoped>
/* bg + seam come from the shared .d2-rail / .d2-rail--left primitive */
.dock {
  --dock-hit: var(--d2-hit);
  --dock-icon: 19px;
  width: var(--d2-dock-w);
  height: 100%;
  display: flex;
  flex-direction: column;
  transition: width 0.14s ease;
}
.dock.wide {
  width: 176px;
}
/* a short window: smaller buttons first, then the list scrolls (the foot stays in place) */
@media (max-height: 960px) {
  .dock {
    --dock-hit: 32px;
    --dock-icon: 17px;
  }
}
@media (max-height: 800px) {
  .dock {
    --dock-hit: 27px;
    --dock-icon: 15px;
  }
}
.dock-scroll {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--d2-sp-2) 0 4px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
}
.dock-scroll::-webkit-scrollbar {
  display: none;
}
.dock-foot {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 4px 0 var(--d2-sp-2);
  border-top: 1px solid var(--el-border-color-lighter);
}
.dock.wide .dock-scroll {
  align-items: stretch;
  padding-left: 6px;
  padding-right: 6px;
}
.dock.wide .dock-foot {
  flex-direction: row;
  justify-content: center;
  gap: 6px;
}
.d2-tool-btn {
  flex: 0 0 auto;
  width: var(--dock-hit);
  height: var(--dock-hit);
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--d2-radius);
  color: var(--el-text-color-regular);
  font-size: var(--dock-icon);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.d2-tool-btn:hover {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
}
.d2-tool-btn.is-active {
  background: var(--d2-active-bg);
  color: var(--d2-active-fg);
  box-shadow: inset 2px 0 0 var(--d2-active-bar);
}
.d2-tool-btn:disabled {
  opacity: 0.32;
  cursor: default;
  background: transparent;
  color: var(--el-text-color-regular);
}
/* labels and hotkeys: only in the wide dock */
.dock-lbl,
.dock-key {
  display: none;
}
.dock.wide .dock-scroll .d2-tool-btn {
  width: 100%;
  justify-content: flex-start;
  gap: 9px;
  padding: 0 8px;
}
.dock.wide .dock-lbl {
  display: block;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  text-align: left;
}
.dock.wide .dock-key {
  display: block;
  flex: 0 0 auto;
  min-width: 16px;
  padding: 0 4px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  font-family: inherit;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
  color: var(--el-text-color-secondary);
}
/* section caption: a hairline in the narrow dock, a word in the wide one */
.dock-cap {
  flex: 0 0 auto;
  width: 24px;
  height: 1px;
  margin: 3px 0;
  background: var(--el-border-color-lighter);
}
.dock-cap span {
  display: none;
}
.dock.wide .dock-cap {
  width: auto;
  height: auto;
  margin: 8px 0 2px;
  padding: 0 8px;
  background: none;
}
.dock.wide .dock-cap span {
  display: block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
}
/* corner caret — "this button has a flyout" (Photoshop idiom) */
.d2-tool-btn.has-fly {
  position: relative;
}
.d2-tool-btn.has-fly::after {
  content: "";
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 0 0 5px 5px;
  border-color: transparent transparent var(--el-text-color-placeholder) transparent;
  opacity: 0.9;
}
.dock.wide .d2-tool-btn.has-fly::after {
  right: 3px;
  bottom: 3px;
}
.dock-glyph {
  font-size: calc(var(--dock-icon) - 1px);
  line-height: 1;
}
.dock-fold {
  font-size: 14px;
}
</style>

<!-- Popover is teleported to <body>, so its rows need unscoped styles. -->
<style>
.dock-pop.el-popover.el-popper {
  padding: 6px;
  border-radius: var(--d2-radius);
}
/* micro-caps label, matching .d2-sec (local margins: popover, not a rail) */
.dock-pop .pop-head {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--el-text-color-secondary);
  padding: 2px 8px 6px;
}
.dock-pop .pop-about {
  padding: 0 8px 6px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
}
.dock-pop .pop-kbd,
.dock-tip .pop-kbd {
  display: inline-block;
  min-width: 16px;
  margin-left: 8px;
  padding: 0 4px;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-family: inherit;
  font-size: 11px;
  line-height: 15px;
  letter-spacing: 0;
  text-align: center;
  opacity: 0.75;
}
.dock-pop .pop-dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.dock-pop .pop-key.warn {
  color: var(--el-color-warning);
}
.dock-tip {
  max-width: 250px;
  line-height: 1.4;
}
.dock-tip-head {
  margin-bottom: 2px;
  font-weight: 600;
}
.dock-pop .pop-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  font-size: 13px;
  color: var(--el-text-color-primary);
  padding: 7px 8px;
  border-radius: var(--d2-radius);
  cursor: pointer;
}
.dock-pop .pop-row:hover {
  background: var(--el-fill-color-light);
}
.dock-pop .pop-ck {
  flex: 0 0 auto;
  color: var(--el-color-primary);
}
.dock-pop .pop-lbl {
  flex: 1;
}
.dock-pop .pop-key {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
/* flyout preset rows (swatches / segmented controls) */
.dock-pop .fly-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 6px;
}
/* фильтр локаций во флайауте: сегмент переносится по строкам (8 фильтров не влезают
 * в одну), в каждой ячейке значок + подпись под ним */
.dock-pop .loc-filter :deep(.el-segmented__group) {
  flex-wrap: wrap;
}
.dock-pop .lf-cell {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.1;
}
.dock-pop .lf-ico {
  font-size: 13px;
}
.dock-pop .lf-lbl {
  font-size: 9px;
  opacity: 0.85;
}
.dock-pop .fly-lbl {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.dock-pop .fly-swatch {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  padding: 0;
  cursor: pointer;
}
.dock-pop .fly-swatch.on {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}
</style>
