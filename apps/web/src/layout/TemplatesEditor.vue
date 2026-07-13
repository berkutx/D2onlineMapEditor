<script setup lang="ts">
/** Stack-template editor (MidStackTemplate): the reusable armies spawned by events
 *  (CREATE_NEW_STACK / MOVE_STACK). List + editor: name, order, 6 unit cells (global Gunit
 *  ids via UnitPicker + level). THE LEADER IS ONE OF THE 6 CELLS (★): on-disk LEADER/
 *  LEADER_LVL are a derived duplicate of the leader cell — the reference exports them from
 *  the flagged unit and re-finds the cell by type-id match on import; measured 2656/2656
 *  shipped templates. So an empty template asks for the leader FIRST (any cell click opens
 *  the leaders roster), and the leader cell keeps LEADER/LEADER_LVL in sync. Modifiers /
 *  facing are preserved on round-trip (equipment does not exist in the template format).
 *  Edits commit as upsertTemplate/deleteTemplate ops (undoable + collab). */
import { computed, nextTick, watch } from "vue";
import { ElInput, ElInputNumber, ElButton, ElScrollbar, ElEmpty, ElSelect, ElOption, ElTooltip } from "element-plus";
import type { StackTemplate, TemplateUnit } from "@d2/map-schema";
import { useEventStore } from "../stores/eventStore";
import { useEditStore } from "../stores/editStore";
import { useUnitStore } from "../stores/unitStore";
import CommitInput from "./CommitInput.vue";
import UnitPicker from "./UnitPicker.vue";
import ModifierListEditor from "./ModifierListEditor.vue";

const store = useEventStore();
const edit = useEditStore();
const unitStore = useUnitStore();
// имена юнитов (лидер в списке, ячейки) должны быть готовы сразу, не после первого пикера
void unitStore.load();
const sel = computed(() => store.selectedTemplate);

/** Прыжок из поля «Шаблон отряда» / графа: доскроллить список к выбранному шаблону. */
watch(
  () => store.selectedTemplateId,
  () => {
    void nextTick(() =>
      document.querySelector(".tpl-row.active")?.scrollIntoView({ block: "center" }),
    );
  },
  { immediate: true },
);

/** Подпись строки списка: лидер по имени (id — только в title). */
const leaderName = (t: StackTemplate): string =>
  t.leader ? unitStore.nameOf(t.leader) : "";

const ORDERS = [
  { value: 1, label: "Обычный" }, { value: 2, label: "Стоять" }, { value: 3, label: "Охрана" },
  { value: 4, label: "Атака" }, { value: 7, label: "Бродить" }, { value: 9, label: "Оборона" },
];

function patch(partial: Partial<StackTemplate>): void {
  if (!sel.value) return;
  store.upsertTemplate({ ...sel.value, ...partial });
}

/** Ячейка лидера = та, чей юнит совпадает с LEADER (семантика импорта эталона). */
const leaderCellIdx = computed(() => {
  const t = sel.value;
  if (!t?.leader) return -1;
  return t.units.findIndex((u) => u && u.unit === t.leader);
});
const hasLeader = computed(() => leaderCellIdx.value >= 0);
/** Заготовка старого образца: LEADER задан, но в ячейках его нет — чинится кликом. */
const orphanLeader = computed(() => !!sel.value?.leader && !hasLeader.value);
const soldierCount = computed(
  () => (sel.value?.units.filter(Boolean).length ?? 0) - (hasLeader.value ? 1 : 0),
);

/** Пока лидера нет — ЛЮБАЯ ячейка предлагает лидера; ячейка лидера меняет лидера. */
const cellRoster = (i: number): "leaders" | "soldiers" =>
  !hasLeader.value || i === leaderCellIdx.value ? "leaders" : "soldiers";
const cellTitle = (i: number): string =>
  !hasLeader.value
    ? "Сначала лидер — герой или вор возглавит отряд"
    : i === leaderCellIdx.value
      ? "Лидер отряда — герой или вор"
      : "Выбор юнита";
