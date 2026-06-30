<script setup lang="ts">
/**
 * GarrisonEditor — the city/capital garrison as a real 2×3 battle formation, like the game.
 * Verified vs D2RSG/D2ModdingToolset: columns are POS pairs (0,1),(2,3),(4,5) [column = cell/2];
 * EVEN cells (0,2,4) = FRONT line (toward the enemy), ODD (1,3,5) = BACK line. We draw FRONT on
 * the TOP row, BACK on the bottom, columns left→right (col0,col1,col2). Presentational only: it
 * renders a UnitPicker per cell + level/HP inputs and emits intent; the parent (ObjectInspector)
 * owns the undoable patchObject so all byte-writer-aware logic stays in one place.
 */
import UnitPicker from "./UnitPicker.vue";
import { useUnitStore } from "../stores/unitStore";

type GarrUnit = { unit: string; level: number; hp: number };

defineProps<{
  garrison: (GarrUnit | null)[]; // length 6, by formation cell
  count: number;
}>();
const emit = defineEmits<{
  setUnit: [cell: number, unitId: string];
  clear: [cell: number];
  setStat: [cell: number, key: "level" | "hp", value: number];
}>();

const unitStore = useUnitStore();

// Row-major order for a 3-column grid: front row (even cells) first, then back row (odd cells).
const CELLS = [
  { cell: 0, col: "Лево" },
  { cell: 2, col: "Центр" },
  { cell: 4, col: "Право" },
  { cell: 1, col: "Лево" },
  { cell: 3, col: "Центр" },
  { cell: 5, col: "Право" },
];

function onPick(cell: number, v: string | null): void {
  if (v) emit("setUnit", cell, v);
  else emit("clear", cell);
}
</script>

<template>
  <div class="ro-block">
    <div class="ro-label">Гарнизон <span class="muted">({{ count }}/6)</span></div>
    <div class="garr-grid">
      <div v-for="c in CELLS" :key="c.cell" class="garr-cell" :class="{ filled: !!garrison[c.cell] }">
        <UnitPicker
          :model-value="garrison[c.cell]?.unit ?? null"
          nullable
          :title="`Юнит — ${c.cell % 2 === 0 ? 'фронт' : 'тыл'} · ${c.col.toLowerCase()}`"
          @update:model-value="(v) => onPick(c.cell, v)"
        />
        <div v-if="garrison[c.cell]" class="garr-stats">
          <span class="garr-stat">
            <label>ур.</label>
            <el-input-number
              :model-value="garrison[c.cell]!.level"
              :min="1"
              :max="50"
              size="small"
              :controls="false"
              @change="(v: number) => emit('setStat', c.cell, 'level', v ?? 1)"
            />
          </span>
          <span class="garr-stat">
            <label>HP</label>
            <el-input-number
              :model-value="garrison[c.cell]!.hp"
              :min="0"
              :max="unitStore.get(garrison[c.cell]!.unit)?.hp || 9999"
              size="small"
              :controls="false"
              @change="(v: number) => emit('setStat', c.cell, 'hp', v ?? 0)"
            />
          </span>
        </div>
      </div>
    </div>
    <div class="garr-legend"><span>↑ передняя линия</span><span>↓ задняя линия</span></div>
  </div>
</template>

<style scoped>
.ro-block { display: flex; flex-direction: column; gap: 4px; }
.ro-label { font-size: 12px; color: var(--el-text-color-secondary); }
.muted { color: var(--el-text-color-secondary); }
.garr-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
.garr-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px;
  min-width: 0;
  border: 1px dashed var(--el-border-color);
  border-radius: var(--d2-radius-sm, 6px);
}
.garr-cell.filled {
  border-style: solid;
  background: var(--el-fill-color-lighter);
}
/* the unit picker trigger fills the cell and truncates the name */
.garr-cell :deep(.up-wrap) { width: 100%; }
.garr-cell :deep(.up-trigger) { width: 100%; justify-content: flex-start; padding: 4px 6px; }
.garr-cell :deep(.up-trigger-text) { max-width: 100%; }
.garr-stats {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.garr-stat {
  display: flex;
  align-items: center;
  gap: 4px;
}
.garr-stat label {
  flex: 0 0 22px;
  font-size: 10px;
  color: var(--el-text-color-secondary);
}
.garr-stat :deep(.el-input-number) {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}
.garr-stat :deep(.el-input-number .el-input__inner) {
  text-align: left;
  padding: 0 4px;
}
.garr-legend {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  padding: 0 2px;
}
</style>
