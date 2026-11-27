<script setup lang="ts">
/**
 * One picture of a mod, cropped from its sheet with CSS (like layout/SpriteThumb.vue, but
 * for any mod: the sheet comes with the picture), scaled to fit a square box.
 */
import { computed } from "vue";
import type { PictureSide } from "@d2/mod-diff";
import { storeUrl } from "./pictures";

const props = withDefaults(defineProps<{ pic: PictureSide | null | undefined; size?: number; maxScale?: number }>(), {
  size: 64,
  maxScale: 2,
});

const rect = computed(() => {
  const r = props.pic?.rect;
  if (!props.pic?.image || !r || r.length < 4) return null;
  const [x = 0, y = 0, w = 0, h = 0] = r;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
});
const style = computed(() => {
  const r = rect.value;
  if (!r || !props.pic?.image) return {};
  const scale = Math.min(props.size / r.w, props.size / r.h, props.maxScale);
  return {
    width: `${r.w}px`,
    height: `${r.h}px`,
    backgroundImage: `url(${storeUrl(props.pic.image)})`,
    backgroundPosition: `-${r.x}px -${r.y}px`,
    transform: `scale(${scale})`,
  };
});
const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
const title = computed(() => (rect.value ? `${rect.value.w}×${rect.value.h}` : ""));
</script>

<template>
  <span class="sprite-crop" :style="box" :title="title">
    <span v-if="rect" class="crop" :style="style" />
    <span v-else class="none">—</span>
  </span>
</template>

<style scoped>
.sprite-crop {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex: 0 0 auto;
  border-radius: 4px;
  background: var(--mods-pic-bg);
}
.crop {
  flex: none;
  display: block;
  background-repeat: no-repeat;
  transform-origin: center center;
  image-rendering: pixelated;
}
.none {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}
</style>
