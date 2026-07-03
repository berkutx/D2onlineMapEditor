<script setup lang="ts">
/**
 * MinimapDock — a persistent minimap: a floating .d2-float card hosting the reusable
 * <MiniMap> (object-dots layer on). DRAGGABLE by its header (position remembered per browser
 * via useFloatingDock, key "minimap") and clamped to the canvas. Default corner = bottom-right.
 * Collapsed state = a small round 🗺 button in the same corner. Visibility persists via
 * viewStore (minimapVisible) and is toggleable from Вид ▸ Миникарта.
 */
import { ref } from "vue";
import { useViewStore } from "../stores/viewStore";
import { useFloatingDock } from "../composables/useFloatingDock";
import MiniMap from "./MiniMap.vue";

const view = useViewStore();
const card = ref<HTMLElement | null>(null);
const { style, onHandlePointerDown } = useFloatingDock("minimap", card);
</script>

<template>
  <div v-if="view.minimapVisible" ref="card" class="minimap-dock d2-float" :style="style">
    <div class="mm-head" title="Перетащите за заголовок" @pointerdown="onHandlePointerDown">
      <span class="mm-grip">⠿</span>
      <span class="mm-title d2-sec">карта</span>
      <button class="mm-close" title="Скрыть миникарту" @click="view.toggleMinimap()">✕</button>
    </div>
    <MiniMap :size="220" show-objects />
  </div>
  <button
    v-else
    class="minimap-fab d2-float"
    title="Миникарта"
    @click="view.toggleMinimap()"
  >🗺</button>
</template>

<style scoped>
/* Default corner = bottom-RIGHT of .app-main. Collapsed by default (a small 🗺 FAB), so it
   doesn't fight the centre Copilot; expanded it's draggable — useFloatingDock supplies inline
   left/top once moved. Sits under body-teleported dialogs. */
.minimap-dock {
  position: absolute;
  right: 12px;
  bottom: 8px;
  z-index: 26;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px 8px;
}
.mm-head {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.mm-head:active {
  cursor: grabbing;
}
.mm-grip {
  color: var(--el-text-color-secondary);
  opacity: 0.5;
  font-size: 12px;
  line-height: 1;
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
  bottom: 8px;
  z-index: 26;
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
