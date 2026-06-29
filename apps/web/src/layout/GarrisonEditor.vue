<script setup lang="ts">
/**
 * GarrisonEditor — the city/capital garrison as a 2×3 formation (front line = even cells
 * 0/2/4, back line = odd cells 1/3/5, the D2 convention). Presentational only: it renders a
 * UnitPicker per cell + level/HP inputs and emits intent; the parent (ObjectInspector) owns
 * the undoable patchObject so all byte-writer-aware logic stays in one place.
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

const CELLS = [
  { cell: 0, label: "Фронт · лево" },
  { cell: 2, label: "Фронт · центр" },
  { cell: 4, label: "Фронт · право" },
  { cell: 1, label: "Тыл · лево" },
  { cell: 3, label: "Тыл · центр" },
  { cell: 5, label: "Тыл · право" },
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
        <div class="garr-cell-label">{{ c.label }}</div>
        <UnitPicker
          :model-value="garrison[c.cell]?.unit ?? null"
          nullable
          :title="`Юнит — ${c.label}`"
          @update:model-value="(v) => onPick(c.cell, v)"
        />
        <div v-if="garrison[c.cell]" class="garr-stats">
          <label>ур.</label>
          <el-input-number
            :model-value="garrison[c.cell]!.level"
            :min="1"
            :max="50"
            size="small"
            controls-position="right"
            @change="(v: number) => emit('setStat', c.cell, 'level', v ?? 1)"
          />
          <label>HP</label>
          <el-input-number
            :model-value="garrison[c.cell]!.hp"
            :min="0"
            size="small"
            controls-position="right"
            @change="(v: number) => emit('setStat', c.cell, 'hp', v ?? 0)"
          />
          <span v-if="unitStore.get(garrison[c.cell]!.unit)?.hp" class="garr-maxhp">
            / {{ unitStore.get(garrison[c.cell]!.unit)?.hp }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ro-block { display: flex; flex-direction: column; gap: 4px; }
.ro-label { font-size: 12px; color: var(--el-text-color-secondary); }
.muted { color: var(--el-text-color-secondary); }
.garr-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 4px;
}
.garr-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px 6px;
  border: 1px dashed var(--el-border-color);
  border-radius: var(--d2-radius-sm, 6px);
}
.garr-cell.filled {
  border-style: solid;
  background: var(--el-fill-color-lighter);
}
.garr-cell-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--el-text-color-placeholder);
}
.garr-cell :deep(.up-trigger) {
  width: 100%;
  justify-content: flex-start;
}
.garr-stats {
  display: flex;
  align-items: center;
  gap: 4px;
}
.garr-stats label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.garr-stats :deep(.el-input-number) {
  width: 78px;
}
.garr-maxhp {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}
</style>
