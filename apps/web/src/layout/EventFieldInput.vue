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
import { useCollabStore } from "../stores/collabStore";
import { useItemStore, ITEM_CAT_LABELS } from "../stores/itemStore";
import { useSpellStore } from "../stores/spellStore";
import { useDecorStore } from "../stores/decorStore";
import { useEventStore } from "../stores/eventStore";
import { useRefNames } from "../services/refNames";
import { locationRoleCounts, ROLE_META, type RoleClass, type RoleCounts } from "../services/scenarioRoles";
import CodeInput from "./CodeInput.vue";
import CommitInput from "./CommitInput.vue";
import DecorThumb from "./DecorThumb.vue";
import MiniMap from "./MiniMap.vue";
import RegionPreview from "./RegionPreview.vue";

const props = defineProps<{
  field: EventFieldSpec;
  modelValue: unknown;
  /** ref-loc only: offer «▦ Вся зона» entries (the owner expands them into event clones). */
  allowZone?: boolean;
}>();
const emit = defineEmits<{
  (e: "update:modelValue", v: unknown): void;
  /** «▦ Вся зона» chosen: modelValue is already set to the zone's first primitive;
   *  the owner (EventsPanel) clones the event across the rest. */
  (e: "zonePick", zid: string): void;
}>();

const edit = useEditStore();
const toolStore = useToolStore();
const viewStore = useViewStore();
const collabStore = useCollabStore();
const itemStore = useItemStore();
const spellStore = useSpellStore();
const decorStore = useDecorStore();
const eventStore = useEventStore();
const names = useRefNames();
// lazy catalog loads (tiny JSONs, cached across all field inputs)
void itemStore.load();
void spellStore.load();
void decorStore.load();

/** «Новый тип» декорации (changeLandmark.lmarkType): options over the decor catalog,
 *  name first — the raw G000MG… id stays the stored value, never the face. */
const decorOptions = computed<{ value: string; label: string; thumb: import("../stores/decorStore").DecorEntry["thumb"] }[]>(() =>
  decorStore.all
    .map((e) => ({
      value: e.id,
      label: `${e.name_ru || e.desc_en || e.id} · ${e.cx}×${e.cy}`,
      thumb: e.thumb,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "ru")),
);

/** «Шаблон отряда» → open the Шаблоны tab with this template selected (breadcrumbed). */
function openTemplate(): void {
  const id = typeof props.modelValue === "string" ? props.modelValue : "";
  if (!id) return;
  eventStore.selectTemplate(id);
  eventStore.navigate({ tab: "templates" });
}

/** «Событие» (ref-event, e.g. вкл/выкл) → jump to the referenced event (breadcrumbed). */
function openEvent(): void {
  const id = typeof props.modelValue === "string" ? props.modelValue : "";
  if (!id) return;
  eventStore.navigate({ tab: "events", eventId: id, fromLink: true });
}

/** Which object types back each ref picker. */
const REF_TYPES: Record<string, string[]> = {
  "ref-loc": ["location"],
  "ref-stack": ["stack"],
  "ref-city": ["village", "capital"],
  "ref-ruin": ["ruin"],
  "ref-site": ["merchant", "mage", "trainer", "mercenary"],
  "ref-lmark": ["landmark"],
  // цель приказа: отряд (атаковать/защищать/помогать), город (удерживать/красть/защищать)
  // или локация (идти/защищать) — по категории приказа
  "ref-target": ["stack", "village", "capital", "location"],
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

/** Location picker GROUPS by scenario role — so «свободные» (не задействованные ни одним
 *  событием) выбираются сразу, а вход-триггерные и прочие занятые легко исключить взглядом.
 *  Dominance order matches the on-map roles overlay: trigger > spawn > destination > env.
 *  Option labels carry ALL role badges («⚡2 ✨») so multi-role locations are explicit. */
const ROLE_ORDER: RoleClass[] = ["trigger", "spawn", "destination", "env"];
const badgesOf = (c: RoleCounts): string =>
  ROLE_ORDER.filter((k) => c[k] > 0)
    .map((k) => ROLE_META[k].icon + (c[k] > 1 ? c[k] : ""))
    .join(" ");
const locGroups = computed<{ label: string; options: Opt[] }[]>(() => {
  const doc = edit.liveDoc;
  if (!doc) return [];
  const counts = locationRoleCounts(doc);
  // zone-generated locations get their OWN groups («▦ Зона „X“») instead of drowning the
  // role buckets — a zone's primitives are picked via the zone, not one by one
  const zoneOf = new Map<string, string>();
  for (const z of Object.values(edit.zones)) for (const id of z.locIds) zoneOf.set(id, z.name);
  const zoneBuckets = new Map<string, Opt[]>();
  const buckets: Record<string, Opt[]> = { free: [], trigger: [], spawn: [], destination: [], env: [] };
  for (const o of doc.objects) {
    if (o.type !== "location") continue;
    const c = counts[o.id];
    const name = (o as { name?: string }).name || o.id;
    const zone = zoneOf.get(o.id);
    if (zone !== undefined) {
      const label = `${name} · ${o.pos.x},${o.pos.y}${c ? ` · ${badgesOf(c)}` : ""}`;
      const list = zoneBuckets.get(zone) ?? [];
      list.push({ value: o.id, label });
      zoneBuckets.set(zone, list);
      continue;
    }
    if (!c) {
      buckets.free!.push({ value: o.id, label: `${name} · ${o.pos.x},${o.pos.y}` });
      continue;
    }
    const dominant = ROLE_ORDER.find((k) => c[k] > 0)!;
    buckets[dominant]!.push({ value: o.id, label: `${name} · ${o.pos.x},${o.pos.y} · ${badgesOf(c)}` });
  }
  for (const list of Object.values(buckets)) list.sort((a, b) => a.label.localeCompare(b.label, "ru"));
  const out: { label: string; options: Opt[] }[] = [];
  const zidByName = new Map(Object.entries(edit.zones).map(([zid, z]) => [z.name, zid]));
  for (const [zn, list] of [...zoneBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0], "ru"))) {
    list.sort((a, b) => a.label.localeCompare(b.label, "ru"));
    // for condition fields: pick the WHOLE zone — the panel clones the event per primitive
    if (props.allowZone && list.length >= 2) {
      const zid = zidByName.get(zn);
      if (zid) list.unshift({ value: `ZONE::${zid}`, label: `▦ Вся зона «${zn}» (${list.length} лок.)` });
    }
    out.push({ label: `▦ Зона «${zn}» (${list.length})`, options: list });
  }
  if (buckets.free!.length) out.push({ label: `Свободные — не в сценарии (${buckets.free!.length})`, options: buckets.free! });
  for (const k of ROLE_ORDER) {
    if (buckets[k]!.length)
      out.push({ label: `${ROLE_META[k].icon} ${ROLE_META[k].label} (${buckets[k]!.length})`, options: buckets[k]! });
  }
  return out;
});

