<script setup lang="ts">
/** Scenario variables editor (MidScenVariables): name + int value, add/remove — PLUS the
 *  usage map: for every variable, which events READ it (var-typed condition fields) and
 *  which WRITE it (var-typed effect fields, i.e. «изменить переменную»). Clicking an event
 *  chip jumps to that event in the События tab. No more disconnected numbers in a list —
 *  every variable shows its role in the scenario. */
import { computed } from "vue";
import { ElInput, ElInputNumber, ElButton, ElScrollbar, ElEmpty, ElTag, ElTooltip } from "element-plus";
import type { MapEvent } from "@d2/map-schema";
import { CONDITION_BY_KIND, EFFECT_BY_KIND } from "@d2/map-schema";
import { useEventStore } from "../stores/eventStore";

const store = useEventStore();

interface VarUse { ev: MapEvent; what: string }
interface VarUsage { readers: VarUse[]; writers: VarUse[] }

/** id -> {readers, writers}: scan every event's conditions/effects for var-typed fields.
 *  Generic over the spec table, so new var fields are picked up automatically. */
const usage = computed<Map<number, VarUsage>>(() => {
  const map = new Map<number, VarUsage>();
  const ensure = (id: number): VarUsage => {
    let u = map.get(id);
    if (!u) { u = { readers: [], writers: [] }; map.set(id, u); }
    return u;
  };
  for (const ev of store.events) {
    for (const c of ev.conditions) {
      const spec = CONDITION_BY_KIND[c.kind];
      for (const f of spec?.fields ?? []) {
        if (f.type !== "var") continue;
        const id = Number((c as Record<string, unknown>)[f.key] ?? 0);
        ensure(id).readers.push({ ev, what: spec!.label });
      }
    }
    for (const e of ev.effects) {
      const spec = EFFECT_BY_KIND[e.kind];
      for (const f of spec?.fields ?? []) {
        if (f.type !== "var") continue;
        const id = Number((e as Record<string, unknown>)[f.key] ?? 0);
        ensure(id).writers.push({ ev, what: spec!.label });
      }
    }
  }
  return map;
});

const useOf = (id: number): VarUsage => usage.value.get(id) ?? { readers: [], writers: [] };
const unused = (id: number): boolean => {
  const u = useOf(id);
  return !u.readers.length && !u.writers.length;
};

/** Jump to the event in the События tab (same window, tab switch + select). */
function jump(ev: MapEvent): void {
  store.select(ev.id);
  store.panelTab = "events";
}
</script>

<template>
  <div class="var-editor">
    <div class="var-head">
      <strong class="d2-sec">Переменные</strong>
      <span class="var-count">{{ store.variables.length }}</span>
      <el-button size="small" type="primary" @click="store.addVariable()">+ Переменная</el-button>
    </div>
    <el-scrollbar class="var-list">
      <div v-for="v in store.variables" :key="v.id" class="var-card d2-card">
        <div class="var-row">
          <span class="var-id">#{{ v.id }}</span>
          <el-input :model-value="v.name" size="small" placeholder="имя"
            @update:model-value="store.patchVariable(v.id, { name: $event })" />
          <el-input-number :model-value="v.value" size="small" controls-position="right" style="width: 110px"
            @update:model-value="store.patchVariable(v.id, { value: ($event as number) ?? 0 })" />
          <el-button size="small" text class="icon-btn" @click="store.removeVariable(v.id)">🗑</el-button>
        </div>
        <div v-if="unused(v.id)" class="var-usage var-unused">нигде не используется</div>
        <template v-else>
          <div v-if="useOf(v.id).readers.length" class="var-usage">
            <span class="use-lbl">⚡ читают:</span>
            <el-tooltip v-for="(u, i) in useOf(v.id).readers" :key="'r' + i" :content="u.what" :show-after="300">
              <el-tag size="small" class="use-chip" @click="jump(u.ev)">{{ u.ev.name || u.ev.id }}</el-tag>
            </el-tooltip>
          </div>
          <div v-if="useOf(v.id).writers.length" class="var-usage">
            <span class="use-lbl">★ пишут:</span>
            <el-tooltip v-for="(u, i) in useOf(v.id).writers" :key="'w' + i" :content="u.what" :show-after="300">
              <el-tag size="small" type="success" class="use-chip" @click="jump(u.ev)">{{ u.ev.name || u.ev.id }}</el-tag>
            </el-tooltip>
          </div>
        </template>
      </div>
      <el-empty v-if="!store.variables.length" description="Нет переменных" :image-size="60" />
    </el-scrollbar>
    <p class="var-hint">Переменные — счётчики сценария. События их читают (условия «переменная в диапазоне» / «сравнение») и меняют (эффект «изменить переменную»), собирая цепочки и стейт-машины. Клик по событию — переход к нему.</p>
  </div>
</template>

<style scoped>
.var-editor { display: flex; flex-direction: column; height: 100%; font-size: 12px; }
.var-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; }
.var-head .d2-sec { margin: 0; }
.var-count { color: var(--el-text-color-secondary); margin-right: auto; }
.var-list { flex: 1; padding: 0 12px; }
.var-card { margin: 6px 0; }
.var-row { display: flex; align-items: center; gap: 6px; }
.var-id { color: var(--el-text-color-secondary); width: 34px; font-family: monospace; font-size: 11px; }
.var-usage { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; }
.var-unused { color: var(--el-text-color-secondary); font-size: 11px; font-style: italic; }
.use-lbl { color: var(--el-text-color-secondary); font-size: 11px; margin-right: 2px; }
.use-chip { cursor: pointer; }
.use-chip:hover { text-decoration: underline; }
.var-hint { color: var(--el-text-color-secondary); font-size: 11px; padding: 8px 12px; margin: 0; }
.icon-btn { opacity: 0.6; transition: opacity 0.12s; }
.icon-btn:hover { opacity: 1; }
</style>
