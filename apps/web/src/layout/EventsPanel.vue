<script setup lang="ts">
/**
 * Scenario WINDOW — a draggable, NON-modal el-dialog (not a docked rail: the scenario needs
 * width — list | star-topology graph | editor side by side — and the map must stay clickable
 * so selecting an event shows its zones/arrows on the map while you work).
 *
 * Tabs: События (3-zone layout) / Настройки / Дипломатия / Переменные / Шаблоны.
 * Edits commit through editStore (undoable + collab).
 */
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import {
  ElDialog, ElInput, ElButton, ElScrollbar, ElInputNumber, ElSwitch, ElCheckbox, ElSelect,
  ElOption, ElTag, ElTooltip, ElEmpty, ElTabs, ElTabPane,
} from "element-plus";
import type { MapEvent, EventCondition, EventEffect } from "@d2/map-schema";
import { CONDITION_SPECS, EFFECT_SPECS, CONDITION_BY_KIND, EFFECT_BY_KIND } from "@d2/map-schema";
import { useEventStore, makeCondition, makeEffect } from "../stores/eventStore";
import { useViewStore } from "../stores/viewStore";
import EventFieldInput from "./EventFieldInput.vue";
import EventGraph from "./EventGraph.vue";
import VariablesEditor from "./VariablesEditor.vue";
import TemplatesEditor from "./TemplatesEditor.vue";
import ScenarioSettingsEditor from "./ScenarioSettingsEditor.vue";
import DiplomacyEditor from "./DiplomacyEditor.vue";

const store = useEventStore();
const view = useViewStore();

const visible = computed({
  get: () => view.eventPanelVisible,
  set: (v: boolean) => { if (v !== view.eventPanelVisible) view.toggleEventPanel(); },
});

/** Список событий сворачивается в узкую полоску — графу достаётся вся ширина. */
const listCollapsed = ref(false);
const gridColumns = computed(() =>
  listCollapsed.value
    ? "28px minmax(0, 1fr) minmax(280px, 330px)"
    : "minmax(200px, 250px) minmax(0, 1fr) minmax(280px, 330px)",
);

/** Alt+← = назад по истории переходов (пока окно открыто). */
function onNavKey(e: KeyboardEvent): void {
  if (!view.eventPanelVisible) return;
  if (e.altKey && e.key === "ArrowLeft") {
    store.goBack();
    e.preventDefault();
  }
}
onMounted(() => window.addEventListener("keydown", onNavKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onNavKey));

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

const condFields = (c: EventCondition) =>
  (CONDITION_BY_KIND[c.kind]?.fields ?? []).filter((f) => !f.hidden);
const effFields = (e: EventEffect) =>
  (EFFECT_BY_KIND[e.kind]?.fields ?? []).filter((f) => !f.hidden);
const condLabel = (c: EventCondition) => CONDITION_BY_KIND[c.kind]?.label ?? c.kind;
const effLabel = (e: EventEffect) => EFFECT_BY_KIND[e.kind]?.label ?? e.kind;
</script>

