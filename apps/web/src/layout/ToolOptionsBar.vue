<script setup lang="ts">
/**
 * Compact floating options bar (top-left of the canvas). Shows ONLY for tools
 * that actually have parameters — terrain (land type + brush size),
 * water/forest/erase (brush size), and «Локации» (scenario-role filter). For every
 * other tool it isn't rendered at all, so the canvas keeps its full width and
 * there's no empty panel. It floats (absolute), so appearing/disappearing never
 * reflows the canvas.
 */
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { ElSegmented, ElSelect, ElOption, ElTooltip, ElInput, ElButton, ElMessage, ElMessageBox } from "element-plus";
import { estimateTileCount } from "@d2/map-edit";
import { useToolStore, type ZoneMode, type PlaceObjectKind } from "../stores/toolStore";
import UnitPicker from "./UnitPicker.vue";
import { useEditStore } from "../stores/editStore";
import { useEventStore } from "../stores/eventStore";
import { useViewStore } from "../stores/viewStore";
import { LOC_FILTERS, type LocFilter } from "../services/scenarioRoles";

const toolStore = useToolStore();
const editStore = useEditStore();
const eventStore = useEventStore();
const viewStore = useViewStore();
const { tool, size, terrainId, locFilter, zoneMode, regionMask, region } = storeToRefs(toolStore);

const terrains = [
  { value: 5, label: "Нейтральная" },
  { value: 1, label: "Империя" },
  { value: 4, label: "Нежить" },
  { value: 3, label: "Легионы" },
  { value: 6, label: "Эльфы" },
  { value: 2, label: "Горы (снег)" },
];
const sizeOptions = [
  { label: "1×1", value: 1 },
  { label: "3×3", value: 3 },
  { label: "5×5", value: 5 },
];

/** «Локации»: role filter — non-matching locations dim out and are not pickable.
 *  Значения и подписи — единый источник LOC_FILTERS (services/scenarioRoles): триггеры
 *  разложены по смыслу (⚡ вход / 👣 отряд в зоне / 🎒 предмет), остальное по классу роли. */
const locFilterOptions = LOC_FILTERS.map((f) => ({ label: f.icon, value: f.value }));
const LOC_FILTER_HINT = "Фильтр локаций: " + LOC_FILTERS.map((f) => `${f.icon} ${f.hint}`).join(" · ");
function onLocFilter(v: string | number | boolean): void {
  toolStore.setLocFilter(v as LocFilter);
}

