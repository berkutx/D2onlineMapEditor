<script setup lang="ts">
/**
 * GarrisonEditor — a garrison as the in-game VERTICAL formation: 2 columns × 3 rows, with the
 * RIGHT column = FRONT line (even cells 0/2/4) and the LEFT column = BACK line (odd cells 1/3/5);
 * rows top→bottom = formation column index (cell/2). Verified vs D2RSG/D2ModdingToolset
 * (even cell = front, cell/2 = column). DOM order for the 2-col row-major grid = [1,0,3,2,5,4].
 * Presentational only: emits intent; the parent (ObjectInspector) owns the undoable patchObject.
 */
import UnitPicker from "./UnitPicker.vue";
import UnitIcon from "./UnitIcon.vue";
import { useUnitStore } from "../stores/unitStore";

type GarrUnit = { unit: string; level: number; hp: number };

withDefaults(
  defineProps<{
    garrison: (GarrUnit | null)[]; // length 6, by formation cell
    count: number;
    readonly?: boolean; // visitor garrison is shown read-only until the full Отряд editor lands
  }>(),
  { readonly: false },
);
const emit = defineEmits<{
  setUnit: [cell: number, unitId: string];
  clear: [cell: number];
  setStat: [cell: number, key: "level" | "hp", value: number];
}>();

const unitStore = useUnitStore();

// Row-major order for a 2-col grid: each row = one formation column (cell/2); left=back (odd),
// right=front (even). Row0=[1,0], row1=[3,2], row2=[5,4].
const CELLS = [1, 0, 3, 2, 5, 4];

function onPick(cell: number, v: string | null): void {
  if (v) emit("setUnit", cell, v);
  else emit("clear", cell);
}
</script>

<template>
  <div class="ro-block">
    <div class="garr-cols"><span>Тыл</span><span>Фронт</span></div>
    <div class="garr-grid">
      <div v-for="cell in CELLS" :key="cell" class="garr-cell" :class="{ filled: !!garrison[cell], ro: readonly }">
        <template v-if="readonly">
          <div class="garr-ro">
            <UnitIcon
              :id="garrison[cell]?.unit ?? null"
              :level="unitStore.get(garrison[cell]?.unit)?.level"
              :subrace-id="unitStore.get(garrison[cell]?.unit)?.subraceId ?? -1"
              :size="22"
            />
            <span class="garr-ro-name">{{ garrison[cell] ? unitStore.nameOf(garrison[cell]!.unit) : "—" }}</span>
          </div>
          <div v-if="garrison[cell]" class="garr-ro-stats">ур.{{ garrison[cell]!.level }} · {{ garrison[cell]!.hp }} HP</div>
        </template>
        <template v-else>
          <UnitPicker
            :model-value="garrison[cell]?.unit ?? null"
            nullable
            :title="`Юнит — ${cell % 2 === 0 ? 'передняя' : 'задняя'} линия`"
            @update:model-value="(v) => onPick(cell, v)"
          />
          <div v-if="garrison[cell]" class="garr-stats">
          <span class="garr-stat">
            <label>ур.</label>
            <el-input-number
              :model-value="garrison[cell]!.level"
              :min="1"
              :max="50"
              size="small"
              :controls="false"
              @change="(v: number) => emit('setStat', cell, 'level', v ?? 1)"
            />
          </span>
          <span class="garr-stat">
            <label>HP</label>
            <el-input-number
              :model-value="garrison[cell]!.hp"
              :min="0"
              :max="unitStore.get(garrison[cell]!.unit)?.hp || 9999"
              size="small"
              :controls="false"
              @change="(v: number) => emit('setStat', cell, 'hp', v ?? 0)"
            />
          </span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ro-block { display: flex; flex-direction: column; gap: 4px; }
.garr-cols {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--d2-sp-1, 4px);
}
.garr-cols span {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--el-text-color-placeholder);
  text-align: center;
}
.garr-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--d2-sp-1, 4px);
}
.garr-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px;
  min-width: 0;
  border: 1px dashed var(--el-border-color);
  border-radius: var(--d2-radius-sm, 6px);
}
.garr-cell.filled {
  border-style: solid;
  background: var(--el-fill-color-lighter);
}
.garr-cell.ro {
  gap: 2px;
  padding: 4px 5px;
}
.garr-ro {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.garr-ro-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.garr-ro-stats {
  font-size: 10px;
  color: var(--el-text-color-secondary);
  padding-left: 27px;
}
.garr-cell :deep(.up-wrap) { width: 100%; }
.garr-cell :deep(.up-trigger) { width: 100%; justify-content: flex-start; padding: 4px 6px; }
.garr-cell :deep(.up-trigger-text) { max-width: 100%; }
.garr-stats {
  display: flex;
  align-items: center;
  gap: 6px;
}
.garr-stat {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: 1 1 0;
  min-width: 0;
}
.garr-stat label {
  flex: 0 0 auto;
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
</style>
