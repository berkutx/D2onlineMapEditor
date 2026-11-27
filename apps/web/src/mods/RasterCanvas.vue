<script setup lang="ts">
/**
 * An RGBA raster on a canvas, pixels kept sharp when enlarged. Either at a fixed zoom (the
 * element is width×zoom wide) or fitted into a square box (`fit`, at most `maxScale`).
 */
import { computed, onMounted, ref, watch } from "vue";
import type { Raster } from "./pixelDiff";

const props = withDefaults(defineProps<{ raster: Raster | null | undefined; zoom?: number; fit?: number; maxScale?: number; checker?: boolean }>(), {
  zoom: 1,
  fit: 0,
  maxScale: 2,
  checker: false,
});

const canvas = ref<HTMLCanvasElement | null>(null);

function draw(): void {
  const el = canvas.value;
  const r = props.raster;
  if (!el || !r || r.width <= 0 || r.height <= 0) return;
  el.width = r.width;
  el.height = r.height;
  const ctx = el.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(r.width, r.height);
  img.data.set(r.data);
  ctx.putImageData(img, 0, 0);
}
onMounted(draw);
watch(() => props.raster, draw, { flush: "post" });

const scale = computed(() => {
  const r = props.raster;
  if (!r || !r.width || !r.height) return 1;
  return props.fit > 0 ? Math.min(props.fit / r.width, props.fit / r.height, props.maxScale) : props.zoom;
});
const canvasStyle = computed(() => {
  const r = props.raster;
  if (!r) return {};
  return { width: `${r.width * scale.value}px`, height: `${r.height * scale.value}px` };
});
const boxStyle = computed(() => (props.fit > 0 ? { width: `${props.fit}px`, height: `${props.fit}px` } : {}));
</script>

<template>
  <span class="raster" :class="{ fitted: fit > 0, checker }" :style="boxStyle">
    <canvas v-if="raster && raster.width && raster.height" ref="canvas" :style="canvasStyle" />
    <span v-else class="none">—</span>
  </span>
</template>

<style scoped>
.raster {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: 4px;
  background: var(--mods-pic-bg);
}
.raster.checker {
  background-color: var(--mods-pic-bg);
  background-image:
    linear-gradient(45deg, rgba(127, 127, 127, 0.18) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(127, 127, 127, 0.18) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(127, 127, 127, 0.18) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(127, 127, 127, 0.18) 75%);
  background-size: 16px 16px;
  background-position:
    0 0,
    0 8px,
    8px -8px,
    -8px 0;
}
.raster:not(.fitted) {
  border-radius: 0;
}
canvas {
  display: block;
  flex: none;
  image-rendering: pixelated;
}
.none {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}
</style>
