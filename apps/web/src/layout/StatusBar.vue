<script setup lang="ts">
/** Bottom status bar: cursor cell, map size, and current zoom. */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useMapStore } from "../stores/mapStore";
import { useViewStore } from "../stores/viewStore";

const mapStore = useMapStore();
const viewStore = useViewStore();

const { mapSize, mapName, totalObjects } = storeToRefs(mapStore);
const { zoom, cursorCell } = storeToRefs(viewStore);

const cursorText = computed(() =>
  cursorCell.value ? `${cursorCell.value.x}, ${cursorCell.value.y}` : "—",
);
const sizeText = computed(() =>
  mapSize.value ? `${mapSize.value} × ${mapSize.value}` : "—",
);
const zoomText = computed(() => `${Math.round(zoom.value * 100)}%`);
</script>

<template>
  <div class="status-bar">
    <span class="status-item" title="Map name">{{ mapName || "No map" }}</span>
    <span class="sep" />
    <span class="status-item">Cell: <b>{{ cursorText }}</b></span>
    <span class="sep" />
    <span class="status-item">Size: <b>{{ sizeText }}</b></span>
    <span class="sep" />
    <span class="status-item">Objects: <b>{{ totalObjects }}</b></span>
    <span class="spacer" />
    <span class="status-item">Zoom: <b>{{ zoomText }}</b></span>
  </div>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 12px;
  gap: 8px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  background: var(--el-bg-color-page);
  border-top: 1px solid var(--el-border-color-light);
}
.status-item b {
  color: var(--el-text-color-primary);
  font-weight: 600;
}
.sep {
  width: 1px;
  height: 14px;
  background: var(--el-border-color);
}
.spacer {
  flex: 1;
}
</style>