<template>
  <el-dialog
    v-model="visible"
    class="scenario-dialog"
    :modal="false"
    draggable
    :close-on-click-modal="false"
    :lock-scroll="false"
    width="min(1220px, 96vw)"
    top="4vh"
    append-to-body
  >
    <template #header>
      <span class="sc-title">Сценарий</span>
    </template>

    <el-tabs v-model="store.panelTab" class="ev-tabs">
      <el-tab-pane label="События" name="events" />
      <el-tab-pane label="Настройки" name="settings" />
      <el-tab-pane label="Дипломатия" name="diplomacy" />
      <el-tab-pane label="Переменные" name="vars" />
      <el-tab-pane label="Шаблоны" name="templates" />
    </el-tabs>

    <!-- navigation trail: back + breadcrumbs (graph/variable jumps are recorded) -->
    <div v-if="store.canGoBack" class="sc-nav">
      <el-tooltip content="Назад (Alt+←)" :show-after="300">
        <el-button size="small" text class="sc-back" @click="store.goBack()">←</el-button>
      </el-tooltip>
      <span
        v-for="(c, i) in store.breadcrumbs"
        :key="i"
        class="sc-crumb"
        :class="{ current: c.current }"
        @click="!c.current && store.goToCrumb(i)"
      >
        {{ c.label }}<span v-if="!c.current" class="sc-sep">›</span>
      </span>
    </div>

    <div class="sc-body">
      <ScenarioSettingsEditor v-if="store.panelTab === 'settings'" class="ev-sub" />
      <DiplomacyEditor v-else-if="store.panelTab === 'diplomacy'" class="ev-sub" />
      <VariablesEditor v-else-if="store.panelTab === 'vars'" class="ev-sub" />
      <TemplatesEditor v-else-if="store.panelTab === 'templates'" class="ev-sub" />

      <!-- События: list | star graph | editor -->
      <div v-else class="ev-grid" :style="{ gridTemplateColumns: gridColumns }">
        <button
          v-if="listCollapsed"
          class="ev-list-expand"
          title="Показать список событий"
          @click="listCollapsed = false"
        >▸<span class="ev-list-expand-lbl">события</span></button>
        <div v-else class="ev-col ev-col-list d2-rail--left">
          <div class="ev-subhead">
            <el-tooltip content="Свернуть список (графу — вся ширина)" :show-after="300">
              <el-button size="small" text class="icon-btn" @click="listCollapsed = true">◂</el-button>
            </el-tooltip>
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
              class="ev-row d2-row"
              :class="{ active: e.id === store.selectedId }"
              @click="store.navigate({ tab: 'events', eventId: e.id })"
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
                <el-tooltip content="Клонировать"><el-button size="small" text class="icon-btn" @click.stop="store.clone(e)">⧉</el-button></el-tooltip>
                <el-tooltip content="Удалить"><el-button size="small" text class="icon-btn" @click.stop="store.remove(e.id)">🗑</el-button></el-tooltip>
              </div>
            </div>
            <el-empty v-if="!store.filtered.length" description="Нет событий" :image-size="60" />
          </el-scrollbar>
        </div>

        <!-- star topology: what triggers it (left), what it does (right), everything by name -->
        <EventGraph class="ev-col ev-col-graph" />

        <div class="ev-col ev-col-editor d2-rail--left">
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
              <span class="d2-sec">Условия ({{ sel.conditions.length }})</span>
              <el-select placeholder="+ условие" size="small" style="width: 190px" :model-value="''"
                @update:model-value="addCondition($event)">
                <el-option v-for="s in CONDITION_SPECS" :key="s.kind" :value="s.kind" :label="s.label" />
              </el-select>
            </div>
            <div v-for="(c, i) in sel.conditions" :key="'c' + i" class="ev-item d2-card">
              <div class="ev-item-head">
                <span>{{ condLabel(c) }}</span>
                <el-button size="small" text class="icon-btn" @click="removeCondition(i)">🗑</el-button>
              </div>
              <div v-for="f in condFields(c)" :key="f.key" class="ev-field">
                <label>{{ f.label }}</label>
                <EventFieldInput :field="f" :model-value="(c as Record<string, unknown>)[f.key]"
                  @update:model-value="setCondField(i, f.key, $event)" />
              </div>
            </div>

            <!-- effects -->
            <div class="ev-sec-head">
              <span class="d2-sec">Эффекты ({{ sel.effects.length }})</span>
              <el-select placeholder="+ эффект" size="small" style="width: 190px" :model-value="''"
                @update:model-value="addEffect($event)">
                <el-option v-for="s in EFFECT_SPECS" :key="s.kind" :value="s.kind" :label="s.label" />
              </el-select>
            </div>
            <div v-for="(e, i) in sel.effects" :key="'e' + i" class="ev-item d2-card">
              <div class="ev-item-head">
                <span>{{ i + 1 }}. {{ effLabel(e) }}</span>
                <span class="ev-item-actions">
                  <el-button size="small" text class="icon-btn" :disabled="i === 0" @click="moveEffect(i, -1)">↑</el-button>
                  <el-button size="small" text class="icon-btn" :disabled="i === sel.effects.length - 1" @click="moveEffect(i, 1)">↓</el-button>
                  <el-button size="small" text class="icon-btn" @click="removeEffect(i)">🗑</el-button>
                </span>
              </div>
              <div v-for="f in effFields(e)" :key="f.key" class="ev-field">
                <label>{{ f.label }}</label>
                <EventFieldInput :field="f" :model-value="(e as Record<string, unknown>)[f.key]"
                  @update:model-value="setEffField(i, f.key, $event)" />
              </div>
            </div>
          </el-scrollbar>
          <el-empty v-else description="Выберите или создайте событие" :image-size="60" />
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.sc-title { font-weight: 600; font-size: 14px; }
.ev-tabs { --el-tabs-header-height: 34px; font-size: 12px; }
.ev-tabs :deep(.el-tabs__header) { margin: 0 0 8px; }
/* navigation trail (back + crumbs) */
.sc-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 0 6px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  white-space: nowrap;
}
.sc-back { padding: 2px 8px; font-size: 13px; }
.sc-crumb { cursor: pointer; }
.sc-crumb:hover:not(.current) { color: var(--el-color-primary); text-decoration: underline; }
.sc-crumb.current { color: var(--el-text-color-primary); font-weight: 600; cursor: default; }
.sc-sep { margin: 0 5px; color: var(--el-border-color); }
.sc-body { height: min(66vh, 640px); min-height: 380px; font-size: 12px; }
.ev-sub { height: 100%; }

