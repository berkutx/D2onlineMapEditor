<script setup lang="ts">
/**
 * Compact floating options bar (top-left of the canvas). Shows ONLY for tools
 * that actually have parameters — terrain (land type + brush size),
 * water/forest/erase (brush size), and «Локации» (scenario-role filter). For every
 * other tool it isn't rendered at all, so the canvas keeps its full width and
 * there's no empty panel. It floats (absolute), so appearing/disappearing never
 * reflows the canvas.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { ElSegmented, ElSelect, ElOption, ElTooltip } from "element-plus";
import { useToolStore } from "../stores/toolStore";
import { LOC_FILTERS, type LocFilter } from "../services/scenarioRoles";

const toolStore = useToolStore();
const { tool, size, terrainId, locFilter } = storeToRefs(toolStore);

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

/** «Локации»: role filter — non-matching locations dim out and are not pickable.
 *  Значения и подписи — единый источник LOC_FILTERS (services/scenarioRoles): триггеры
 *  разложены по смыслу (⚡ вход / 👣 отряд в зоне / 🎒 предмет), остальное по классу роли. */
const locFilterOptions = LOC_FILTERS.map((f) => ({ label: f.icon, value: f.value }));
const LOC_FILTER_HINT = "Фильтр локаций: " + LOC_FILTERS.map((f) => `${f.icon} ${f.hint}`).join(" · ");
function onLocFilter(v: string | number | boolean): void {
  toolStore.setLocFilter(v as LocFilter);
}

const SIZED = new Set(["terrain", "water", "forest", "erase"]);
const showTerrain = computed(() => tool.value === "terrain");
const showLocFilter = computed(() => tool.value === "locations");
const visible = computed(() => SIZED.has(tool.value) || showLocFilter.value);
</script>

<template>
  <div v-if="visible" class="tool-opts d2-float">
    <template v-if="showLocFilter">
      <el-tooltip :content="LOC_FILTER_HINT" placement="bottom" :show-after="300">
        <el-segmented :model-value="locFilter" :options="locFilterOptions" size="small" @change="onLocFilter" />
      </el-tooltip>
    </template>
    <template v-else>
      <el-select
        v-if="showTerrain"
        v-model="terrainId"
        class="to-terrain"
        placeholder="Тип земли"
        size="small"
      >
        <el-option v-for="t in terrains" :key="t.value" :label="t.label" :value="t.value" />
      </el-select>
      <el-segmented v-model="size" :options="sizeOptions" size="small" />
    </template>
  </div>
</template>

<style scoped>
.tool-opts {
  position: absolute;
  top: var(--d2-sp-2);
  left: var(--d2-sp-2);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: var(--d2-sp-2);
  padding: var(--d2-sp-1) var(--d2-sp-2);
}
.to-terrain {
  width: 150px;
}
</style>
