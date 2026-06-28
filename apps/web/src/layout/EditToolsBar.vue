<script setup lang="ts">
/**
 * Floating editor tool bar (top-left of the canvas): brush tool, brush size, the
 * land terrain to paint, and undo/redo. Drives toolStore (read by MapCanvasHost on
 * pointer events) + editStore (undo/redo). Shown only while a map is open.
 */
import { storeToRefs } from "pinia";
import { useToolStore, type EditTool } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";
import { useMapStore } from "../stores/mapStore";

const toolStore = useToolStore();
const editStore = useEditStore();
const mapStore = useMapStore();

const { tool, size, terrainId } = storeToRefs(toolStore);
const { undoable, redoable, dirty } = storeToRefs(editStore);
const { currentScenarioId } = storeToRefs(mapStore);

const tools: { value: EditTool; label: string }[] = [
  { value: "select", label: "Pan" },
  { value: "terrain", label: "Terrain" },
  { value: "water", label: "Water" },
  { value: "forest", label: "Forest" },
  { value: "road", label: "Road" },
  { value: "roadsel", label: "Road✂" },
  { value: "erase", label: "Erase" },
  { value: "decor", label: "Decor" },
  { value: "move", label: "Move" },
];

const terrains = [
  { value: 5, label: "Neutral" },
  { value: 1, label: "Empire" },
  { value: 4, label: "Undead" },
  { value: 3, label: "Legions" },
  { value: 6, label: "Elves" },
  { value: 2, label: "Mountain (snow)" },
];
</script>

<template>
  <div v-if="currentScenarioId" class="edit-tools">
    <el-radio-group v-model="tool" size="small">
      <el-radio-button v-for="t in tools" :key="t.value" :value="t.value">{{ t.label }}</el-radio-button>
    </el-radio-group>

    <el-select
      v-if="tool === 'terrain'"
      v-model="terrainId"
      size="small"
      class="terrain-pick"
      placeholder="Terrain"
    >
      <el-option v-for="t in terrains" :key="t.value" :label="t.label" :value="t.value" />
    </el-select>

    <el-radio-group
      v-if="tool !== 'select' && tool !== 'road' && tool !== 'decor'"
      v-model="size"
      size="small"
    >
      <el-radio-button :value="1">1×1</el-radio-button>
      <el-radio-button :value="3">3×3</el-radio-button>
      <el-radio-button :value="5">5×5</el-radio-button>
    </el-radio-group>

    <span v-if="tool === 'roadsel'" class="tool-hint">клик — выделить · ещё раз — расширить · Del — стереть · Esc — снять · Ctrl+тащить — карта</span>
    <span v-else-if="tool === 'move'" class="tool-hint">клик — взять · клик — поставить · R — случайный облик · [ ] — листать · Esc — отмена</span>
    <span v-else-if="tool !== 'select'" class="tool-hint">Ctrl+тащить — двигать карту · колесо — масштаб</span>

    <el-button-group>
      <el-button size="small" :disabled="!undoable" @click="editStore.undoEdit()">↶</el-button>
      <el-button size="small" :disabled="!redoable" @click="editStore.redoEdit()">↷</el-button>
    </el-button-group>
    <el-tag v-if="dirty" size="small" type="warning" effect="plain" round>edited</el-tag>
  </div>
</template>

<style scoped>
.edit-tools {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
}
.terrain-pick {
  width: 130px;
}
.tool-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
</style>
