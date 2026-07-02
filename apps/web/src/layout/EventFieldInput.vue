<script setup lang="ts">
/**
 * One typed input for a scenario-event condition/effect field, driven by the shared
 * EventFieldSpec. int/enum -> number or preset select; bool -> switch; text -> input;
 * ref-* -> a picker over the matching map objects (or players/events); item/spell ->
 * name-based catalog dropdowns (no raw G###… ids in the user's face — the id is the
 * option value, the label is the game name + effect line).
 */
import { computed, watch } from "vue";
import { ElInputNumber, ElSwitch, ElInput, ElSelect, ElOption, ElOptionGroup, ElButton, ElTooltip, ElMessage } from "element-plus";
import type { EventFieldSpec } from "@d2/map-schema";
import { placeLocationOps } from "@d2/map-edit";
import { cellToWorld } from "@d2/pixi-render";
import { getScene } from "../canvas/sceneHolder";
import { useEditStore } from "../stores/editStore";
import { useToolStore } from "../stores/toolStore";
import { useViewStore } from "../stores/viewStore";
import { useItemStore, ITEM_CAT_LABELS } from "../stores/itemStore";
import { useSpellStore } from "../stores/spellStore";
import { useRefNames } from "../services/refNames";
import CodeInput from "./CodeInput.vue";
import MiniMap from "./MiniMap.vue";

const props = defineProps<{ field: EventFieldSpec; modelValue: unknown }>();
const emit = defineEmits<{ (e: "update:modelValue", v: unknown): void }>();

const edit = useEditStore();
const toolStore = useToolStore();
const viewStore = useViewStore();
const itemStore = useItemStore();
const spellStore = useSpellStore();
const names = useRefNames();
// lazy catalog loads (tiny JSONs, cached across all field inputs)
void itemStore.load();
void spellStore.load();

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
  if (t === "template") {
    return (doc.templates ?? []).map((tm) => ({ value: tm.id, label: `${tm.name || "шаблон"} · ${tm.id}` }));
  }
  const types = REF_TYPES[t];
  if (!types) return [];
  return doc.objects
    .filter((o) => types.includes(o.type))
    .map((o) => ({ value: o.id, label: `${names.objName(o.id)} · ${o.id}` }));
});

/** Stack fields get TWO groups: placed stacks (labelled by LEADER: «Отряд: Паладин · 12,30»)
 *  and stack TEMPLATES — real maps put template ids in stack fields («любой отряд, созданный
 *  из шаблона»; MidStack keeps SRCTMPL_ID for exactly this matching). */
const stackGroups = computed<{ label: string; options: Opt[] }[]>(() => {
  const doc = edit.liveDoc;
  if (!doc) return [];
  const stacks = doc.objects
    .filter((o) => o.type === "stack")
    .map((o) => {
      const inCity = (o as { garrisoned?: boolean }).garrisoned;
      const where = inCity ? "в городе" : `${o.pos.x},${o.pos.y}`;
      return { value: o.id, label: `${names.objName(o.id)} · ${where}` };
    })
    .sort((a, b) => a.label.localeCompare(b.label, "ru"));
  const templates = (doc.templates ?? []).map((tm) => ({
    value: tm.id,
    label: `${tm.name || "шаблон"} · ${tm.id}`,
  }));
  const out: { label: string; options: Opt[] }[] = [];
  if (stacks.length) out.push({ label: "Отряды на карте", options: stacks });
  if (templates.length) out.push({ label: "Шаблоны (любой отряд из шаблона)", options: templates });
  return out;
});

/** Object-ref types that get the 📍/🎯 helper buttons (players/events are not on the map). */
const isObjRef = computed(() => props.field.type in REF_TYPES);

/** Scenario variables (the `var` field type): stored as the variable's numeric id. */
const varOptions = computed<{ value: number; label: string }[]>(() =>
  (edit.liveDoc?.variables ?? []).map((v) => ({ value: v.id, label: `${v.name || "var"} (=${v.value})` })),
);

// ref-* pickers, plus `template` which is a global-id picked from the doc's templates.
const isRef = computed(() => props.field.type.startsWith("ref-") || props.field.type === "template");

/** Item catalog options: «Имя · категория» sorted by name (the id stays the value). */
const itemOptions = computed<Opt[]>(() =>
  itemStore.all
    .map((e) => ({ value: e.id, label: `${e.name} · ${ITEM_CAT_LABELS[e.catKey] ?? e.catKey}` }))
    .sort((a, b) => a.label.localeCompare(b.label, "ru")),
);
/** Spell catalog options: «Имя · школа/эффект» sorted by name. */
const spellOptions = computed<Opt[]>(() =>
  spellStore.all
    .map((e) => {
      const fx = spellStore.effectOf(e.id);
      return { value: e.id, label: fx ? `${e.name} · ${fx}` : e.name };
    })
    .sort((a, b) => a.label.localeCompare(b.label, "ru")),
);