/** Ячейку лидера нельзя опустошить, пока в отряде есть другие юниты. */
const cellClearable = (i: number): boolean =>
  i !== leaderCellIdx.value || soldierCount.value === 0;

function setCell(i: number, unit: string | null): void {
  if (!sel.value) return;
  const units = sel.value.units.slice();
  while (units.length < 6) units.push(null);
  const level = units[i]?.level ?? 1;
  units[i] = unit ? { unit, level } : null;
  // опустевшая ячейка теряет и свои модификаторы (unitPos указывал бы в пустоту)
  const modsPatch = unit
    ? {}
    : { modifiers: (sel.value.modifiers ?? []).filter((m) => m.unitPos !== i) };
  if (!hasLeader.value || i === leaderCellIdx.value) {
    // лидер-путь: LEADER/LEADER_LVL — производные от ячейки лидера
    patch({ units, leader: unit ?? "", leaderLevel: unit ? level : 1, ...modsPatch });
  } else {
    patch({ units, ...modsPatch });
  }
}
function setCellLevel(i: number, level: number): void {
  if (!sel.value) return;
  const units = sel.value.units.slice();
  if (units[i]) units[i] = { ...(units[i] as TemplateUnit), level };
  patch(i === leaderCellIdx.value ? { units, leaderLevel: level } : { units });
}
const cell = (i: number): TemplateUnit | null => sel.value?.units[i] ?? null;
const unitCount = (t: StackTemplate): number => t.units.filter(Boolean).length;

/** Модификаторы ячейки: в шаблоне это плоский список {unitPos (индекс ЯЧЕЙКИ), modifId} —
 *  семантика эталона (mod.index = grid index). Правка пересобирает список: чужие ячейки
 *  как были, свои — в новом порядке. */
const cellMods = (i: number): string[] =>
  (sel.value?.modifiers ?? []).filter((m) => m.unitPos === i).map((m) => m.modifId);
function setCellMods(i: number, mods: string[]): void {
  if (!sel.value) return;
  const others = (sel.value.modifiers ?? []).filter((m) => m.unitPos !== i);
  const next = [...others, ...mods.map((modifId) => ({ unitPos: i, modifId }))];
  // канонично: эталонный экспорт сортирует список по ячейке (внутри ячейки — порядок выбора)
  next.sort((a, b) => a.unitPos - b.unitPos);
  patch({ modifiers: next });
}
</script>

