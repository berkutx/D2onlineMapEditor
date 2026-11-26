<script setup lang="ts">
/**
 * RoadActionBar — a light floating panel shown while the roadsel tool has a segment
 * selected: erase / grow / drop the selection without reaching for the keyboard
 * (Del and Esc still work — both surfaces share useRoadActions). Mirrors the
 * ObjectActionBar skeleton (.d2-float, top-center).
 */
import { computed } from "vue";
import { Delete, Plus, Close } from "@element-plus/icons-vue";
import { useToolStore } from "../stores/toolStore";
import { useRoadActions } from "../composables/roadActions";
import { tr, trn } from "../i18n";

const toolStore = useToolStore();
const { eraseSelected, expandSelection, clearSelection, canExpand } = useRoadActions();

const LEVEL_LABEL = [tr("прямая"), tr("нить"), tr("вся сеть")] as const;
const levelLabel = computed(() => LEVEL_LABEL[toolStore.roadLevel] ?? "");
</script>

<template>
  <div v-if="toolStore.roadSel.length" class="road-actions d2-float">
    <div class="ra-info">
      <div class="ra-name">{{ trn("Дорога: {n} кл. · {level}", toolStore.roadSel.length, { level: levelLabel }) }}</div>
      <div class="ra-hint">{{ tr("клик по той же клетке — расширить · Del — стереть · Esc — снять") }}</div>
    </div>
    <el-button size="small" :icon="Plus" :disabled="!canExpand" :title="tr('Расширить выделение (ещё клик по той же клетке)')" @click="expandSelection()">
      {{ tr("Больше") }}
    </el-button>
    <el-button size="small" type="danger" plain :icon="Delete" :title="tr('Стереть выделенную дорогу (Del)')" @click="eraseSelected()">
      {{ tr("Стереть") }}
    </el-button>
    <el-button size="small" :icon="Close" circle :title="tr('Снять выделение (Esc)')" @click="clearSelection()" />
  </div>
</template>

<style scoped>
.road-actions {
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
.ra-info {
  min-width: 0;
}
.ra-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
}
.ra-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
</style>
