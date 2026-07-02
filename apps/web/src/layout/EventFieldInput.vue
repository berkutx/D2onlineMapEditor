<script setup lang="ts">
/**
 * One typed input for a scenario-event condition/effect field, driven by the shared
 * EventFieldSpec. int/enum -> number or preset select; bool -> switch; text -> input;
 * ref-* -> a picker over the matching map objects (or players/events). template/item/spell
 * are global-id strings (rich catalog pickers are a later refinement).
 */
import { computed } from "vue";
import { ElInputNumber, ElSwitch, ElInput, ElSelect, ElOption } from "element-plus";
import type { EventFieldSpec } from "@d2/map-schema";
import { useEditStore } from "../stores/editStore";

const props = defineProps<{ field: EventFieldSpec; modelValue: unknown }>();
const emit = defineEmits<{ (e: "update:modelValue", v: unknown): void }>();

const edit = useEditStore();

/** Which object types back each ref picker. */
const REF_TYPES: Record<string, string[]> = {
  "ref-loc": ["location"],
  "ref-stack": ["stack"],
  "ref-city": ["village", "capital"],
  "ref-ruin": ["ruin"],
  "ref-site": ["merchant", "mage", "trainer", "mercenary"],
  "ref-lmark": ["landmark"],
};

interface Opt { value: string; label: string }

const refOptions = computed<Opt[]>(() => {
  const doc = edit.liveDoc;
  if (!doc) return [];
  const t = props.field.type;
  if (t === "ref-player") {
    return doc.players.map((p) => ({ value: p.id, label: `${p.name || "Игрок"} (${p.id})` }));
  }
  if (t === "ref-event") {
    return (doc.events ?? []).map((e) => ({ value: e.id, label: `${e.name || "событие"} · ${e.id}` }));
  }
  const types = REF_TYPES[t];
  if (!types) return [];
  return doc.objects
    .filter((o) => types.includes(o.type))
    .map((o) => ({ value: o.id, label: `${(o as { name?: string }).name || o.type} · ${o.id}` }));
});

const isRef = computed(() => props.field.type.startsWith("ref-"));
const isGlobalId = computed(() => ["template", "item", "spell"].includes(props.field.type));

function set(v: unknown): void {
  emit("update:modelValue", v);
}
</script>

<template>
  <!-- boolean -->
  <el-switch
    v-if="field.type === 'bool'"
    :model-value="!!modelValue"
    @update:model-value="set($event)"
  />

  <!-- enum, or int WITH presets -> a select -->
  <el-select
    v-else-if="field.type === 'enum'"
    :model-value="Number(modelValue) || 0"
    size="small"
    style="width: 100%"
    @update:model-value="set($event)"
  >
    <el-option v-for="o in field.options ?? []" :key="o.value" :value="o.value" :label="o.label" />
  </el-select>

  <!-- int (optionally with quick presets shown before the number box) -->
  <div v-else-if="field.type === 'int' || field.type === 'var'" class="ev-int">
    <el-select
      v-if="field.options && field.options.length"
      :model-value="Number(modelValue) || 0"
      size="small"
      style="width: 130px"
      @update:model-value="set($event)"
    >
      <el-option v-for="o in field.options" :key="o.value" :value="o.value" :label="o.label" />
    </el-select>
    <el-input-number
      :model-value="Number(modelValue) || 0"
      :min="field.min"
      :max="field.max"
      size="small"
      controls-position="right"
      style="width: 110px"
      @update:model-value="set($event ?? 0)"
    />
  </div>

  <!-- ref-* pickers (objects / players / events) -->
  <el-select
    v-else-if="isRef"
    :model-value="(modelValue as string) || ''"
    size="small"
    filterable
    clearable
    placeholder="— не задано —"
    style="width: 100%"
    @update:model-value="set($event || '')"
  >
    <el-option v-for="o in refOptions" :key="o.value" :value="o.value" :label="o.label" />
  </el-select>

  <!-- global template/item/spell id, or free text -->
  <el-input
    v-else
    :model-value="(modelValue as string) ?? ''"
    size="small"
    :placeholder="isGlobalId ? 'глобальный id (напр. G000IG0001)' : ''"
    :type="field.key === 'text' || field.key === 'code' || field.key === 'desc' ? 'textarea' : 'text'"
    :autosize="field.key === 'text' || field.key === 'code' || field.key === 'desc' ? { minRows: 1, maxRows: 4 } : undefined"
    @update:model-value="set($event)"
  />
</template>

<style scoped>
.ev-int {
  display: flex;
  gap: 6px;
  align-items: center;
}
</style>
