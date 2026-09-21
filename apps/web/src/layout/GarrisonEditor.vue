<script setup lang="ts">
/** Shared formation for map stacks, city/ruin garrisons and event templates.
 *  Back = odd cells on the left; front = even cells on the right, in game order.
 *  The grid is an overview; only the selected unit gets a properties panel.
 *  Emits intent only. Parents own persistence, undo and shared-entity updates. */
import { computed, nextTick, ref, watch } from "vue";
import { useFormDisabled } from "element-plus";
import UnitPicker from "./UnitPicker.vue";
import UnitIcon from "./UnitIcon.vue";
import ModifierListEditor from "./ModifierListEditor.vue";
import { useUnitStore, roleLabel } from "../stores/unitStore";
import { useModifierStore } from "../stores/modifierStore";

type GarrUnit = { unit: string; level: number; hp: number; modifiers?: string[]; key?: string };
const props = withDefaults(defineProps<{
  garrison: (GarrUnit | null)[];
  count: number;
  readonly?: boolean;
  leaderCell?: number;
  roster?: "soldiers" | "all";
  /** Templates store levels, but no per-unit HP. */
  hideHp?: boolean;
  cellClearable?: (cell: number) => boolean;
}>(), { readonly: false, roster: "all", hideHp: false });
const emit = defineEmits<{
  setUnit: [cell: number, unitId: string];
  clear: [cell: number];
  setStat: [cell: number, key: "level" | "hp", value: number];
  setLeader: [cell: number];
  setMods: [cell: number, mods: string[]];
}>();

const unitStore = useUnitStore();
const modifierStore = useModifierStore();
const formDisabled = useFormDisabled();
const isReadOnly = computed(() => props.readonly || formDisabled.value);
const selectedCell = ref<number | null>(null);
const picker = ref<InstanceType<typeof UnitPicker> | null>(null);

const slots = computed(() => {
  const out: { cell: number; wide: boolean }[] = [];
  for (let row = 0; row < 3; row++) {
    const front = row * 2, back = front + 1;
    const key = props.garrison[front]?.key;
    if (key && props.garrison[back]?.key === key) out.push({ cell: front, wide: true });
    else out.push({ cell: back, wide: false }, { cell: front, wide: false });
  }
  return out;
});
const selectedSlot = computed(() => slots.value.find((s) => s.cell === selectedCell.value));
const selectedUnit = computed(() => selectedCell.value === null ? null : props.garrison[selectedCell.value] ?? null);
const selectedEntry = computed(() => unitStore.get(selectedUnit.value?.unit));
const canClear = computed(() => selectedCell.value !== null && (props.cellClearable?.(selectedCell.value) ?? true));
const isLeader = (cell: number): boolean => props.leaderCell === cell ||
  (!!props.garrison[cell]?.key && props.garrison[cell]?.key === props.garrison[props.leaderCell ?? -1]?.key);
const hasLeader = computed(() => unitStore.isLeaderCategory(props.garrison[props.leaderCell ?? -1]?.unit));
const selectedIsLeader = computed(() => selectedCell.value !== null && isLeader(selectedCell.value));
const canLead = computed(() => props.leaderCell !== undefined && unitStore.isLeaderCategory(selectedUnit.value?.unit));
const lineName = (cell: number): string => cell % 2 === 0 ? "Фронт" : "Тыл";
const positionLabel = computed(() => selectedSlot.value?.wide ? "Обе линии · 2 клетки" :
  selectedCell.value !== null ? lineName(selectedCell.value) + " · ряд " + (Math.floor(selectedCell.value / 2) + 1) : "");

// A replacement with a large unit merges the row. Follow that entity's primary cell.
watch(slots, () => {
  const cell = selectedCell.value;
  if (cell !== null && !slots.value.some((s) => s.cell === cell)) selectedCell.value = cell & ~1;
});
watch(() => selectedUnit.value?.modifiers?.length ?? 0, (count) => {
  if (count) void modifierStore.load();
}, { immediate: true });
const modifiers = computed(() => {
  const counts = new Map<string, number>();
  for (const id of selectedUnit.value?.modifiers ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].map(([id, count]) => ({ id, count, entry: modifierStore.catalog[id] }));
});