// «Зона»: нарисованная маска → локации-примитивы (5×5/3×3/1×1). Оценка пересчитывается
// на отпускание мыши (маска финализируется в pointerup — не на каждое движение).
const ZONE_MODES: { label: string; value: ZoneMode }[] = [
  { label: "▭", value: "rect" }, { label: "🖌", value: "brush" },
  { label: "╱", value: "line" }, { label: "▢", value: "frame" },
];
const zoneName = ref("");
const zoneCells = computed<string[]>(() => {
  if (regionMask.value?.length) return regionMask.value;
  const r = region.value;
  if (!r) return [];
  const out: string[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push(`${x},${y}`);
  return out;
});
const zoneEstimate = computed(() =>
  zoneCells.value.length ? estimateTileCount(new Set(zoneCells.value)) : 0,
);
/** Existing zones — pick one to REGENERATE (new mask replaces its locations) or delete.
 *  Store-lifted: the zone inspector's «Перегенерировать» presets it before switching here. */
const { regenZoneId } = storeToRefs(toolStore);
const zoneOptions = computed(() =>
  Object.entries(editStore.zones).map(([id, z]) => ({ value: id, label: `${z.name} (${z.locIds.length})` })),
);
watch(regenZoneId, (zid) => {
  const z = zid ? editStore.zones[zid] : undefined;
  if (z) zoneName.value = z.name; // prefill; можно переименовать при перегенерации
});
function makeZone(): void {
  const name = zoneName.value.trim() || "Зона";
  const regen = regenZoneId.value || undefined;
  const zid = editStore.createZone(name, zoneCells.value, regen);
  if (!zid) return;
  // regen: события зоны пере-деривируются на новые примитивы (клоны пересоздаются)
  const resynced = regen ? eventStore.resyncZoneEventsAfterRegen(zid) : 0;
  ElMessage.success(
    regen
      ? `«${name}»: перегенерировано — локаций ${zoneEstimate.value}${resynced ? `, событий-клонов пересобрано ${resynced}` : ""}`
      : `«${name}»: зона создана (${zoneEstimate.value} лок. под капотом) — управляется как одно целое`,
  );
  zoneName.value = "";
  regenZoneId.value = "";
  toolStore.clearZone(); // сбросить маску (рисуй следующую)
  // показать результат сразу: слой локаций (+роли едут следом) + выбрать зону
  if (!viewStore.locationsVisible) viewStore.setLayerVisible("locations", true);
  toolStore.setSelectedZone(zid);
}
function deleteZone(): void {
  const zid = regenZoneId.value;
  const z = editStore.zones[zid];
  if (!z) return;
  void ElMessageBox.confirm(
    `Удалить зону «${z.name}» вместе с её ${z.locIds.length} локациями? (события, повешенные на них, останутся и будут ссылаться в пустоту)`,
    "Удалить зону",
    { confirmButtonText: "Удалить", cancelButtonText: "Отмена", type: "warning" },
  )
    .then(() => {
      editStore.removeZone(zid, true);
      regenZoneId.value = "";
      zoneName.value = "";
      ElMessage.success(`Зона «${z.name}» удалена`);
    })
    .catch(() => { /* отмена */ });
}
function onZoneMode(v: string | number | boolean): void {
  toolStore.setZoneMode(v as ZoneMode);
}

/** «Объекты»: what the object tool places + the mandatory leader for a stack. */
const OBJECT_KINDS: { value: PlaceObjectKind; label: string }[] = [
  { value: "village", label: "🏘 Город" },
  { value: "ruin", label: "🏚 Руина" },
  { value: "treasure", label: "💰 Сундук" },
  { value: "stack", label: "⚔ Отряд" },
  { value: "merchant", label: "🛒 Торговец" },
  { value: "mage", label: "🔮 Маг" },
  { value: "trainer", label: "🎓 Тренер" },
  { value: "mercenary", label: "🛡 Наёмники" },
];
const { objectKind, stackLeaderId } = storeToRefs(toolStore);

const SIZED = new Set(["terrain", "water", "forest", "erase"]);
const showTerrain = computed(() => tool.value === "terrain");
const showLocFilter = computed(() => tool.value === "locations");
const showZoneTool = computed(() => tool.value === "zone");
const showObjectTool = computed(() => tool.value === "object");
const visible = computed(() => SIZED.has(tool.value) || showLocFilter.value || showZoneTool.value || showObjectTool.value);
</script>

<template>
  <div v-if="visible" class="tool-opts d2-float">
    <template v-if="showZoneTool">
      <el-tooltip content="Как рисовать: прямоугольник · кисть · линия · рамка" :show-after="300">
        <el-segmented :model-value="zoneMode" :options="ZONE_MODES" size="small" @change="onZoneMode" />
      </el-tooltip>
      <el-segmented v-if="zoneMode === 'brush' || zoneMode === 'line'" v-model="size" :options="sizeOptions" size="small" />
      <el-input v-model="zoneName" size="small" placeholder="имя зоны" style="width: 130px" @keyup.enter="makeZone()" />
      <el-select
        v-if="zoneOptions.length"
        v-model="regenZoneId"
        size="small"
        clearable
        placeholder="перегенерир.…"
        title="Выбрать существующую зону: новая маска заменит её локации; 🗑 удаляет зону"
        style="width: 132px"
      >
        <el-option v-for="z in zoneOptions" :key="z.value" :value="z.value" :label="z.label" />
      </el-select>
      <el-button size="small" type="primary" plain :disabled="!zoneCells.length" @click="makeZone()">
        {{ regenZoneId ? "Перегенерировать" : "Нарезать" }} → {{ zoneEstimate }} лок.
      </el-button>
      <el-button v-if="regenZoneId" size="small" text title="Удалить зону вместе с её локациями" @click="deleteZone()">🗑</el-button>
      <el-button v-if="zoneCells.length" size="small" text title="Сбросить нарисованное" @click="toolStore.clearZone()">✕</el-button>
    </template>
    <template v-else-if="showLocFilter">
      <el-tooltip :content="LOC_FILTER_HINT" placement="bottom" :show-after="300">
        <el-segmented :model-value="locFilter" :options="locFilterOptions" size="small" @change="onLocFilter" />
      </el-tooltip>
    </template>
    <template v-else-if="showObjectTool">
      <el-select v-model="objectKind" size="small" style="width: 132px" title="Что ставим">
        <el-option v-for="k in OBJECT_KINDS" :key="k.value" :label="k.label" :value="k.value" />
      </el-select>
      <template v-if="objectKind === 'stack'">
        <span class="obj-lbl">Лидер:</span>
        <UnitPicker v-model="stackLeaderId" nullable roster="leaders" title="Лидер нового отряда" />
      </template>
    </template>
    <template v-else>
      <el-select
        v-if="showTerrain"
        v-model="terrainId"
        class="to-terrain"
        placeholder="Тип земли"
        size="small"
      >
        <el-option v-for="t in terrains" :key="t.value" :label="t.label" :value="t.value" />
      </el-select>
      <el-segmented v-model="size" :options="sizeOptions" size="small" />
    </template>
  </div>
</template>

<style scoped>
.tool-opts {
  position: absolute;
  top: var(--d2-sp-2);
  left: var(--d2-sp-2);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: var(--d2-sp-2);
  padding: var(--d2-sp-1) var(--d2-sp-2);
}
.to-terrain {
  width: 150px;
}
.obj-lbl {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
