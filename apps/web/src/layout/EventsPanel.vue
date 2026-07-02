<script setup lang="ts">
/**
 * Events panel (E1 read + E2 edit): a filterable list of scenario events (global or scoped to
 * a selected object) and an inline editor for the selected event — properties, race gating,
 * and typed condition/effect lists. Selecting an event drives the map overlay (trigger zones +
 * movement arrows) via MapCanvasHost. Edits commit through editStore (undoable + collab).
 */
import { computed, ref } from "vue";
import {
  ElInput, ElButton, ElScrollbar, ElInputNumber, ElSwitch, ElCheckbox, ElSelect, ElOption,
  ElTag, ElTooltip, ElEmpty, ElTabs, ElTabPane,
} from "element-plus";
import type { MapEvent, EventCondition, EventEffect } from "@d2/map-schema";
import { CONDITION_SPECS, EFFECT_SPECS, CONDITION_BY_KIND, EFFECT_BY_KIND } from "@d2/map-schema";
import { useEventStore, makeCondition, makeEffect } from "../stores/eventStore";
import { useViewStore } from "../stores/viewStore";
import EventFieldInput from "./EventFieldInput.vue";
import VariablesEditor from "./VariablesEditor.vue";
import TemplatesEditor from "./TemplatesEditor.vue";

const store = useEventStore();
const view = useViewStore();
const tab = ref<"events" | "vars" | "templates">("events");

const sel = computed(() => store.selected);
const RACES = [
  { key: "human", label: "Имп" }, { key: "dwarf", label: "Кланы" }, { key: "undead", label: "Нежить" },
  { key: "heretic", label: "Легионы" }, { key: "neutral", label: "Нейтр" }, { key: "elf", label: "Эльфы" },
] as const;

function patch(partial: Partial<MapEvent>): void {
  if (!sel.value) return;
  store.upsert({ ...sel.value, ...partial });
}
function patchRace(set: "appliesTo" | "canTrigger", key: string, v: boolean): void {
  if (!sel.value) return;
  patch({ [set]: { ...sel.value[set], [key]: v } } as Partial<MapEvent>);
}

// --- conditions ---
function addCondition(kind: string): void {
  if (!sel.value) return;
  patch({ conditions: [...sel.value.conditions, makeCondition(kind)] });
}
function setCondField(i: number, key: string, v: unknown): void {
  if (!sel.value) return;
  const conditions = sel.value.conditions.map((c, j) =>
    j === i ? ({ ...c, [key]: v } as EventCondition) : c);
  patch({ conditions });
}
function removeCondition(i: number): void {
  if (!sel.value) return;
  patch({ conditions: sel.value.conditions.filter((_, j) => j !== i) });
}

// --- effects ---
function addEffect(kind: string): void {
  if (!sel.value) return;
  const eff = makeEffect(kind);
  (eff as { num: number }).num = sel.value.effects.length;
  patch({ effects: [...sel.value.effects, eff] });
}
function setEffField(i: number, key: string, v: unknown): void {
  if (!sel.value) return;
  const effects = sel.value.effects.map((e, j) =>
    j === i ? ({ ...e, [key]: v } as EventEffect) : e);
  patch({ effects });
}
function removeEffect(i: number): void {
  if (!sel.value) return;
  patch({ effects: sel.value.effects.filter((_, j) => j !== i) });
}
function moveEffect(i: number, dir: -1 | 1): void {
  if (!sel.value) return;
  const j = i + dir;
  if (j < 0 || j >= sel.value.effects.length) return;
  const effects = sel.value.effects.slice();
  [effects[i], effects[j]] = [effects[j]!, effects[i]!];
  effects.forEach((e, k) => ((e as { num: number }).num = k)); // renumber sequence
  patch({ effects });
}

const condFields = (c: EventCondition) => CONDITION_BY_KIND[c.kind]?.fields ?? [];
const effFields = (e: EventEffect) => EFFECT_BY_KIND[e.kind]?.fields ?? [];
const condLabel = (c: EventCondition) => CONDITION_BY_KIND[c.kind]?.label ?? c.kind;
const effLabel = (e: EventEffect) => EFFECT_BY_KIND[e.kind]?.label ?? e.kind;
</script>