function set(v: unknown): void {
  emit("update:modelValue", v);
}

// --- ref-loc extras: показать на карте / создать новую локацию / миникарта ---------------
/** Center the main camera on the referenced object + select it (overlay follows). */
function showOnMap(): void {
  const id = props.modelValue as string;
  const obj = id ? edit.liveDoc?.objects.find((o) => o.id === id) : null;
  if (!obj) return;
  if (obj.type === "location" && !viewStore.locationsVisible) viewStore.toggleLocations();
  toolStore.setSelectedId(obj.id);
  const w = cellToWorld(obj.pos.x + 0.5, obj.pos.y + 0.5);
  getScene()?.getCamera()?.centerOn(w.x, w.y);
}

/** Create a location at the CURRENT view center, assign it to this field, select it. */
function newLocation(): void {
  const doc = edit.liveDoc;
  if (!doc) return;
  const vc = viewStore.visibleCells;
  const clampC = (v: number): number => Math.max(0, Math.min(doc.size - 1, v));
  const cx = clampC(vc ? Math.round(vc.x + vc.w / 2) : Math.floor(doc.size / 2));
  const cy = clampC(vc ? Math.round(vc.y + vc.h / 2) : Math.floor(doc.size / 2));
  const ops = placeLocationOps(doc, cx, cy, 2, "Новая локация");
  const first = ops[0] as { object?: { id: string } } | undefined;
  if (!first?.object) return;
  edit.commit(ops);
  set(first.object.id);
  if (!viewStore.locationsVisible) viewStore.toggleLocations();
  toolStore.setSelectedId(first.object.id);
  ElMessage.success("Локация создана в центре экрана — двигайте инструментом «Двигать», радиус в инспекторе");
}

// --- 🎯 «выбрать кликом по карте» (any object-ref field) ----------------------------------
/** Human hint per ref type for the pick toast. */
const PICK_HINT: Record<string, string> = {
  "ref-loc": "локацию", "ref-stack": "отряд", "ref-city": "город",
  "ref-ruin": "руины", "ref-site": "постройку", "ref-lmark": "ориентир",
};
/** Nonce of the pick THIS field requested; only that pick's result is consumed here
 *  (several EventFieldInput instances watch the same store). */
