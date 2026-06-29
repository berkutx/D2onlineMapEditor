<script setup lang="ts">
/**
 * Left tool dock (fixed 48px). The single home for picking an edit tool, plus a
 * quick "view layers" popover (the rapid multi-toggle surface that mirrors the
 * View menu) and the Copilot toggle. Tools live here ONLY — their options live
 * in ToolOptionsPanel — so the dock width is constant and nothing ever reflows.
 */
import { storeToRefs } from "pinia";
import { View, MagicStick, Check } from "@element-plus/icons-vue";
import { useViewStore } from "../stores/viewStore";
import { useToolStore } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";
import { EDIT_TOOLS } from "./tools";

const view = useViewStore();
const toolStore = useToolStore();
const editStore = useEditStore();
const { tool } = storeToRefs(toolStore);
const { undoable, redoable } = storeToRefs(editStore);
const {
  terrainVisible, objectsVisible, gridVisible, locationsVisible,
  animate, objectPanelVisible, debugOverlay, copilotVisible,
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
</script>

<template>
  <div class="dock">
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

    <el-tooltip
      v-for="t in EDIT_TOOLS"
      :key="t.value"
      :content="t.label"
      placement="right"
      :show-after="200"
    >
      <button
        class="d2-tool-btn"
        :class="{ 'is-active': tool === t.value }"
        @click="toolStore.setTool(t.value)"
      >
        <el-icon><component :is="t.icon" /></el-icon>
      </button>
    </el-tooltip>

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
.dock {
  width: var(--d2-dock-w);
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--d2-sp-2) 0;
  background: var(--el-bg-color-page);
  border-right: var(--d2-hairline);
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
.dock-pop .pop-head {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
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
</style>
