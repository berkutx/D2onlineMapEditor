<script setup lang="ts">
/**
 * ZoneInspector — the right rail for a selected free-form ZONE (a project entity that
 * owns N generated location primitives). The zone is edited as ONE thing: rename (its
 * primitives follow), regenerate (jumps to the «Зона» tool with this zone preset), or
 * delete (primitives included). Primitives never appear here — that's the point.
 */
import { computed, ref, watch } from "vue";
import { ElInput, ElButton, ElMessage, ElMessageBox, ElTooltip } from "element-plus";
import { useToolStore } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";
import { useEventStore } from "../stores/eventStore";

const toolStore = useToolStore();
const editStore = useEditStore();
const eventStore = useEventStore();

const zid = computed(() => toolStore.selectedZoneId);
const zone = computed(() => (zid.value ? editStore.zones[zid.value] : undefined));

const name = ref("");
watch(zone, (z) => { name.value = z?.name ?? ""; }, { immediate: true });
function commitName(): void {
  if (zid.value && name.value.trim()) editStore.renameZone(zid.value, name.value);
}

const liveLocCount = computed(() => {
  const doc = editStore.liveDoc;
  const z = zone.value;
  if (!doc || !z) return 0;
  return z.locIds.filter((id) => doc.objects.some((o) => o.id === id)).length;
});
/** Events wired to this zone: clone groups + any event whose zone condition targets a primitive. */
const eventCount = computed(() => {
  const z = zone.value;
  if (!z) return 0;
  const live = new Set(eventStore.events.map((e) => e.id));
  const grouped = new Set<string>();
  for (const g of z.eventGroups ?? []) for (const id of g) if (live.has(id)) grouped.add(id);
  return grouped.size;
});

function regenerate(): void {
  if (!zid.value) return;
  toolStore.regenZoneId = zid.value;
  toolStore.setTool("zone");
  ElMessage.info("Нарисуйте новую форму — «Перегенерировать» заменит локации зоны");
}

function remove(): void {
  const z = zone.value;
  const id = zid.value;
  if (!z || !id) return;
  void ElMessageBox.confirm(
    `Удалить зону «${z.name}» вместе с её ${liveLocCount.value} локациями?` +
      (eventCount.value ? ` На ней ${eventCount.value} событий — они останутся и будут ссылаться в пустоту.` : ""),
    "Удалить зону",
    { confirmButtonText: "Удалить", cancelButtonText: "Отмена", type: "warning" },
  )
    .then(() => {
      editStore.removeZone(id, true);
      toolStore.setSelectedZone(null);
      ElMessage.success(`Зона «${z.name}» удалена`);
    })
    .catch(() => { /* отмена */ });
}
</script>

<template>
  <div v-if="zone" class="zone-insp">
    <div class="zi-head">
      <span class="zi-kind">Зона</span>
      <span class="zi-id">{{ zid }}</span>
      <el-button text size="small" class="zi-close" @click="toolStore.setSelectedZone(null)">✕</el-button>
    </div>

    <label class="zi-label">Название</label>
    <el-input v-model="name" size="small" @blur="commitName" @keyup.enter="commitName" />

    <div class="zi-stats">
      <div><span class="zi-num">{{ zone.cells.length }}</span> клеток формы</div>
      <el-tooltip content="Игровые локации-примитивы, которыми зона накрыта под капотом. Управляются зоной целиком — по одной их трогать не нужно." :show-after="300">
        <div><span class="zi-num">{{ liveLocCount }}</span> локаций внутри</div>
      </el-tooltip>
      <div v-if="eventCount"><span class="zi-num">{{ eventCount }}</span> событий на зоне</div>
    </div>

    <div class="zi-actions">
      <el-button size="small" plain @click="regenerate()">✎ Перегенерировать форму</el-button>
      <el-button size="small" plain type="danger" @click="remove()">🗑 Удалить зону</el-button>
    </div>

    <p class="zi-hint">
      Тащите зону на карте — она едет целиком. События вешаются на зону в редакторе
      событий: условие «Вход в зону» → пункт «▦ Вся зона».
    </p>
  </div>
</template>

<style scoped>
.zone-insp {
  height: 100%;
  padding: var(--d2-sp-3);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
  overflow-y: auto;
}
.zi-head { display: flex; align-items: center; gap: 8px; }
.zi-kind { font-size: 13px; font-weight: 600; }
.zi-id { color: var(--el-text-color-secondary); font-family: monospace; font-size: 11px; }
.zi-close { margin-left: auto; }
.zi-label { color: var(--el-text-color-secondary); }
.zi-stats { display: flex; flex-direction: column; gap: 4px; color: var(--el-text-color-regular); }
.zi-num { font-weight: 600; font-variant-numeric: tabular-nums; }
.zi-actions { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
.zi-actions .el-button { margin-left: 0; }
.zi-hint { color: var(--el-text-color-secondary); line-height: 1.4; margin: 4px 0 0; }
</style>