let myPickNonce = -1;
function pickOnMap(): void {
  const types = REF_TYPES[props.field.type];
  if (!types) return;
  // nonce of the pick we are about to own = current counter + 1 (finishObjectPick increments)
  myPickNonce = (toolStore.objectPickResult?.nonce ?? 0) + 1;
  toolStore.startObjectPick(types);
  ElMessage({ message: `Кликните по карте: ${PICK_HINT[props.field.type] ?? "объект"} (Esc — отмена)`, type: "info", duration: 4000 });
}
watch(
  () => toolStore.objectPickResult,
  (r) => {
    if (r && r.nonce === myPickNonce) {
      myPickNonce = -1;
      set(r.id);
    }
  },
);
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

  <!-- scenario variable picker (stored as the variable's numeric id) -->
  <el-select
    v-else-if="field.type === 'var'"
    :model-value="Number(modelValue) || 0"
    size="small"
    filterable
    style="width: 100%"
    placeholder="— переменная —"
    @update:model-value="set($event)"
  >
    <el-option v-for="o in varOptions" :key="o.value" :value="o.value" :label="o.label" />
  </el-select>

  <!-- int (optionally with quick presets shown before the number box) -->
  <div v-else-if="field.type === 'int'" class="ev-int">
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

  <!-- ref-loc: picker + показать/создать + миникарта для перепроверки места -->
  <div v-else-if="field.type === 'ref-loc'" class="ev-loc">
    <div class="ev-loc-row">
      <el-select
        :model-value="(modelValue as string) || ''"
        size="small"
        filterable
        clearable
        placeholder="— локация —"
        class="ev-loc-sel"
        @update:model-value="set($event || '')"
      >
        <el-option v-for="o in refOptions" :key="o.value" :value="o.value" :label="o.label" />
      </el-select>
      <el-tooltip content="Показать на карте (центрирует камеру)" :show-after="300">
        <el-button size="small" text class="ev-loc-btn" :disabled="!modelValue" @click="showOnMap()">📍</el-button>
      </el-tooltip>
      <el-tooltip content="Выбрать кликом по карте" :show-after="300">
        <el-button size="small" text class="ev-loc-btn" @click="pickOnMap()">🎯</el-button>
      </el-tooltip>
      <el-tooltip content="Новая локация в центре экрана" :show-after="300">
        <el-button size="small" text class="ev-loc-btn" @click="newLocation()">＋</el-button>
      </el-tooltip>
    </div>
    <!-- мини-вью: где именно эта зона (клик по миникарте центрирует камеру) -->
    <MiniMap v-if="modelValue" :highlight-id="(modelValue as string)" :size="150" class="ev-loc-map" />
  </div>

  <!-- ref-stack: grouped picker — отряды по ЛИДЕРУ + шаблоны отрядов, с 📍/🎯 -->
  <div v-else-if="field.type === 'ref-stack'" class="ev-loc-row">
    <el-select
      :model-value="(modelValue as string) || ''"
      size="small"
      filterable
      clearable
      placeholder="— отряд или шаблон —"
      class="ev-loc-sel"
      @update:model-value="set($event || '')"
    >
      <el-option-group v-for="g in stackGroups" :key="g.label" :label="g.label">
        <el-option v-for="o in g.options" :key="o.value" :value="o.value" :label="o.label" />
      </el-option-group>
    </el-select>
    <el-tooltip content="Показать на карте (центрирует камеру)" :show-after="300">
      <el-button size="small" text class="ev-loc-btn" :disabled="!modelValue" @click="showOnMap()">📍</el-button>
    </el-tooltip>
    <el-tooltip content="Выбрать кликом по карте" :show-after="300">
      <el-button size="small" text class="ev-loc-btn" @click="pickOnMap()">🎯</el-button>
    </el-tooltip>
  </div>

  <!-- ref-* pickers (objects / players / events); объектные — с 📍/🎯 -->
  <div v-else-if="isRef" class="ev-loc-row">
    <el-select
      :model-value="(modelValue as string) || ''"
      size="small"
      filterable
      clearable
      placeholder="— не задано —"
      class="ev-loc-sel"
      @update:model-value="set($event || '')"
    >
      <el-option v-for="o in refOptions" :key="o.value" :value="o.value" :label="o.label" />
    </el-select>
    <template v-if="isObjRef">
      <el-tooltip content="Показать на карте (центрирует камеру)" :show-after="300">
        <el-button size="small" text class="ev-loc-btn" :disabled="!modelValue" @click="showOnMap()">📍</el-button>
      </el-tooltip>
      <el-tooltip content="Выбрать кликом по карте" :show-after="300">
        <el-button size="small" text class="ev-loc-btn" @click="pickOnMap()">🎯</el-button>
      </el-tooltip>
    </template>
  </div>

  <!-- item / spell: name-based catalog dropdowns (id stays the stored value) -->
  <el-select
    v-else-if="field.type === 'item' || field.type === 'spell'"
    :model-value="(modelValue as string) || ''"
    size="small"
    filterable
    clearable
    :placeholder="field.type === 'item' ? '— предмет —' : '— заклинание —'"
    style="width: 100%"
    @update:model-value="set($event || '')"
  >
    <el-option
      v-for="o in field.type === 'item' ? itemOptions : spellOptions"
      :key="o.value" :value="o.value" :label="o.label"
    />
  </el-select>

  <!-- код (Lua-скрипт) — с подсветкой синтаксиса -->
  <CodeInput
    v-else-if="field.key === 'code'"
    :model-value="(modelValue as string) ?? ''"
    @update:model-value="set($event)"
  />

  <!-- free text -->
  <el-input
    v-else
    :model-value="(modelValue as string) ?? ''"
    size="small"
    :type="field.key === 'text' || field.key === 'desc' ? 'textarea' : 'text'"
    :autosize="field.key === 'text' || field.key === 'desc' ? { minRows: 1, maxRows: 4 } : undefined"
    @update:model-value="set($event)"
  />
</template>

<style scoped>
.ev-int {
  display: flex;
  gap: 6px;
  align-items: center;
}
.ev-loc { display: flex; flex-direction: column; gap: 6px; }
.ev-loc-row { display: flex; align-items: center; gap: 2px; }
.ev-loc-sel { flex: 1; min-width: 0; }
.ev-loc-btn { padding: 4px 6px; opacity: 0.65; transition: opacity 0.12s; }
.ev-loc-btn:hover { opacity: 1; }
.ev-loc-map { align-self: flex-start; }
</style>
