<script setup lang="ts">
/**
 * ImagePicker — a visual chooser for an object's IMAGE index. The trigger shows the current
 * sprite thumbnail + index; clicking opens a popover grid of all available variants (rendered
 * from the atlas via SpriteThumb). Reusable: caller supplies a keyFn(index)->spriteKey + count.
 */
import { ref, computed, watch } from "vue";
import { ArrowDown } from "@element-plus/icons-vue";
import { useSpriteStore } from "../stores/spriteStore";
import SpriteThumb from "./SpriteThumb.vue";

const props = withDefaults(
  defineProps<{ modelValue: number; keyFn: (i: number) => string; count: number; size?: number }>(),
  { size: 40 },
);
const emit = defineEmits<{ "update:modelValue": [number] }>();

const store = useSpriteStore();
const open = ref(false);

const indices = computed(() => Array.from({ length: props.count }, (_, i) => i));
function ensure(): void {
  void store.ensureKeys(indices.value.map(props.keyFn));
}
watch([() => props.count, () => props.keyFn], ensure, { immediate: true });

/** variants that actually have a frame (skips gaps); the current value is always shown. */
const available = computed(() => {
  const list = indices.value.filter((i) => store.frameOf(props.keyFn(i)));
  if (!list.includes(props.modelValue)) list.unshift(props.modelValue);
  return list;
});
const currentKey = computed(() => props.keyFn(props.modelValue));

function pick(i: number): void {
  emit("update:modelValue", i);
  open.value = false;
}
</script>

<template>
  <el-popover v-model:visible="open" trigger="click" :width="300" placement="bottom-end" :persistent="false">
    <template #reference>
      <button class="img-trigger" type="button">
        <SpriteThumb :sprite-key="currentKey" :size="size" />
        <span class="img-idx">#{{ modelValue }}</span>
        <el-icon class="img-caret"><ArrowDown /></el-icon>
      </button>
    </template>
    <div class="img-grid">
      <button
        v-for="i in available"
        :key="i"
        class="img-cell"
        :class="{ active: i === modelValue }"
        type="button"
        :title="`#${i}`"
        @click="pick(i)"
      >
        <SpriteThumb :sprite-key="keyFn(i)" :size="44" />
        <span class="cell-idx">{{ i }}</span>
      </button>
    </div>
  </el-popover>
</template>

<style scoped>
.img-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border: var(--d2-hairline, 1px solid var(--el-border-color));
  border-radius: var(--d2-radius-sm, 6px);
  background: var(--el-fill-color-blank);
  cursor: pointer;
  color: var(--el-text-color-primary);
}
.img-trigger:hover {
  border-color: var(--el-color-primary);
}
.img-idx {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}
.img-caret {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.img-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
  max-height: 320px;
  overflow-y: auto;
}
.img-cell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  cursor: pointer;
}
.img-cell:hover {
  background: var(--el-fill-color);
}
.img-cell.active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.cell-idx {
  position: absolute;
  bottom: 1px;
  right: 3px;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color);
  border-radius: 3px;
  padding: 0 2px;
  opacity: 0.85;
}
</style>
