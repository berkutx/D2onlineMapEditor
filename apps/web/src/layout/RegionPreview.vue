<script setup lang="ts">
/**
 * RegionPreview — a small OVERLAY-FREE snapshot of the map region around a cell (terrain +
 * decor + buildings + chests + stacks; NO locations/roles/threads/grid). Shows «which point»
 * a scenario location means, sprite-accurately, without jumping the live camera. The image is
 * produced by Scene.renderRegionPreview into an offscreen canvas that we drop into the box.
 */
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { getScene } from "../canvas/sceneHolder";

const props = withDefaults(
  defineProps<{ cell: { x: number; y: number } | null; radius?: number; width?: number }>(),
  { radius: 4, width: 240 },
);

const box = ref<HTMLDivElement | null>(null);
const ok = ref(false);

function render(): void {
  const host = box.value;
  if (!host) return;
  host.replaceChildren();
  ok.value = false;
  if (!props.cell) return;
  const canvas = getScene()?.renderRegionPreview(props.cell, { radiusCells: props.radius, pxWidth: props.width });
  if (!canvas) return;
  canvas.style.cssText = "width:100%;height:auto;display:block;image-rendering:pixelated";
  host.appendChild(canvas);
  ok.value = true;
}

watch(() => [props.cell?.x, props.cell?.y, props.radius, props.width], () => render());
onMounted(render);
onBeforeUnmount(() => box.value?.replaceChildren());
</script>

<template>
  <div class="region-preview">
    <div ref="box" class="rp-box" />
    <p v-if="!ok" class="rp-empty">нет превью точки</p>
  </div>
</template>

<style scoped>
.region-preview {
  border: 1px solid var(--el-border-color, #444);
  border-radius: var(--d2-radius-sm, 6px);
  overflow: hidden;
  background: #05070a;
}
.rp-box { line-height: 0; }
.rp-empty {
  margin: 0;
  padding: 12px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
