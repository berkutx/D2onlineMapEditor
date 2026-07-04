<script setup lang="ts">
/**
 * Left tool dock (fixed 48px). The single home for picking an edit tool, plus a
 * quick "view layers" popover (the rapid multi-toggle surface that mirrors the
 * View menu) and the Copilot toggle. Tools live here ONLY — their options live
 * in ToolOptionsPanel — so the dock width is constant and nothing ever reflows.
 *
 * FLYOUTS: tools with parameters get a hover flyout (350ms, right of the button)
 * with 2–4 quick presets — land swatches + brush for «Рельеф», brush size for
 * water/forest/erase, decor family shortcuts, anchors toggle for «Двигать»,
 * role filter for «Локации», draw mode for «Зона». Clicking a preset ACTIVATES
 * the tool with that preset (enter-tool-with-preset), so the flyout is a faster
 * path than click-tool-then-tune-options. A corner caret marks flyout buttons.
 */
import { nextTick } from "vue";
import { storeToRefs } from "pinia";
import { View, MagicStick, Check, EditPen } from "@element-plus/icons-vue";
import { useViewStore } from "../stores/viewStore";
import { useToolStore, type EditTool, type ZoneMode } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";
import { useDecorStore } from "../stores/decorStore";
import { LOC_FILTERS, type LocFilter } from "../services/scenarioRoles";
import { EDIT_TOOLS } from "./tools";

const view = useViewStore();
const toolStore = useToolStore();
const editStore = useEditStore();
const decorStore = useDecorStore();
const { tool, size, terrainId, zoneMode, locFilter, drawGenRecipe } = storeToRefs(toolStore);
const { undoable, redoable } = storeToRefs(editStore);
const {
  terrainVisible, objectsVisible, gridVisible, locationsVisible,
  animate, objectPanelVisible, debugOverlay, copilotVisible,
  anchorsVisible, rolesVisible,
} = storeToRefs(view);

/** View-layer checklist shown in the eye popover (single source of truth = viewStore). */
const layers = [
  { label: "Рельеф", key: "T", on: terrainVisible, toggle: () => view.setLayerVisible("terrain", !terrainVisible.value) },
  { label: "Объекты", key: "O", on: objectsVisible, toggle: () => view.setLayerVisible("objects", !objectsVisible.value) },
  { label: "Сетка", key: "G", on: gridVisible, toggle: () => view.toggleGrid() },
  { label: "Локации", key: "L", on: locationsVisible, toggle: () => view.toggleLocations() },
  { label: "Анимация", key: "A", on: animate, toggle: () => view.toggleAnimate() },
  { label: "Панель объектов", key: "P", on: objectPanelVisible, toggle: () => view.toggleObjectPanel() },
  { label: "Отладка", key: "D", on: debugOverlay, toggle: () => view.toggleDebugOverlay() },
];

/** Tools that get a hover flyout; the rest keep the plain name tooltip. */
const FLY = new Set<EditTool>(["terrain", "water", "forest", "erase", "decor", "move", "locations", "zone"]);
const FLY_WIDTH: Partial<Record<EditTool, number>> = { terrain: 236, locations: 284, decor: 190 };

