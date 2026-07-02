<script setup lang="ts">
/** Stack-template editor (MidStackTemplate): the reusable armies spawned by events
 *  (CREATE_NEW_STACK / MOVE_STACK). List + editor: name, order, leader, 6 unit cells (global
 *  Gunit ids via UnitPicker + level). Modifiers / facing are preserved on round-trip. Edits
 *  commit as upsertTemplate/deleteTemplate ops (undoable + collab). */
import { computed } from "vue";
import { ElInput, ElInputNumber, ElButton, ElScrollbar, ElEmpty, ElSelect, ElOption, ElTooltip } from "element-plus";
import type { StackTemplate, TemplateUnit } from "@d2/map-schema";
import { useEventStore } from "../stores/eventStore";
import { useEditStore } from "../stores/editStore";
import UnitPicker from "./UnitPicker.vue";

const store = useEventStore();
const edit = useEditStore();
const sel = computed(() => store.selectedTemplate);

const ORDERS = [
  { value: 1, label: "Обычный" }, { value: 2, label: "Стоять" }, { value: 3, label: "Охрана" },
  { value: 4, label: "Атака" }, { value: 7, label: "Бродить" }, { value: 9, label: "Оборона" },
];

function patch(partial: Partial<StackTemplate>): void {
  if (!sel.value) return;
  store.upsertTemplate({ ...sel.value, ...partial });
}
function setCell(i: number, unit: string | null): void {
  if (!sel.value) return;
  const units = sel.value.units.slice();
  while (units.length < 6) units.push(null);
  units[i] = unit ? { unit, level: units[i]?.level ?? 1 } : null;
  patch({ units });
}
function setCellLevel(i: number, level: number): void {
  if (!sel.value) return;
  const units = sel.value.units.slice();
  if (units[i]) units[i] = { ...(units[i] as TemplateUnit), level };
  patch({ units });
}
const cell = (i: number): TemplateUnit | null => sel.value?.units[i] ?? null;
const unitCount = (t: StackTemplate): number => t.units.filter(Boolean).length;
</script>

<template>
  <div class="tpl-editor">
    <div class="tpl-head">
      <strong>Шаблоны отрядов</strong>
      <span class="tpl-count">{{ store.templates.length }}</span>
      <el-button size="small" type="primary" @click="store.createTemplate()">+ Шаблон</el-button>
    </div>

    <el-scrollbar class="tpl-list">
      <div
        v-for="t in store.templates"
        :key="t.id"
        class="tpl-row"
        :class="{ active: t.id === store.selectedTemplateId }"
        @click="store.selectTemplate(t.id)"
      >
        <span class="tpl-name">{{ t.name || "(без имени)" }}</span>
        <span class="tpl-meta">{{ unitCount(t) }}⚔ <code>{{ t.id }}</code></span>
        <span class="tpl-actions">
          <el-tooltip content="Клонировать"><el-button size="small" text @click.stop="store.cloneTemplate(t)">⧉</el-button></el-tooltip>
          <el-tooltip content="Удалить"><el-button size="small" text @click.stop="store.removeTemplate(t.id)">🗑</el-button></el-tooltip>
        </span>
      </div>
      <el-empty v-if="!store.templates.length" description="Нет шаблонов" :image-size="60" />
    </el-scrollbar>

    <el-scrollbar v-if="sel" class="tpl-form">
      <el-input :model-value="sel.name" size="small" placeholder="Название шаблона"
        @update:model-value="patch({ name: $event })" />
      <div class="tpl-props">
        <label>приказ
          <el-select :model-value="sel.order" size="small" style="width: 130px"
            @update:model-value="patch({ order: $event })">
            <el-option v-for="o in ORDERS" :key="o.value" :value="o.value" :label="o.label" />
          </el-select>
        </label>
      </div>
      <div class="tpl-leader">
        <label>Лидер</label>
        <UnitPicker :model-value="sel.leader || null" nullable @update:model-value="patch({ leader: $event || '' })" />
        <el-input-number :model-value="sel.leaderLevel" :min="1" :max="10" size="small" controls-position="right"
          style="width: 92px" @update:model-value="patch({ leaderLevel: ($event as number) ?? 1 })" />
      </div>
      <div class="tpl-units">
        <div class="tpl-units-lbl">Состав (6 ячеек):</div>
        <div v-for="i in 6" :key="i" class="tpl-cell">
          <span class="tpl-cell-n">{{ i - 1 }}</span>
          <UnitPicker :model-value="cell(i - 1)?.unit ?? null" nullable
            @update:model-value="setCell(i - 1, $event)" />
          <el-input-number v-if="cell(i - 1)" :model-value="cell(i - 1)!.level" :min="1" :max="10"
            size="small" controls-position="right" style="width: 84px"
            @update:model-value="setCellLevel(i - 1, ($event as number) ?? 1)" />
        </div>
      </div>
      <p class="tpl-hint">Шаблон — «рецепт» отряда: событие «Создать отряд» ставит его в выбранную локацию. Модификаторы и снаряжение шаблона сохраняются при экспорте.</p>
    </el-scrollbar>
  </div>
</template>

<style scoped>
.tpl-editor { display: flex; flex-direction: column; height: 100%; }
.tpl-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
.tpl-count { color: var(--el-text-color-secondary); margin-right: auto; }
.tpl-list { max-height: 38%; border-bottom: 1px solid var(--el-border-color-lighter); }
.tpl-row { display: flex; align-items: center; gap: 6px; padding: 5px 10px; cursor: pointer; border-bottom: 1px solid var(--el-border-color-lighter); }
.tpl-row:hover { background: var(--el-fill-color-light); }
.tpl-row.active { background: var(--el-color-primary-light-9); box-shadow: inset 3px 0 0 var(--el-color-primary); }
.tpl-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tpl-meta { color: var(--el-text-color-secondary); margin-left: auto; font-size: 11px; }
.tpl-form { flex: 1; padding: 8px 10px; }
.tpl-props { margin: 8px 0; }
.tpl-props label, .tpl-leader label { color: var(--el-text-color-secondary); margin-right: 6px; }
.tpl-leader { display: flex; align-items: center; gap: 6px; margin: 8px 0; }
.tpl-units-lbl { color: var(--el-text-color-secondary); margin: 8px 0 4px; }
.tpl-cell { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
.tpl-cell-n { width: 16px; color: var(--el-text-color-secondary); font-family: monospace; }
.tpl-hint { color: var(--el-text-color-secondary); font-size: 11px; margin-top: 10px; }
</style>
