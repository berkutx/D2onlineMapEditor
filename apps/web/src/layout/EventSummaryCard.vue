<script setup lang="ts">
/**
 * EventSummaryCard — компактная «шпаргалка автора» по событию: описание (editor-only
 * заметка), условия и эффекты человеческим языком (label спека + humanized-ссылки из
 * refNames). Живёт внутри hover-тултипов (список событий, секция «Сценарий» инспектора) —
 * поверхностно вспомнить «что тут», не открывая событие.
 */
import { computed } from "vue";
import type { EventTypeSpec, MapEvent } from "@d2/map-schema";
import { CONDITION_BY_KIND, EFFECT_BY_KIND } from "@d2/map-schema";
import { useEditStore } from "../stores/editStore";
import { useRefNames } from "../services/refNames";

const props = defineProps<{ event: MapEvent }>();

const editStore = useEditStore();
const names = useRefNames();

const desc = computed(() => editStore.eventDescs[props.event.id] ?? "");

const LIMIT = 6;
/** «Label: 📍 Зона у моста, ⚔️ Отряд: Гоблин» — одна строка на условие/эффект. */
function lines(
  parts: readonly Record<string, unknown>[],
  specs: Record<string, EventTypeSpec | undefined>,
): string[] {
  const out = parts.slice(0, LIMIT).map((p) => {
    const spec = specs[p.kind as string];
    const refs = names.refsOf(p, spec);
    const refText = refs.map((r) => `${names.icon(r)} ${r.text}`).join(", ");
    return refText ? `${spec?.label ?? p.kind}: ${refText}` : `${spec?.label ?? p.kind}`;
  });
  if (parts.length > LIMIT) out.push(`… ещё ${parts.length - LIMIT}`);
  return out;
}
const condLines = computed(() => lines(props.event.conditions as Record<string, unknown>[], CONDITION_BY_KIND));
const effLines = computed(() => lines(props.event.effects as Record<string, unknown>[], EFFECT_BY_KIND));
</script>

<template>
  <div class="ev-sum">
    <div class="es-title">
      {{ event.name || "(без имени)" }} <code class="es-id">{{ event.id }}</code>
      <span v-if="!event.enabled" class="es-off">выкл</span>
    </div>
    <div v-if="desc" class="es-desc">{{ desc }}</div>
    <div class="es-sec">условия ({{ event.conditions.length }})</div>
    <div v-for="(l, i) in condLines" :key="`c${i}`" class="es-line">⚡ {{ l }}</div>
    <div v-if="!event.conditions.length" class="es-line es-muted">нет — сработает сразу (по расам события)</div>
    <div class="es-sec">эффекты ({{ event.effects.length }})</div>
    <div v-for="(l, i) in effLines" :key="`e${i}`" class="es-line">★ {{ l }}</div>
    <div v-if="!event.effects.length" class="es-line es-muted">нет</div>
  </div>
</template>

<style scoped>
.ev-sum {
  max-width: 340px;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
}
.es-title {
  font-weight: 600;
  margin-bottom: 2px;
}
.es-id {
  font-size: 10px;
  opacity: 0.7;
  margin-left: 4px;
}
.es-off {
  margin-left: 6px;
  font-size: 10px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(128, 128, 128, 0.35);
}
.es-desc {
  font-style: italic;
  opacity: 0.9;
  margin-bottom: 2px;
  white-space: pre-wrap;
}
.es-sec {
  margin-top: 4px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  opacity: 0.65;
}
.es-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.es-muted {
  opacity: 0.6;
}
</style>
