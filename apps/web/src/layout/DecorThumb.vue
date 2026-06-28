<script setup lang="ts">
/**
 * DecorThumb — renders one decoration sprite as a fixed-size thumbnail by CSS-cropping
 * the existing atlas page (no extra image assets). The `thumb` rect {page,x,y,w,h} comes
 * from decorCatalog.json; we scale the cropped frame to fit `size` and centre it.
 */
import { computed } from "vue";
import type { DecorThumb } from "../stores/decorStore";

const props = withDefaults(defineProps<{ thumb: DecorThumb; size?: number }>(), {
  size: 64,
});

const scale = computed(() => Math.min(props.size / props.thumb.w, props.size / props.thumb.h, 3));

const cropStyle = computed(() => ({
  width: `${props.thumb.w}px`,
  height: `${props.thumb.h}px`,
  backgroundImage: `url(/assets/${props.thumb.page})`,
  backgroundPosition: `-${props.thumb.x}px -${props.thumb.y}px`,
  transform: `scale(${scale.value})`,
}));

const boxStyle = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
</script>

<template>
  <div class="decor-thumb" :style="boxStyle">
    <div class="crop" :style="cropStyle" />
  </div>
</template>

<style scoped>
.decor-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex: 0 0 auto;
}
.crop {
  background-repeat: no-repeat;
  transform-origin: center center;
  image-rendering: pixelated;
}
</style>
