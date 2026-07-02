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
        <span class="tpl-meta">{{ unitCount(t) }}⚔ <code>{{ t.id }}</code></span>
        <span class="tpl-actions">
          <el-tooltip content="Клонировать"><el-button size="small" text class="icon-btn" @click.stop="store.cloneTemplate(t)">⧉</el-button></el-tooltip>
          <el-tooltip content="Удалить"><el-button size="small" text class="icon-btn" @click.stop="store.removeTemplate(t.id)">🗑</el-button></el-tooltip>
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
        <div class="tpl-units-lbl d2-sec">Состав (6 ячеек):</div>
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
.tpl-props label, .tpl-leader label { color: var(--el-text-color-secondary); margin-right: 6px; }
.tpl-leader { display: flex; align-items: center; gap: 6px; margin: 8px 0; }
.tpl-cell { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
.tpl-cell-n { width: 16px; color: var(--el-text-color-secondary); font-family: monospace; font-size: 11px; }
.tpl-hint { color: var(--el-text-color-secondary); font-size: 11px; margin-top: 12px; }
.icon-btn { opacity: 0.6; transition: opacity 0.12s; }
.icon-btn:hover { opacity: 1; }
</style>
