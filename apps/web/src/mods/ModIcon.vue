<script setup lang="ts">
/** An icon file of a mod (unit, item, spell, lord icon), or a dash when the mod has none. */
import { ref, watch } from "vue";

const props = withDefaults(defineProps<{ url: string | null | undefined; size?: number; title?: string }>(), { size: 32, title: "" });
const failed = ref(false);
watch(
  () => props.url,
  () => (failed.value = false),
);
</script>

<template>
  <span class="mod-icon" :style="{ width: `${size}px`, height: `${size}px` }" :title="title">
    <img v-if="url && !failed" :src="url" alt="" loading="lazy" @error="failed = true" />
    <span v-else class="none">—</span>
  </span>
</template>

<style scoped>
.mod-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: 4px;
  background: var(--mods-pic-bg);
}
img {
  max-width: 100%;
  max-height: 100%;
  image-rendering: pixelated;
}
.none {
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}
</style>