<template>
  <div class="ev-panel">
    <div class="ev-head">
      <strong>Сценарий</strong>
      <span class="ev-count" style="margin-right: auto" />
      <el-button size="small" text @click="view.toggleEventPanel()">✕</el-button>
    </div>

    <el-tabs v-model="tab" class="ev-tabs" stretch>
      <el-tab-pane label="События" name="events" />
      <el-tab-pane label="Переменные" name="vars" />
      <el-tab-pane label="Шаблоны" name="templates" />
    </el-tabs>

    <VariablesEditor v-if="tab === 'vars'" class="ev-sub" />
    <TemplatesEditor v-else-if="tab === 'templates'" class="ev-sub" />

    <template v-else>
    <div class="ev-subhead">
      <span class="ev-count">{{ store.events.length }} событий</span>
      <el-button size="small" type="primary" @click="store.create()">+ Новое</el-button>
    </div>

    <el-input
      v-model="store.filter"
      size="small"
      clearable
      placeholder="Поиск по имени / id…"
      class="ev-search"
    />
    <div v-if="store.objectFilter" class="ev-objfilter">
      только для объекта <code>{{ store.objectFilter }}</code>
      <el-button size="small" text @click="store.objectFilter = null">показать все</el-button>
    </div>

    <el-scrollbar class="ev-list">
      <div
        v-for="e in store.filtered"
        :key="e.id"
        class="ev-row"
        :class="{ active: e.id === store.selectedId }"
        @click="store.select(e.id)"
      >
        <div class="ev-row-main">
          <span class="ev-name">{{ e.name || "(без имени)" }}</span>
          <span class="ev-id">{{ e.id }}</span>
        </div>
        <div class="ev-badges">
          <el-tag v-if="!e.enabled" size="small" type="info" disable-transitions>выкл</el-tag>
          <el-tag v-if="!e.occurOnce" size="small" type="warning" disable-transitions>∞</el-tag>
          <el-tag v-if="e.chance < 100" size="small" disable-transitions>{{ e.chance }}%</el-tag>
          <span class="ev-ce">{{ e.conditions.length }}⚡ {{ e.effects.length }}★</span>
          <el-tooltip content="Клонировать"><el-button size="small" text @click.stop="store.clone(e)">⧉</el-button></el-tooltip>
          <el-tooltip content="Удалить"><el-button size="small" text @click.stop="store.remove(e.id)">🗑</el-button></el-tooltip>
        </div>
      </div>
      <el-empty v-if="!store.filtered.length" description="Нет событий" :image-size="60" />
    </el-scrollbar>

    <!-- editor -->
    <el-scrollbar v-if="sel" class="ev-editor">
      <el-input :model-value="sel.name" size="small" placeholder="Название события"
        @update:model-value="patch({ name: $event })" />

      <div class="ev-props">
        <label><el-switch :model-value="sel.enabled" @update:model-value="patch({ enabled: $event as boolean })" /> активно с начала</label>
        <label><el-switch :model-value="!sel.occurOnce" @update:model-value="patch({ occurOnce: !($event as boolean) })" /> повторяемое</label>
        <label>шанс
          <el-input-number :model-value="sel.chance" :min="0" :max="100" size="small" controls-position="right"
            style="width: 96px" @update:model-value="patch({ chance: ($event as number) ?? 100 })" /> %</label>
        <label>порядок
          <el-input-number :model-value="sel.order" size="small" controls-position="right"
            style="width: 96px" @update:model-value="patch({ order: ($event as number) ?? 0 })" /></label>
      </div>

      <div class="ev-races">
        <div class="ev-races-row">
          <span class="ev-races-lbl">Действует на:</span>
          <el-checkbox v-for="r in RACES" :key="'a' + r.key" :model-value="sel.appliesTo[r.key]"
            @update:model-value="patchRace('appliesTo', r.key, $event as boolean)">{{ r.label }}</el-checkbox>
        </div>
        <div class="ev-races-row">
          <span class="ev-races-lbl">Может запускать:</span>
          <el-checkbox v-for="r in RACES" :key="'t' + r.key" :model-value="sel.canTrigger[r.key]"
            @update:model-value="patchRace('canTrigger', r.key, $event as boolean)">{{ r.label }}</el-checkbox>
        </div>
      </div>

      <!-- conditions -->
      <div class="ev-sec-head">
        <span>Условия ({{ sel.conditions.length }})</span>
        <el-select placeholder="+ условие" size="small" style="width: 190px" :model-value="''"
          @update:model-value="addCondition($event)">
          <el-option v-for="s in CONDITION_SPECS" :key="s.kind" :value="s.kind" :label="s.label" />
        </el-select>
      </div>
      <div v-for="(c, i) in sel.conditions" :key="'c' + i" class="ev-item">
        <div class="ev-item-head">
          <span>{{ condLabel(c) }}</span>
          <el-button size="small" text @click="removeCondition(i)">🗑</el-button>
        </div>
        <div v-for="f in condFields(c)" :key="f.key" class="ev-field">
          <label>{{ f.label }}</label>
          <EventFieldInput :field="f" :model-value="(c as Record<string, unknown>)[f.key]"
            @update:model-value="setCondField(i, f.key, $event)" />
        </div>
      </div>

      <!-- effects -->
      <div class="ev-sec-head">
        <span>Эффекты ({{ sel.effects.length }})</span>
        <el-select placeholder="+ эффект" size="small" style="width: 190px" :model-value="''"
          @update:model-value="addEffect($event)">
          <el-option v-for="s in EFFECT_SPECS" :key="s.kind" :value="s.kind" :label="s.label" />
        </el-select>
      </div>
      <div v-for="(e, i) in sel.effects" :key="'e' + i" class="ev-item">
        <div class="ev-item-head">
          <span>{{ i + 1 }}. {{ effLabel(e) }}</span>
          <span class="ev-item-actions">
            <el-button size="small" text :disabled="i === 0" @click="moveEffect(i, -1)">↑</el-button>
            <el-button size="small" text :disabled="i === sel.effects.length - 1" @click="moveEffect(i, 1)">↓</el-button>
            <el-button size="small" text @click="removeEffect(i)">🗑</el-button>
          </span>
        </div>
        <div v-for="f in effFields(e)" :key="f.key" class="ev-field">
          <label>{{ f.label }}</label>
          <EventFieldInput :field="f" :model-value="(e as Record<string, unknown>)[f.key]"
            @update:model-value="setEffField(i, f.key, $event)" />
        </div>
      </div>
    </el-scrollbar>
    </template>
  </div>
