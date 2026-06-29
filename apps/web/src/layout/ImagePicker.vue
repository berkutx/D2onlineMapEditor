<script setup lang="ts">
/**
 * ImagePicker — a reusable visual chooser for an object's sprite-index field (ruin/chest
 * "Картинка", and any future object with an image variant). Self-contained: given the
 * objectId + field + a keyFn(index)->spriteKey, it drives the edit itself via editStore.
 *
 * Interaction (per request): hovering a variant PREVIEWS it live on the map immediately
 * (applyPreview, no journal entry); it only COMMITS when you click a cell. Leaving the grid
 * or closing the popover without a click reverts to the committed value.
 */
import { ref, computed, watch } from "vue";
import { ArrowDown } from "@element-plus/icons-vue";
import { useSpriteStore } from "../stores/spriteStore";
import { useEditStore } from "../stores/editStore";
import SpriteThumb from "./SpriteThumb.vue";

const props = withDefaults(
  defineProps<{ objectId: string; field?: string; keyFn: (i: number) => string; count: number; size?: number }>(),
  { field: "image", size: 52 },
);

const sprites = useSpriteStore();
const editStore = useEditStore();
const open = ref(false);

const indices = computed(() => Array.from({ length: props.count }, (_, i) => i));
function ensure(): void {
  void sprites.ensureKeys(indices.value.map(props.keyFn));
}
watch([() => props.count, () => props.keyFn], ensure, { immediate: true });

/** the object's current field value, read from the LIVE doc (so it follows the preview). */
const current = computed<number>(() => {
  const o = editStore.liveDoc?.objects.find((x) => x.id === props.objectId) as Record<string, unknown> | undefined;
  return (o?.[props.field] as number | undefined) ?? 0;
});

/** variants that have a frame; the current value is always included. */
const available = computed(() => {
  const list = indices.value.filter((i) => sprites.frameOf(props.keyFn(i)));
  if (!list.includes(current.value)) list.unshift(current.value);
  return list;
});

// --- hover preview / commit-on-click ---------------------------------------
let committed: number | null = null; // the real value, captured before the first preview
function patchField(i: number): { kind: "patchObject"; id: string; fields: Record<string, number> }[] {
  return [{ kind: "patchObject", id: props.objectId, fields: { [props.field]: i } }];
}
function preview(i: number): void {
  if (i === current.value) return;
  if (committed === null) committed = current.value;
  editStore.applyPreview(patchField(i));
}
function endPreview(): void {
  if (committed !== null) {
    editStore.applyPreview(patchField(committed));
    committed = null;
  }
}
function pick(i: number): void {
  committed = null; // this becomes the committed value
  editStore.commit(patchField(i));
  open.value = false;
}
watch(open, (v) => {
  if (v) ensure();
  else endPreview();
});
</script>

<template>
  <el-popover v-model:visible="open" trigger="click" :width="392" placement="bottom-end" :persistent="false">
    <template #reference>
      <button class="img-trigger" type="button">
        <SpriteThumb :sprite-key="keyFn(current)" :size="size" />
        <span class="img-idx">#{{ current }}</span>
        <el-icon class="img-caret"><ArrowDown /></el-icon>
      </button>
    </template>
    <div class="img-grid" @mouseleave="endPreview()">
      <button
        v-for="i in available"
        :key="i"
        class="img-cell"
        :class="{ active: i === current }"
        type="button"
        :title="`#${i}`"
        @mouseenter="preview(i)"
        @click="pick(i)"
      >
        <SpriteThumb :sprite-key="keyFn(i)" :size="76" />
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
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
  max-height: 60vh;
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
  border-color: var(--el-color-primary-light-5);
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
