<script setup lang="ts">
/**
 * SpriteThumb — renders one object sprite (by atlas KEY) as a fixed-size thumbnail by
 * CSS-cropping the atlas page (resolved via spriteStore). Used by the visual ImagePicker
 * so the "Картинка" field shows the actual sprite instead of a bare number.
 */
import { computed } from "vue";
import { useSpriteStore } from "../stores/spriteStore";

const props = withDefaults(defineProps<{ spriteKey: string | null; size?: number }>(), {
  spriteKey: null,
  size: 48,
});

const store = useSpriteStore();
const rect = computed(() => store.frameOf(props.spriteKey));
const scale = computed(() => {
  const r = rect.value;
  return r ? Math.min(props.size / r.w, props.size / r.h, 3) : 1;
});
const cropStyle = computed(() => {
  const r = rect.value;
  if (!r) return {};
  return {
    width: `${r.w}px`,
    height: `${r.h}px`,
    backgroundImage: `url(/assets/${r.page})`,
    backgroundPosition: `-${r.x}px -${r.y}px`,
    transform: `scale(${scale.value})`,
  };
});
const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
</script>

<template>
  <span class="sprite-thumb" :style="box">
    <span v-if="rect" class="crop" :style="cropStyle" />
    <span v-else class="ph">?</span>
  </span>
</template>

<style scoped>
.sprite-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex: 0 0 auto;
}
.crop {
  /* flex:none so the centering flex parent never shrinks the fixed frame width/height —
     otherwise a sprite wider than the box gets its right side clipped ("half" sprites). */
  flex: none;
  display: block;
  background-repeat: no-repeat;
  transform-origin: center center;
  image-rendering: pixelated;
}
.ph {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}
</style>