/* События: list | graph | editor (columns come from the gridColumns computed:
   the list is collapsible so the GRAPH gets the width priority) */
.ev-grid {
  display: grid;
  gap: 0;
  height: 100%;
  min-height: 0;
}
.ev-list-expand {
  border: none;
  background: var(--el-fill-color-lighter);
  border-radius: var(--d2-radius);
  cursor: pointer;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  padding: 8px 2px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.ev-list-expand:hover { color: var(--el-text-color-primary); background: var(--el-fill-color-light); }
.ev-list-expand-lbl { writing-mode: vertical-rl; letter-spacing: 0.08em; font-size: 10px; text-transform: uppercase; }
.ev-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.ev-col-list { padding-right: 8px; }
.ev-col-graph { padding: 0 8px; }
.ev-col-editor { padding-left: 8px; }
.d2-rail--left + .ev-col-graph { border-left: none; }

.ev-subhead { display: flex; align-items: center; gap: 8px; padding: 2px 0 6px; }
.ev-count { color: var(--el-text-color-secondary); margin-right: auto; }
.ev-search { padding: 0 0 6px; }
.ev-objfilter { padding: 0 0 6px; color: var(--el-text-color-secondary); }
.ev-list { flex: 1; min-height: 0; }
.ev-row { padding: 5px 10px; cursor: pointer; }
.ev-row-main { display: flex; justify-content: space-between; gap: 8px; }
.ev-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev-id { color: var(--el-text-color-secondary); font-family: monospace; font-size: 11px; }
.ev-badges { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
.ev-ce { color: var(--el-text-color-secondary); margin-left: auto; }
.ev-editor { flex: 1; min-height: 0; }
.ev-props { display: flex; flex-wrap: wrap; gap: 10px 14px; margin: 12px 0; align-items: center; }
.ev-props label { display: inline-flex; align-items: center; gap: 5px; color: var(--el-text-color-regular); }
/* races: a tight 3-column grid (was a wrapping flex that stacked into a 230px block) */
.ev-races { margin-bottom: 10px; }
.ev-races-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 8px; margin: 4px 0; }
.ev-races-lbl { grid-column: 1 / -1; color: var(--el-text-color-secondary); font-size: 11px; }
.ev-races :deep(.el-checkbox) { height: 22px; margin-right: 0; }
.ev-races :deep(.el-checkbox__label) { font-size: 12px; padding-left: 5px; }
.ev-sec-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: var(--d2-sp-4) 0 6px;
}
.ev-sec-head .d2-sec { margin: 0; }
.ev-item { margin-bottom: 8px; margin-right: 8px; }
.ev-item-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 4px; }
.ev-item-actions { display: inline-flex; }
.ev-field { display: grid; grid-template-columns: 96px 1fr; gap: 6px; align-items: center; margin: 6px 0; }
.ev-field > label { color: var(--el-text-color-secondary); }
.icon-btn { opacity: 0.6; transition: opacity 0.12s; }
.icon-btn:hover { opacity: 1; }
</style>

<!-- the dialog itself teleports to <body>: style it unscoped -->
<style>
.scenario-dialog {
  --el-dialog-padding-primary: 12px;
  border-radius: 12px;
  box-shadow: var(--el-box-shadow);
}
.scenario-dialog .el-dialog__header { padding-bottom: 4px; }
.scenario-dialog .el-dialog__body { padding-top: 0; }
</style>