/** Цель приказа (ref-target): три группы — отряды (по лидеру), города, локации. */
const targetGroups = computed<{ label: string; options: Opt[] }[]>(() => {
  const doc = edit.liveDoc;
  if (!doc) return [];
  const mk = (types: string[]): Opt[] =>
    doc.objects
      .filter((o) => types.includes(o.type))
      .map((o) => ({ value: o.id, label: `${names.objName(o.id)} · ${o.pos.x},${o.pos.y}` }))
      .sort((a, b) => a.label.localeCompare(b.label, "ru"));
  const out: { label: string; options: Opt[] }[] = [];
  const stacks = mk(["stack"]);
  const cities = mk(["village", "capital"]);
  const locs = mk(["location"]);
  if (stacks.length) out.push({ label: "Отряды (атаковать / защищать / помогать)", options: stacks });
  if (cities.length) out.push({ label: "Города (удерживать / красть / защищать)", options: cities });
  if (locs.length) out.push({ label: "Локации (идти / защищать)", options: locs });
  return out;
});

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

/** ref-loc select handler: «▦ Вся зона» resolves to the zone's FIRST live primitive (the
 *  model field always holds a real location id — the codec knows nothing about zones) and
 *  tells the owner to clone the event across the rest. */
function onLocPick(v: unknown): void {
  const s = String(v ?? "");
  if (s.startsWith("ZONE::")) {
    const zid = s.slice(6);
    const z = edit.zones[zid];
    const first = z?.locIds.find((id) => edit.liveDoc?.objects.some((o) => o.id === id));
    if (!z || !first) {
      ElMessage.warning("У зоны нет живых локаций");
      return;
    }
    emit("update:modelValue", first);
    emit("zonePick", zid);
    return;
  }
  set(s);
}

/** Террейн-превью выбранной локации (ref-loc): крестик = якорная клетка, жёлтый контур =
 *  область (2r+1)², синие ромбы = маска зоны, если локация — примитив зоны. */
const locPreview = computed(() => {
  if (props.field.type !== "ref-loc") return null;
  const id = typeof props.modelValue === "string" ? props.modelValue : "";
  const o = id ? edit.liveDoc?.objects.find((x) => x.id === id) : null;
  if (!o || o.type !== "location") return null;
  const r = o.radius ?? 0;
  let zoneCells: readonly string[] | null = null;
  for (const z of Object.values(edit.zones)) {
    if (z.locIds.includes(o.id)) { zoneCells = z.cells; break; }
  }
  return {
    cell: o.pos,
    radius: Math.max(4, r + 3),
    mark: o.pos,
    bounds: { x0: o.pos.x - r, y0: o.pos.y - r, x1: o.pos.x + r, y1: o.pos.y + r },
    cells: zoneCells,
  };
});

