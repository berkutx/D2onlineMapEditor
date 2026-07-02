<script setup lang="ts">
/**
 * Read-only object inspector: a category -> count breakdown of the open map's
 * objects. Stage 1 is non-interactive; this is a quick "what's on the map" view.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useMapStore } from "../stores/mapStore";

const mapStore = useMapStore();
const { objectCounts, totalObjects, currentMap } = storeToRefs(mapStore);

/** Friendly labels for the discriminated-union object types. */
const LABELS: Record<string, string> = {
  stack: "Stacks",
  fort: "Forts",
  capital: "Capitals",
  village: "Villages",
  ruin: "Ruins",
  merchant: "Merchants",
  mage: "Mages",
  trainer: "Trainers",
  mercenary: "Mercenaries",
  mountains: "Mountains",
  crystal: "Crystals",
  landmark: "Landmarks",
  location: "Locations",
  unit: "Units",
  generic: "Other",
};

const rows = computed(() =>
  Object.entries(objectCounts.value)
    .map(([type, count]) => ({ type, label: LABELS[type] ?? type, count }))
    .sort((a, b) => b.count - a.count),
);
</script>

<template>
  <div class="object-panel d2-rail d2-rail--left">
    <div class="panel-header">Objects</div>
    <div v-if="!currentMap" class="panel-empty">No map loaded</div>
    <template v-else>
      <el-scrollbar class="panel-scroll">
        <ul class="count-list">
          <li v-for="row in rows" :key="row.type" class="count-row d2-row">
            <span class="count-label">{{ row.label }}</span>
            <el-tag size="small" type="info" effect="plain">{{ row.count }}</el-tag>
          </li>
        </ul>
      </el-scrollbar>
      <div class="panel-total">
        <span>Total</span>
        <b class="d2-num">{{ totalObjects }}</b>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Root = left rail; .d2-rail/.d2-rail--left own the bg + single hairline seam. */
.object-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-size: 12px;
}
.panel-header {
  padding: 10px 12px 6px;
  font-weight: 600;
  font-size: 13px;
}
.panel-empty {
  padding: 16px 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.panel-scroll {
  flex: 1;
}
.count-list {
  margin: 0;
  padding: 4px 2px;
  list-style: none;
}
/* .d2-row owns hover wash + radius */
.count-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  font-size: 12px;
}
.count-label {
  color: var(--el-text-color-regular);
}
.panel-total {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.panel-total b {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
</style>