function rosterFor(cell: number): "leaders" | "soldiers" | "all" {
  if (props.leaderCell === undefined) return props.roster;
  return !hasLeader.value || isLeader(cell) ? "leaders" : "soldiers";
}
function bigBlockedReason(cell: number, unitId: string): string {
  if (!unitStore.isLarge(unitId)) return "";
  const partner = cell ^ 1;
  const curKey = props.garrison[cell]?.key;
  if (curKey && curKey === props.garrison[partner]?.key) return "";
  return props.garrison[partner] && props.leaderCell === partner
    ? "Соседняя клетка занята лидером — большой юнит занял бы обе клетки" : "";
}
async function selectCell(cell: number): Promise<void> {
  if (isReadOnly.value && !props.garrison[cell]) return;
  selectedCell.value = cell;
  if (!props.garrison[cell] && !isReadOnly.value) {
    await nextTick();
    picker.value?.show();
  }
}
function onPick(unitId: string | null): void {
  const cell = selectedCell.value;
  if (cell === null || isReadOnly.value) return;
  if (unitId && !bigBlockedReason(cell, unitId)) emit("setUnit", cell, unitId);
  else if (!unitId && canClear.value) emit("clear", cell);
}
function setStat(key: "level" | "hp", value: number | undefined): void {
  if (selectedCell.value === null || !selectedUnit.value || isReadOnly.value || value === undefined || !Number.isFinite(value)) return;
  emit("setStat", selectedCell.value, key, value);
}
function setMods(mods: string[]): void {
  if (selectedCell.value !== null && selectedUnit.value && !isReadOnly.value) emit("setMods", selectedCell.value, mods);
}
function setLeader(): void {
  if (selectedCell.value !== null && canLead.value && !isReadOnly.value) emit("setLeader", selectedCell.value);
}
</script>

