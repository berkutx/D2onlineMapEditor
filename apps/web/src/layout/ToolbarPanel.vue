<script setup lang="ts">
/**
 * Left icon toolbar — quick toggles for the common view layers (like a map
 * editor's tool strip). Each button reflects + flips a viewStore flag; the
 * settings persist via the store's localStorage watcher.
 */
import { storeToRefs } from "pinia";
import {
  Picture, Box, Grid, Location, VideoPlay, Menu, Monitor,
} from "@element-plus/icons-vue";
import { useViewStore } from "../stores/viewStore";

const view = useViewStore();
const {
  terrainVisible, objectsVisible, gridVisible, locationsVisible,
  animate, objectPanelVisible, debugOverlay,
} = storeToRefs(view);

const tools = [
  { label: "Terrain", key: "T", icon: Picture, active: terrainVisible, toggle: () => view.setLayerVisible("terrain", !terrainVisible.value) },
  { label: "Objects", key: "O", icon: Box, active: objectsVisible, toggle: () => view.setLayerVisible("objects", !objectsVisible.value) },
  { label: "Grid", key: "G", icon: Grid, active: gridVisible, toggle: () => view.toggleGrid() },
  { label: "Locations", key: "L", icon: Location, active: locationsVisible, toggle: () => view.toggleLocations() },
  { label: "Animation", key: "A", icon: VideoPlay, active: animate, toggle: () => view.toggleAnimate() },
  { label: "Objects panel", key: "P", icon: Menu, active: objectPanelVisible, toggle: () => view.toggleObjectPanel() },
  { label: "Debug HUD", key: "D", icon: Monitor, active: debugOverlay, toggle: () => view.toggleDebugOverlay() },
];
</script>

<template>
  <div class="toolbar">
    <el-tooltip
      v-for="t in tools"
      :key="t.label"
      :content="`${t.label} (${t.key})`"
      placement="right"
      :show-after="250"
    >
      <el-button
        :type="t.active.value ? 'primary' : ''"
        :icon="t.icon"
        size="small"
        circle
        @click="t.toggle()"
      />
    </el-tooltip>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  height: 100%;
  background: var(--el-bg-color);
  border-right: 1px solid var(--el-border-color-light);
}
</style>