// --- ref-loc extras: показать на карте / создать новую локацию / миникарта ---------------
/** Center the main camera on the referenced object + select it (overlay follows). */
function showOnMap(): void {
  const id = props.modelValue as string;
  const obj = id ? edit.liveDoc?.objects.find((o) => o.id === id) : null;
  if (!obj) return;
  if (obj.type === "location" && !viewStore.locationsVisible) viewStore.toggleLocations();
  toolStore.setSelectedId(obj.id);
  const w = cellToWorld(obj.pos.x + 0.5, obj.pos.y + 0.5);
  getScene()?.centerOn(w.x, w.y); // centers AND paints now (rAF is throttled off-canvas)
}

/** Create a location at the CURRENT view center, assign it to this field, select it. */
function newLocation(): void {
  const doc = edit.liveDoc;
  if (!doc) return;
  const vc = viewStore.visibleCells;
  const clampC = (v: number): number => Math.max(0, Math.min(doc.size - 1, v));
  const cx = clampC(vc ? Math.round(vc.x + vc.w / 2) : Math.floor(doc.size / 2));
  const cy = clampC(vc ? Math.round(vc.y + vc.h / 2) : Math.floor(doc.size / 2));
  const ops = placeLocationOps(doc, cx, cy, 2, "Новая локация", collabStore.idSlot);
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
  "ref-target": "цель приказа (отряд / город / локацию)",
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
        @update:model-value="onLocPick($event || '')"
      >
        <!-- группы по роли: «Свободные» первыми — их берут для нового спавна/зоны;
             вход-триггерные и прочие занятые исключаются одним взглядом.
             «▦ Вся зона» (allowZone) разворачивается панелью в клоны события -->
        <el-option-group v-for="g in locGroups" :key="g.label" :label="g.label">
          <el-option v-for="o in g.options" :key="o.value" :value="o.value" :label="o.label" />
        </el-option-group>
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
    <!-- террейн-превью точки: крестик = якорь, контур = область, ромбы = маска зоны; 🔍 = лупа -->
    <RegionPreview
      v-if="locPreview"
      :cell="locPreview.cell"
      :radius="locPreview.radius"
      :mark="locPreview.mark"
      :bounds="locPreview.bounds"
      :cells="locPreview.cells"
      zoomable
      class="ev-loc-map"
    />
    <!-- мини-вью: где именно эта зона — изометрический ромб, только море + города
         + подсвеченная локация (клик центрирует камеру) -->
    <MiniMap v-if="modelValue" :highlight-id="(modelValue as string)" :size="216" mode="simple" class="ev-loc-map" />
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

  <!-- ref-target (цель приказа): группы отряды / города / локации, с 📍/🎯 -->
  <div v-else-if="field.type === 'ref-target'" class="ev-loc-row">
    <el-select
      :model-value="(modelValue as string) || ''"
      size="small"
      filterable
      clearable
      placeholder="— цель приказа —"
      class="ev-loc-sel"
      @update:model-value="set($event || '')"
    >
      <el-option-group v-for="g in targetGroups" :key="g.label" :label="g.label">
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
    <el-tooltip v-if="field.type === 'template'" content="Открыть во вкладке «Шаблоны»" :show-after="300">
      <el-button size="small" text class="ev-loc-btn" :disabled="!modelValue" @click="openTemplate()">✎</el-button>
    </el-tooltip>
    <el-tooltip v-if="field.type === 'ref-event'" content="Перейти к этому событию" :show-after="300">
      <el-button size="small" text class="ev-loc-btn" :disabled="!modelValue" @click="openEvent()">➜</el-button>
    </el-tooltip>
  </div>

  <!-- «Новый тип» декорации: выбор по имени из каталога, с тумбнейлом -->
  <el-select
    v-else-if="field.key === 'lmarkType'"
    :model-value="(modelValue as string) || ''"
    size="small"
    filterable
    clearable
    placeholder="— декорация —"
    style="width: 100%"
    @update:model-value="set($event || '')"
  >
    <el-option v-for="o in decorOptions" :key="o.value" :value="o.value" :label="o.label">
      <span class="ev-decor-opt">
        <DecorThumb :thumb="o.thumb" :size="22" />
        <span>{{ o.label }}</span>
      </span>
    </el-option>
  </el-select>

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

  <!-- free text — commits on blur/Enter (not per keystroke) so a big scenario stays responsive -->
  <CommitInput
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
.ev-decor-opt { display: flex; align-items: center; gap: 8px; }
</style>
