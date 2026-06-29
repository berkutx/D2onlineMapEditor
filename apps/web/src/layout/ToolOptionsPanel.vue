<script setup lang="ts">
/**
 * Tool options panel (fixed 220px, docked next to the ToolDock). Holds the
 * parameters of the active tool — terrain to paint, brush size — and the single
 * canonical undo/redo control. Fixed width means swapping tools changes only
 * this panel's content, never the canvas geometry (the old EditToolsBar reflow
 * is gone by construction). Option-less tools show a short caption.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { ElSegmented, ElSelect, ElOption, ElButton, ElButtonGroup } from "element-plus";
import { useToolStore } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";
import { toolDef } from "./tools";

const toolStore = useToolStore();
const editStore = useEditStore();
const { tool, size, terrainId } = storeToRefs(toolStore);
const { undoable, redoable } = storeToRefs(editStore);

const terrains = [
  { value: 5, label: "Нейтральная" },
  { value: 1, label: "Империя" },
  { value: 4, label: "Нежить" },
  { value: 3, label: "Легионы" },
  { value: 6, label: "Эльфы" },
  { value: 2, label: "Горы (снег)" },
];
const sizeOptions = [
  { label: "1×1", value: 1 },
  { label: "3×3", value: 3 },
  { label: "5×5", value: 5 },
];

const SIZED = new Set(["terrain", "water", "forest", "erase"]);
const showTerrain = computed(() => tool.value === "terrain");
const showSize = computed(() => SIZED.has(tool.value));
const hasOptions = computed(() => showTerrain.value || showSize.value);
const title = computed(() => (tool.value === "region" ? "Зона" : toolDef(tool.value)?.label ?? "Инструмент"));
</script>

<template>
  <div class="opts">
    <div class="opts-title">{{ title }}</div>

    <div class="opts-body">
      <template v-if="showTerrain">
        <label class="opts-label">Тип земли</label>
        <el-select v-model="terrainId" class="opts-field" placeholder="Тип земли">
          <el-option v-for="t in terrains" :key="t.value" :label="t.label" :value="t.value" />
        </el-select>
      </template>

      <template v-if="showSize">
        <label class="opts-label">Размер кисти</label>
        <el-segmented v-model="size" :options="sizeOptions" class="opts-seg" />
      </template>

      <p v-if="!hasOptions" class="opts-empty">У этого инструмента нет параметров.</p>
    </div>

    <div class="opts-foot">
      <el-button-group>
        <el-button :disabled="!undoable" title="Отменить (Ctrl+Z)" @click="editStore.undoEdit()">
          ↶ Отменить
        </el-button>
        <el-button :disabled="!redoable" title="Вернуть (Ctrl+Shift+Z)" @click="editStore.redoEdit()">
          ↷
        </el-button>
      </el-button-group>
    </div>
  </div>
</template>

<style scoped>
.opts {
  width: var(--d2-options-w);
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: var(--d2-sp-3);
  background: var(--el-bg-color);
  border-right: var(--d2-hairline);
}
.opts-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--el-text-color-secondary);
  margin-bottom: var(--d2-sp-3);
}
.opts-body {
  flex: 1;
  min-height: 0;
}
.opts-label {
  display: block;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: var(--d2-sp-3) 0 var(--d2-sp-1);
}
.opts-label:first-child {
  margin-top: 0;
}
.opts-field {
  width: 100%;
}
.opts-seg {
  width: 100%;
}
.opts-empty {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 0;
}
.opts-foot {
  padding-top: var(--d2-sp-3);
  border-top: var(--d2-hairline);
}
.opts-foot :deep(.el-button-group) {
  display: flex;
  width: 100%;
}
.opts-foot :deep(.el-button-group .el-button:first-child) {
  flex: 1;
}
</style>
