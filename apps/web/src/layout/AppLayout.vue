<script setup lang="ts">
/**
 * The Element Plus application shell: a header (menu bar), a body split into a
 * left object panel + the Pixi canvas host, and a footer status bar.
 *
 * Vue owns this DOM chrome; the <MapCanvasHost> is the only seam where PixiJS
 * takes over a div and renders the map.
 */
import { onMounted, onBeforeUnmount } from "vue";
import { useViewStore } from "../stores/viewStore";
import { getScene } from "../canvas/sceneHolder";
import TopMenuBar from "./TopMenuBar.vue";
import ToolbarPanel from "./ToolbarPanel.vue";
import LeftObjectPanel from "./LeftObjectPanel.vue";
import StatusBar from "./StatusBar.vue";
import MapCanvasHost from "../canvas/MapCanvasHost.vue";

const view = useViewStore();

/** Global view hotkeys (single keys; ignored while typing or with modifiers). */
function onKey(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  switch (e.key.toLowerCase()) {
    case "t": view.setLayerVisible("terrain", !view.terrainVisible); break;
    case "o": view.setLayerVisible("objects", !view.objectsVisible); break;
    case "g": view.toggleGrid(); break;
    case "l": view.toggleLocations(); break;
    case "a": view.toggleAnimate(); break;
    case "p": view.toggleObjectPanel(); break;
    case "d": view.toggleDebugOverlay(); break;
    case "f": getScene()?.fitView(); break;
    default: return;
  }
  e.preventDefault();
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <el-container class="app-root">
    <el-header class="app-header" height="40px">
      <TopMenuBar />
    </el-header>
    <el-container class="app-body">
      <div class="app-toolbar">
        <ToolbarPanel />
      </div>
      <el-aside v-if="view.objectPanelVisible" class="app-aside" width="220px">
        <LeftObjectPanel />
      </el-aside>
      <el-main class="app-main">
        <MapCanvasHost />
      </el-main>
    </el-container>
    <el-footer class="app-footer" height="28px">
      <StatusBar />
    </el-footer>
  </el-container>
</template>

<style scoped>
.app-root {
  height: 100vh;
  width: 100vw;
}
.app-header {
  padding: 0;
}
.app-body {
  flex: 1;
  min-height: 0;
}
.app-toolbar {
  flex: 0 0 auto;
}
.app-aside {
  padding: 0;
  overflow: hidden;
}
.app-main {
  padding: 0;
  position: relative;
  min-width: 0;
}
.app-footer {
  padding: 0;
}
</style>