<template>
  <div class="formation" :class="{ 'is-readonly': isReadOnly }" @keydown.stop>
    <div class="formation-cols" aria-hidden="true"><span>Тыл</span><span>Фронт</span></div>
    <div class="formation-grid" role="group" :aria-label="`Формация, занято ${count} из 6 клеток`">
      <button
        v-for="{ cell, wide } in slots" :key="cell" type="button"
        class="formation-cell"
        :class="{ filled: !!garrison[cell], wide, selected: selectedCell === cell, leader: isLeader(cell) }"
        :disabled="isReadOnly && !garrison[cell]"
        :aria-pressed="selectedCell === cell"
        :aria-label="`${wide ? 'Обе линии' : lineName(cell)}, ряд ${Math.floor(cell / 2) + 1}: ${garrison[cell] ? unitStore.nameOf(garrison[cell]!.unit) : isReadOnly ? 'пусто' : 'добавить юнита'}`"
        :title="garrison[cell] ? `${unitStore.nameOf(garrison[cell]!.unit)}${isLeader(cell) ? ' · Лидер' : ''}` : undefined"
        @click="selectCell(cell)"
      >
        <template v-if="garrison[cell]">
          <span class="formation-portrait">
            <UnitIcon :id="garrison[cell]!.unit" :level="garrison[cell]!.level"
              :subrace-id="unitStore.get(garrison[cell]!.unit)?.subraceId ?? -1" :size="32" />
            <span v-if="isLeader(cell)" class="formation-star" title="Лидер" aria-label="Лидер">★</span>
          </span>
          <span class="formation-summary">
            <span class="formation-name">{{ unitStore.nameOf(garrison[cell]!.unit) }}</span>
            <span class="formation-stats">Ур. {{ garrison[cell]!.level }}<template v-if="!hideHp"> · {{ garrison[cell]!.hp }} HP</template></span>
            <span v-if="wide" class="formation-size">2 клетки</span>
          </span>
          <span v-if="garrison[cell]!.modifiers?.length" class="formation-mod-count" :title="`Модификаторы: ${garrison[cell]!.modifiers!.length}`">✦</span>
        </template>
        <template v-else>
          <span class="formation-empty-icon" aria-hidden="true">{{ isReadOnly ? '—' : '+' }}</span>
          <span class="formation-empty-label">{{ isReadOnly ? 'Пусто' : 'Добавить' }}</span>
        </template>
      </button>
    </div>
    <p v-if="selectedCell === null" class="formation-hint">
      {{ isReadOnly ? 'Выберите юнита, чтобы посмотреть свойства.' : 'Выберите юнита для настройки. + — добавить.' }}
    </p>

    <section v-else class="formation-detail" aria-label="Свойства выбранного юнита" @keydown.stop>
      <div class="formation-detail-head">
        <span>{{ positionLabel }}</span>
        <button type="button" class="formation-close" aria-label="Закрыть свойства юнита" @click="selectedCell = null">×</button>
      </div>
      <template v-if="selectedUnit">
        <div class="formation-identity">
          <UnitIcon :id="selectedUnit.unit" :level="selectedUnit.level" :subrace-id="selectedEntry?.subraceId ?? -1" :size="40" />
          <div>
            <div class="formation-detail-name">{{ unitStore.nameOf(selectedUnit.unit) }}</div>
            <div class="formation-meta"><span v-if="selectedIsLeader" class="formation-leader-label">★ Лидер · </span>{{ roleLabel(selectedEntry?.catKey ?? '') }}<template v-if="selectedEntry?.subrace"> · {{ selectedEntry.subrace }}</template></div>
          </div>
        </div>
        <div class="formation-fields">
          <label>
            <span>Уровень</span>
            <strong v-if="isReadOnly">{{ selectedUnit.level }}</strong>
            <el-input-number v-else :key="`level-${selectedCell}`" :model-value="selectedUnit.level"
              :min="selectedEntry?.level ?? 1" :max="unitStore.levelCap" size="small" controls-position="right"
              aria-label="Уровень выбранного юнита" @change="(v: number | undefined) => setStat('level', v)" />
          </label>
          <label v-if="!hideHp">
            <span>Здоровье · HP</span>
            <strong v-if="isReadOnly">{{ selectedUnit.hp }}</strong>
            <el-input-number v-else :key="`hp-${selectedCell}`" :model-value="selectedUnit.hp"
              :min="0" :max="Math.max(selectedEntry?.hp || 9999, selectedUnit.hp)" size="small" controls-position="right"
              aria-label="Здоровье выбранного юнита" @change="(v: number | undefined) => setStat('hp', v)" />
          </label>
        </div>
        <div v-if="isReadOnly" class="formation-modifiers">
          <span class="formation-meta">Модификаторы{{ modifiers.length ? '' : ' — нет' }}</span>
          <span v-for="m in modifiers" :key="m.id" class="formation-modifier" :title="m.entry?.effects?.join(' · ')">
            {{ m.entry?.name || m.id }}<b v-if="m.count > 1"> ×{{ m.count }}</b>
          </span>
        </div>
        <div v-else class="formation-settings">
          <ModifierListEditor :key="`mods-${selectedCell}`" :model-value="selectedUnit.modifiers ?? []"
            :title="`${unitStore.nameOf(selectedUnit.unit)} — модификаторы`" :leader="selectedIsLeader"
            @update:model-value="setMods" />
          <el-button v-if="canLead && !selectedIsLeader" size="small" text @click="setLeader">★ Сделать лидером</el-button>
        </div>
      </template>
      <p v-else class="formation-hint">{{ rosterFor(selectedCell) === 'leaders' ? 'Сначала добавьте героя или вора — лидера отряда.' : 'Здесь можно разместить юнита.' }}</p>
      <div v-if="!isReadOnly" class="formation-actions">
        <UnitPicker ref="picker" :key="selectedCell" :model-value="selectedUnit?.unit ?? null"
          :roster="rosterFor(selectedCell)" :disabled-reason="(id) => bigBlockedReason(selectedCell!, id)"
          :title="rosterFor(selectedCell) === 'leaders' ? 'Лидер отряда — герой или вор' : `Выбор юнита · ${positionLabel}`"
          @update:model-value="onPick">
          <template #trigger="{ show }">
            <el-button size="small" @click="show()">{{ selectedUnit ? 'Заменить' : 'Выбрать юнита' }}</el-button>
          </template>
        </UnitPicker>
        <el-button v-if="selectedUnit" size="small" text type="danger" :disabled="!canClear" @click="onPick(null)">Убрать</el-button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.formation { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.formation-cols, .formation-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.formation-cols { color: var(--el-text-color-secondary); text-align: center; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
.formation-cell {
  position: relative; display: flex; align-items: center; gap: 7px; min-width: 0; min-height: 66px;
  padding: 8px; border: 1px dashed var(--el-border-color); border-radius: 7px;
  background: transparent; color: var(--el-text-color-secondary); font: inherit; text-align: left; cursor: pointer;
  transition: background .12s, border-color .12s;
}
.formation-cell.filled { border-style: solid; border-color: transparent; background: var(--el-fill-color-light); color: var(--el-text-color-primary); }
.formation-cell.wide { grid-column: 1 / -1; }
.formation-cell:hover:not(:disabled) { background: var(--el-fill-color); border-color: var(--el-color-primary); }
.formation-cell.selected { border-style: solid; border-color: var(--el-color-primary); background: color-mix(in srgb, var(--el-color-primary) 10%, var(--el-bg-color)); }
.formation-cell:focus-visible, .formation-close:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.formation-cell:disabled { cursor: default; border-color: var(--el-border-color-lighter); }
.formation-portrait { position: relative; display: flex; flex: 0 0 auto; }
.formation-star { position: absolute; bottom: -5px; right: -3px; color: var(--el-color-warning); font-size: 13px; text-shadow: 0 1px 3px #000; }
.formation-summary { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.formation-name { font-size: 11px; line-height: 1.3; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.formation-stats { font-size: 10px; color: var(--el-text-color-secondary); line-height: 1.3; font-variant-numeric: tabular-nums; }
.formation-size { font-size: 10px; color: var(--el-color-warning); }
.formation-mod-count { position: absolute; top: 3px; right: 4px; font-size: 10px; color: var(--el-color-primary); }
.formation-empty-icon { width: 28px; flex: 0 0 auto; text-align: center; font-size: 22px; font-weight: 300; color: var(--el-text-color-placeholder); }
.formation-empty-label { font-size: 11px; }
.formation-hint { margin: 2px 0; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.5; }
.formation-detail { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.formation-detail-head { display: flex; align-items: center; justify-content: space-between; color: var(--el-text-color-secondary); font-size: 11px; }
.formation-close { font: inherit; font-size: 20px; line-height: 1; color: inherit; background: transparent; border: 0; cursor: pointer; padding: 2px 5px; }
.formation-identity { display: flex; align-items: center; gap: 9px; }
.formation-identity > div { min-width: 0; }
.formation-detail-name { font-size: 13px; line-height: 1.4; font-weight: 600; overflow-wrap: anywhere; }
.formation-meta { font-size: 11px; line-height: 1.5; color: var(--el-text-color-secondary); }
.formation-leader-label { color: var(--el-color-warning); }
.formation-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.formation-fields label { display: flex; flex-direction: column; gap: 5px; min-width: 0; color: var(--el-text-color-secondary); font-size: 11px; }
.formation-fields strong { color: var(--el-text-color-primary); font-size: 14px; font-variant-numeric: tabular-nums; }
.formation-fields :deep(.el-input-number) { width: 100%; min-width: 0; }
.formation-fields :deep(.el-input__wrapper) { padding-left: 6px; }
.formation-fields :deep(.el-input__inner) { text-align: left; }
.formation-settings, .formation-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.formation-actions { padding-top: 8px; border-top: 1px solid var(--el-border-color-lighter); }
.formation-actions :deep(.el-button + .el-button), .formation-settings :deep(.el-button + .el-button) { margin-left: 0; }
.formation-modifiers { display: flex; flex-direction: column; gap: 4px; font-size: 11px; }
.formation-modifier { overflow-wrap: anywhere; }
</style>