</template>

<style scoped>
.ev-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--el-bg-color);
  border-left: 1px solid var(--el-border-color);
  font-size: 12px;
}
.ev-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.ev-count { color: var(--el-text-color-secondary); margin-right: auto; }
.ev-tabs { padding: 0 8px; --el-tabs-header-height: 34px; }
.ev-tabs :deep(.el-tabs__header) { margin: 0; }
.ev-sub { flex: 1; min-height: 0; }
.ev-subhead { display: flex; align-items: center; gap: 8px; padding: 6px 10px 2px; }
.ev-search { padding: 8px 10px 4px; }
.ev-objfilter { padding: 0 10px 6px; color: var(--el-text-color-secondary); }
.ev-list { max-height: 34%; border-bottom: 1px solid var(--el-border-color-lighter); }
.ev-row {
  padding: 5px 10px;
  cursor: pointer;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.ev-row:hover { background: var(--el-fill-color-light); }
.ev-row.active { background: var(--el-color-primary-light-9); box-shadow: inset 3px 0 0 var(--el-color-primary); }
.ev-row-main { display: flex; justify-content: space-between; gap: 8px; }
.ev-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev-id { color: var(--el-text-color-secondary); font-family: monospace; font-size: 11px; }
.ev-badges { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
.ev-ce { color: var(--el-text-color-secondary); margin-left: auto; }
.ev-editor { flex: 1; padding: 8px 10px; }
.ev-props { display: flex; flex-wrap: wrap; gap: 10px 14px; margin: 8px 0; align-items: center; }
.ev-props label { display: inline-flex; align-items: center; gap: 5px; color: var(--el-text-color-regular); }
.ev-races { margin-bottom: 8px; }
.ev-races-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 3px 0; }
.ev-races-lbl { color: var(--el-text-color-secondary); width: 110px; }
.ev-sec-head {
  display: flex; align-items: center; justify-content: space-between;
  margin: 12px 0 6px; font-weight: 600; border-top: 1px solid var(--el-border-color-lighter); padding-top: 8px;
}
.ev-item {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 6px;
  background: var(--el-fill-color-lighter);
}
.ev-item-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 4px; }
.ev-item-actions { display: inline-flex; }
.ev-field { display: grid; grid-template-columns: 96px 1fr; gap: 6px; align-items: center; margin: 3px 0; }
.ev-field > label { color: var(--el-text-color-secondary); }
</style>
