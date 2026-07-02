<script setup lang="ts">
/**
 * ObjectActionBar — a light floating panel shown while the Move tool is carrying an
 * object, for RE-ROLLING its look (keeping its footprint), like the game's "change
 * appearance". 🎲 picks a random variant of the same group; the strip picks a specific
 * one; R / [ ] also work from the keyboard (AppLayout). Drops a `patchObject` commit.
 * Only appears for re-rollable objects (landmarks / mountains with >1 variant).
 */
import { computed } from "vue";
import { Refresh } from "@element-plus/icons-vue";
import { useToolStore } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";
import { useDecorStore } from "../stores/decorStore";
import DecorThumb from "./DecorThumb.vue";

const toolStore = useToolStore();
const editStore = useEditStore();
const decorStore = useDecorStore();

const carried = computed(() =>
  toolStore.moveId ? editStore.liveDoc?.objects.find((o) => o.id === toolStore.moveId) ?? null : null,
);
const curId = computed(() => (carried.value ? decorStore.catalogIdOf(carried.value) : null));
const group = computed(() => decorStore.groupOf(curId.value));
const reRollable = computed(() => !!group.value && group.value.variants.length > 1);

function reroll(variantId: string): void {
  const obj = carried.value;
  if (!obj) return;
  const fields = decorStore.variantPatch(obj, variantId);
  if (fields) editStore.commit([{ kind: "patchObject", id: obj.id, fields }]);
}
function random(): void {
  const next = decorStore.randomVariant(curId.value);
  if (next) reroll(next);
}
</script>

<template>
  <div v-if="carried && reRollable" class="obj-actions d2-float">
    <DecorThumb :thumb="decorStore.get(curId)?.thumb ?? group!.rep.thumb" :size="40" />
    <div class="oa-info">
      <div class="oa-name">{{ group!.label }}</div>
      <div class="oa-hint">Облик · R — случайный · [ ] — листать</div>
    </div>
    <el-button class="oa-roll" size="small" :icon="Refresh" circle title="Случайный облик (R)" @click="random()" />
    <el-scrollbar class="oa-strip">
      <div class="oa-row">
        <button
          v-for="v in group!.variants"
          :key="v.id"
          type="button"
          class="oa-cell"
          :class="{ sel: v.id === curId }"
          :title="v.desc_en"
          @click="reroll(v.id)"
        >
          <DecorThumb :thumb="v.thumb" :size="30" />
        </button>
      </div>
    </el-scrollbar>
  </div>
</template>

<style scoped>
.obj-actions {
  /* elevation/glass comes from the shared .d2-float */
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 25;
  max-width: min(640px, 92%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
}
.oa-info {
  min-width: 0;
}
.oa-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.oa-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.oa-roll {
  flex: 0 0 auto;
  /* icon-only action sits back until pointed at (calmer) */
  opacity: 0.6;
  transition: opacity 0.12s ease;
}
.oa-roll:hover {
  opacity: 1;
}
.oa-strip {
  flex: 1;
  min-width: 0;
  max-width: 360px;
}
.oa-row {
  display: flex;
  gap: 4px;
  padding-bottom: 4px;
}
/* no border framing: the checkerboard fill stays (transparency backdrop);
 * hover/selection are soft rings, not frames */
.oa-cell {
  flex: 0 0 auto;
  padding: 2px;
  border: none;
  border-radius: var(--d2-radius);
  background: repeating-conic-gradient(var(--el-fill-color) 0% 25%, transparent 0% 50%) 0 / 12px 12px;
  cursor: pointer;
  transition: box-shadow 0.12s ease;
}
.oa-cell:hover {
  box-shadow: 0 0 0 1px var(--el-border-color-lighter);
}
.oa-cell.sel {
  box-shadow: 0 0 0 2px var(--d2-active-bar);
}
</style>
