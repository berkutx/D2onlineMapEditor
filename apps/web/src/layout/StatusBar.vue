<script setup lang="ts">
/**
 * Bottom status bar. Left: the active tool + brush size and a single-line hint
 * for that tool (moved here so the tool controls never reflow). Right: cursor
 * cell, map size, object count, zoom — tabular figures so they don't jitter.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { ElDivider } from "element-plus";
import { useMapStore } from "../stores/mapStore";
import { useViewStore } from "../stores/viewStore";
import { useToolStore } from "../stores/toolStore";
import { toolDef } from "./tools";

const mapStore = useMapStore();
const viewStore = useViewStore();
const toolStore = useToolStore();

const { mapSize, mapName, totalObjects } = storeToRefs(mapStore);
const { zoom, cursorCell } = storeToRefs(viewStore);
const { tool, size } = storeToRefs(toolStore);

const cursorText = computed(() =>
  cursorCell.value ? `${cursorCell.value.x}, ${cursorCell.value.y}` : "—",
);
const sizeText = computed(() =>
  mapSize.value ? `${mapSize.value} × ${mapSize.value}` : "—",
);
const zoomText = computed(() => `${Math.round(zoom.value * 100)}%`);

/** Tools whose brush size matters (so we show "Рельеф · 3×3"). */
const SIZED = new Set(["terrain", "water", "forest", "erase"]);
const toolLabel = computed(() => {
  if (tool.value === "region") return "Зона";
  const d = toolDef(tool.value);
  if (!d) return "";
  return SIZED.has(tool.value) ? `${d.label} · ${size.value}×${size.value}` : d.label;
});
const hint = computed(() => {
  if (tool.value === "region") return "обведи участок для генерации (или используй Copilot)";
  return toolDef(tool.value)?.hint ?? "";
});
</script>

<template>
  <div class="status-bar">
    <span class="tool-chip">{{ toolLabel }}</span>
    <el-divider direction="vertical" />
    <span class="hint">{{ hint }}</span>

    <span class="spacer" />

    <span class="status-item">{{ mapName || "Нет карты" }}</span>
    <el-divider direction="vertical" />
    <span class="status-item">Клетка: <b class="d2-num">{{ cursorText }}</b></span>
    <el-divider direction="vertical" />
    <span class="status-item">Размер: <b class="d2-num">{{ sizeText }}</b></span>
    <el-divider direction="vertical" />
    <span class="status-item">Объекты: <b class="d2-num">{{ totalObjects }}</b></span>
    <el-divider direction="vertical" />
    <span class="status-item">Масштаб: <b class="d2-num">{{ zoomText }}</b></span>
  </div>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 var(--d2-sp-3);
  gap: var(--d2-sp-2);
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color-page);
  border-top: var(--d2-hairline);
}
.tool-chip {
  font-weight: 600;
  color: var(--el-color-primary);
  white-space: nowrap;
}
.hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-item {
  white-space: nowrap;
}
.status-item b {
  color: var(--el-text-color-primary);
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.status-bar :deep(.el-divider--vertical) {
  height: 12px;
  margin: 0 var(--d2-sp-1);
  border-color: var(--el-border-color-lighter);
}
</style>