<template>
  <div class="tpl-editor">
    <!-- the tab is the title; head keeps the count + action only -->
    <div class="tpl-head">
      <span class="tpl-count">{{ store.templates.length }} шаблонов</span>
      <el-button size="small" type="primary" @click="store.createTemplate()">+ Шаблон</el-button>
    </div>

    <el-scrollbar class="tpl-list">
      <div
        v-for="t in store.templates"
        :key="t.id"
        class="tpl-row d2-row"
        :class="{ active: t.id === store.selectedTemplateId }"
        @click="store.selectTemplate(t.id)"
      >
        <span class="tpl-name">{{ t.name || "(без имени)" }}</span>
        <span class="tpl-meta" :title="t.id">{{ unitCount(t) }}⚔ {{ leaderName(t) || "—" }}</span>
        <span class="tpl-actions">
          <el-tooltip content="Клонировать"><el-button size="small" text class="icon-btn" @click.stop="store.cloneTemplate(t)">⧉</el-button></el-tooltip>
          <el-tooltip content="Удалить"><el-button size="small" text class="icon-btn" @click.stop="store.removeTemplate(t.id)">🗑</el-button></el-tooltip>
        </span>
      </div>
      <el-empty v-if="!store.templates.length" description="Нет шаблонов" :image-size="60" />
    </el-scrollbar>

    <el-scrollbar v-if="sel" class="tpl-form">
      <CommitInput :model-value="sel.name" size="small" placeholder="Название шаблона"
        @update:model-value="patch({ name: $event })" />
      <div class="tpl-props">
        <label>приказ
          <el-select :model-value="sel.order" size="small" style="width: 130px"
            @update:model-value="patch({ order: $event })">
            <el-option v-for="o in ORDERS" :key="o.value" :value="o.value" :label="o.label" />
          </el-select>
        </label>
      </div>
      <div class="tpl-units">
        <div class="tpl-units-lbl d2-sec">Состав (6 ячеек, лидер ★ — одна из них):</div>
        <p v-if="!hasLeader" class="tpl-need-leader">
          {{ orphanLeader
            ? "Лидер выбран, но не размещён в отряде — кликните ячейку, чтобы поставить его ★"
            : "Отряд начинается с лидера: кликните любую ячейку — сперва выбирается герой или вор ★" }}
        </p>
        <div v-for="i in 6" :key="i" class="tpl-cell">
          <span class="tpl-cell-n" :class="{ leader: i - 1 === leaderCellIdx }">{{
            i - 1 === leaderCellIdx ? "★" : i - 1
          }}</span>
          <UnitPicker :model-value="cell(i - 1)?.unit ?? null" :nullable="cellClearable(i - 1)"
            :roster="cellRoster(i - 1)" :title="cellTitle(i - 1)"
            @update:model-value="setCell(i - 1, $event)" />
          <el-input-number v-if="cell(i - 1)" :model-value="cell(i - 1)!.level" :min="1" :max="10"
            size="small" controls-position="right" style="width: 84px"
            @update:model-value="setCellLevel(i - 1, ($event as number) ?? 1)" />
          <ModifierListEditor v-if="cell(i - 1)" :model-value="cellMods(i - 1)"
            :title="`${unitStore.nameOf(cell(i - 1)!.unit)} — модификаторы`"
            :leader="i - 1 === leaderCellIdx" compact
            @update:model-value="setCellMods(i - 1, $event)" />
          <el-tooltip v-if="i - 1 === leaderCellIdx && soldierCount > 0"
            content="Лидера нельзя убрать, пока в отряде есть юниты — можно только заменить другим героем">
            <span class="tpl-lock">🔒</span>
          </el-tooltip>
        </div>
      </div>
      <p class="tpl-hint">Шаблон — «рецепт» отряда: событие «Создать отряд» ставит его в выбранную локацию. Лидер (★) — часть отряда и занимает одну из 6 ячеек; модификаторы юнита — под ⚙ у ячейки. Снаряжения у шаблона не бывает — формат .sg его не хранит.</p>
    </el-scrollbar>
  </div>
</template>

<style scoped>
/* the WIDE dialog gets two columns (list | form) instead of the old narrow-rail stack */
.tpl-editor {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  column-gap: 16px;
  height: 100%;
  font-size: 12px;
}
.tpl-head { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px; }
.tpl-count { color: var(--el-text-color-secondary); margin-right: auto; }
.tpl-list { min-height: 0; padding: 0 4px 8px; }
.tpl-row { display: flex; align-items: center; gap: 6px; padding: 5px 10px; cursor: pointer; }
.tpl-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tpl-meta { color: var(--el-text-color-secondary); margin-left: auto; font-size: 11px; }
.tpl-form { min-height: 0; padding: 8px 12px; max-width: 560px; }
.tpl-props { margin: 8px 0; }
.tpl-props label { color: var(--el-text-color-secondary); margin-right: 6px; }
.tpl-cell { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
.tpl-cell-n { width: 16px; color: var(--el-text-color-secondary); font-family: monospace; font-size: 11px; }
.tpl-cell-n.leader { color: var(--el-color-warning); font-size: 13px; }
.tpl-need-leader { color: var(--el-color-warning); font-size: 11px; margin: 4px 0 8px; }
.tpl-lock { cursor: help; opacity: 0.7; }
.tpl-hint { color: var(--el-text-color-secondary); font-size: 11px; margin-top: 12px; }
.icon-btn { opacity: 0.6; transition: opacity 0.12s; }
.icon-btn:hover { opacity: 1; }
</style>
