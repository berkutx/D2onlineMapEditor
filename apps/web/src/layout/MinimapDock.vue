<script setup lang="ts">
/**
 * MinimapDock — постоянная миникарта: a floating .d2-float card at the canvas'
 * bottom-RIGHT corner (Copilot owns bottom-center, so the corner is free) hosting
 * the reusable <MiniMap> with the object-dots layer on. Collapsed state = a small
 * round 🗺 button in the same corner. Visibility persists via viewStore
 * (`minimapVisible`, d2.view.v1) and is also toggleable from Вид ▸ Миникарта.
 */
import { useViewStore } from "../stores/viewStore";
import MiniMap from "./MiniMap.vue";

const view = useViewStore();
</script>

<template>
  <div v-if="view.minimapVisible" class="minimap-dock d2-float">
    <div class="mm-head">
      <span class="mm-title d2-sec">карта</span>
      <button class="mm-close" title="Скрыть миникарту" @click="view.toggleMinimap()">✕</button>
    </div>
    <MiniMap :size="176" show-objects />
  </div>
  <button
    v-else
    class="minimap-fab d2-float"
    title="Миникарта"
    @click="view.toggleMinimap()"
  >🗺</button>
</template>

<style scoped>
/* Bottom-right of .app-main; Copilot floats bottom-CENTER, so no overlap. Sits
   under body-teleported dialogs (z≈2000) and under the История card (z 30). */
.minimap-dock {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 25;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px 8px;
}
.mm-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mm-title {
  margin: 0; /* .d2-sec carries rail margins — the dock header is tight */
}
.mm-close {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: var(--d2-radius);
  opacity: 0.6;
  transition: opacity 0.12s ease;
}
.mm-close:hover {
  opacity: 1;
  background: var(--el-fill-color-light);
}
.minimap-fab {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 25;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.12s ease;
}
.minimap-fab:hover {
  opacity: 1;
}
</style>
