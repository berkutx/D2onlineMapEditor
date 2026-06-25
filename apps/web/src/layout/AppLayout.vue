<script setup lang="ts">
/**
 * The Element Plus application shell: a header (menu bar), a body split into a
 * left object panel + the Pixi canvas host, and a footer status bar.
 *
 * Vue owns this DOM chrome; the <MapCanvasHost> is the only seam where PixiJS
 * takes over a div and renders the map.
 */
import TopMenuBar from "./TopMenuBar.vue";
import LeftObjectPanel from "./LeftObjectPanel.vue";
import StatusBar from "./StatusBar.vue";
import MapCanvasHost from "../canvas/MapCanvasHost.vue";
</script>

<template>
  <el-container class="app-root">
    <el-header class="app-header" height="40px">
      <TopMenuBar />
    </el-header>
    <el-container class="app-body">
      <el-aside class="app-aside" width="220px">
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