/** Land swatches (same set/order as ToolOptionsBar's dropdown, as color chips). */
const TERRAINS = [
  { value: 5, label: "Нейтральная", color: "#9aa763" },
  { value: 1, label: "Империя", color: "#6da45e" },
  { value: 4, label: "Нежить", color: "#7f6f8f" },
  { value: 3, label: "Легионы", color: "#a06a4e" },
  { value: 6, label: "Эльфы", color: "#58b06f" },
  { value: 2, label: "Горы (снег)", color: "#e8eef4" },
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
const locFilterOptions = LOC_FILTERS.map((f) => ({ label: f.icon, value: f.value }));

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

/** «По рисунку»: draw a stroke → generation follows it (roads/rivers = the line, decor is
 *  sprinkled along the brush). The flyout picks WHAT to generate; the button toggles. */
const DRAW_GEN: { id: string; label: string }[] = [
  { id: "road_path", label: "🛣 Дорога по линии" },
  { id: "river", label: "🌊 Река по линии" },
  { id: "decor_rocks", label: "🪨 Камни вдоль мазка" },
  { id: "decor_bushes", label: "🌿 Кусты вдоль мазка" },
  { id: "decor_ruins", label: "🏚 Руины вдоль мазка" },
  { id: "decor_graves", label: "🪦 Могилы вдоль мазка" },
];
const drawGenLabel = (id: string | null): string =>
  DRAW_GEN.find((d) => d.id === id)?.label ?? "";
function toggleDrawGen(): void {
  toolStore.setDrawGen(drawGenRecipe.value ? null : "road_path");
}
function pickDrawGen(id: string): void {
  toolStore.setDrawGen(id);
}
</script>

<template>
  <div class="dock d2-rail d2-rail--left">
    <el-popover :width="210" placement="right-start" trigger="click" popper-class="dock-pop">
      <template #reference>
        <button class="d2-tool-btn" title="Слои вида">
          <el-icon><View /></el-icon>
        </button>
      </template>
      <div class="pop-head">Слои вида</div>
      <button v-for="l in layers" :key="l.label" class="pop-row" @click="l.toggle()">
        <el-icon class="pop-ck" :style="{ visibility: l.on.value ? 'visible' : 'hidden' }"><Check /></el-icon>
        <span class="pop-lbl">{{ l.label }}</span>
        <span class="pop-key">{{ l.key }}</span>
      </button>
    </el-popover>

    <div class="dock-div" />

    <template v-for="t in EDIT_TOOLS" :key="t.value">
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
          </button>
        </template>
        <div class="pop-head">{{ t.label }}</div>

        <template v-if="t.value === 'terrain'">
          <div class="fly-row">
            <button
              v-for="tr in TERRAINS"
              :key="tr.value"
              type="button"
              class="fly-swatch"
              :class="{ on: terrainId === tr.value && tool === 'terrain' }"
              :style="{ background: tr.color }"
              :title="tr.label"
              @click="pickTerrain(tr.value)"
            />
          </div>
          <div class="fly-row">
            <span class="fly-lbl">Кисть</span>
            <el-segmented :model-value="size" :options="sizeOptions" size="small" @change="onFlySize('terrain', $event)" />
          </div>
        </template>

        <template v-else-if="t.value === 'water' || t.value === 'forest' || t.value === 'erase'">
          <div class="fly-row">
            <span class="fly-lbl">Кисть</span>
            <el-segmented :model-value="size" :options="sizeOptions" size="small" @change="onFlySize(t.value, $event)" />
          </div>
        </template>

        <template v-else-if="t.value === 'decor'">
          <button class="pop-row" @click="decorFamily('nature')"><span class="pop-lbl">🌿 Природа</span></button>
          <button class="pop-row" @click="decorFamily('structures')"><span class="pop-lbl">🏛 Постройки</span></button>
          <button class="pop-row" @click="decorFamily('terrain')"><span class="pop-lbl">⛰ Рельеф</span></button>
          <button class="pop-row" @click="decorSearch()"><span class="pop-lbl">🔍 Поиск…</span></button>
        </template>

        <template v-else-if="t.value === 'move'">
          <button class="pop-row" @click="view.toggleAnchors()">
            <el-icon class="pop-ck" :style="{ visibility: anchorsVisible ? 'visible' : 'hidden' }"><Check /></el-icon>
            <span class="pop-lbl">Якоря (связи зданий)</span>
          </button>
        </template>

        <template v-else-if="t.value === 'locations'">
          <div class="fly-row">
            <el-segmented :model-value="locFilter" :options="locFilterOptions" size="small" @change="onFlyLocFilter($event)" />
          </div>
          <button class="pop-row" @click="view.toggleRoles()">
            <el-icon class="pop-ck" :style="{ visibility: rolesVisible ? 'visible' : 'hidden' }"><Check /></el-icon>
            <span class="pop-lbl">Роли на карте</span>
          </button>
        </template>

        <template v-else-if="t.value === 'zone'">
          <div class="fly-row">
            <span class="fly-lbl">Рисовать</span>
            <el-segmented :model-value="zoneMode" :options="ZONE_MODES" size="small" @change="onFlyZoneMode($event)" />
          </div>
        </template>
      </el-popover>

      <el-tooltip v-else :content="t.label" placement="right" :show-after="200">
        <button
          class="d2-tool-btn"
          :class="{ 'is-active': tool === t.value }"
          @click="toolStore.setTool(t.value)"
        >
          <el-icon><component :is="t.icon" /></el-icon>
        </button>
      </el-tooltip>
    </template>

    <el-popover :width="212" placement="right-start" trigger="hover" :show-after="350" :hide-after="120" popper-class="dock-pop">
      <template #reference>
        <button
          class="d2-tool-btn has-fly"
          :class="{ 'is-active': !!drawGenRecipe }"
          :title="drawGenRecipe ? 'По рисунку: ' + drawGenLabel(drawGenRecipe) : 'По рисунку — генерация вдоль штриха'"
          @click="toggleDrawGen()"
        >
          <el-icon><EditPen /></el-icon>
        </button>
      </template>
      <div class="pop-head">По рисунку — нарисуй штрих, генерация пойдёт по нему</div>
      <button v-for="d in DRAW_GEN" :key="d.id" class="pop-row" @click="pickDrawGen(d.id)">
        <el-icon class="pop-ck" :style="{ visibility: drawGenRecipe === d.id ? 'visible' : 'hidden' }"><Check /></el-icon>
        <span class="pop-lbl">{{ d.label }}</span>
      </button>
    </el-popover>

    <div class="dock-spring" />
    <div class="dock-div" />

    <el-tooltip content="Отменить (Ctrl+Z)" placement="right" :show-after="200">
      <button class="d2-tool-btn dock-glyph" :disabled="!undoable" @click="editStore.undoEdit()">↶</button>
    </el-tooltip>
    <el-tooltip content="Вернуть (Ctrl+⇧Z)" placement="right" :show-after="200">
      <button class="d2-tool-btn dock-glyph" :disabled="!redoable" @click="editStore.redoEdit()">↷</button>
    </el-tooltip>

    <div class="dock-div" />

    <el-tooltip content="Copilot ( / )" placement="right" :show-after="200">
      <button
        class="d2-tool-btn"
        :class="{ 'is-active': copilotVisible }"
        @click="view.toggleCopilot()"
      >
        <el-icon><MagicStick /></el-icon>
      </button>
    </el-tooltip>
  </div>
</template>

<style scoped>
/* bg + seam come from the shared .d2-rail / .d2-rail--left primitive */
.dock {
  width: var(--d2-dock-w);
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--d2-sp-2) 0;
}
.d2-tool-btn {
  width: var(--d2-hit);
  height: var(--d2-hit);
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--d2-radius);
  color: var(--el-text-color-regular);
  font-size: 19px;
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
.dock-glyph {
  font-size: 18px;
  line-height: 1;
}
.dock-div {
  width: 24px;
  height: 1px;
  background: var(--el-border-color-lighter);
  margin: 2px 0;
}
.dock-spring {
  flex: 1;
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
