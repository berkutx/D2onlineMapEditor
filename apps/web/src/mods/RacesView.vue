<script setup lang="ts">
/** Every race of either mod with how much of it is new; subraces that changed below. */
import { computed } from "vue";
import { tr } from "../i18n";
import { useCompareStore } from "./compareStore";
import { RACE_PARTS, STATUS_LABEL, TERRAIN_CODES, lookupLabel } from "./labels";
import StatusTag from "./StatusTag.vue";
import CountChips from "./CountChips.vue";
import ModIcon from "./ModIcon.vue";

const store = useCompareStore();
const races = computed(() => store.diff?.races ?? []);
const subraces = computed(() => (store.diff?.sections.races ?? []).filter((e) => e.group.kind === "subrace"));
const noTables = computed(() => store.tablesMissing.a || store.tablesMissing.b);

function guardian(r: (typeof races.value)[number]): { side: "a" | "b"; id: string } | null {
  const s = r.slots.find((x) => x.slot === "GUARDIAN");
  const v = (s?.b ?? s?.a) as string | null | undefined;
  return v ? { side: s?.b ? "b" : "a", id: v } : null;
}
</script>

<template>
  <div>
    <h1 class="title">{{ tr("Расы") }}</h1>
    <p class="dim lead">{{ tr("В игре шесть рас; «новая раса» мода — это переделанный слот: свои юниты, постройки, лорды и экран столицы.") }}</p>
    <el-empty v-if="noTables" :description="tr('Таблицы одного из модов не выложены на сервер — расы сравнить нельзя.')" />
    <div v-else class="races">
      <a v-for="r in races" :key="r.id" href="#" class="race" :class="{ redesigned: r.redesign.redesigned }" @click.prevent="store.openCard({ kind: 'race', id: r.id })">
        <div class="race-head">
          <ModIcon v-if="guardian(r)" :url="store.iconUrl(guardian(r)!.side, 'units', guardian(r)!.id)" :size="40" :title="tr('Страж столицы')" />
          <div class="race-title">
            <b>{{ r.nameB ?? r.nameA }}</b>
            <div class="dim small">
              <span v-if="r.lrace">{{ lookupLabel("Lrace", r.lrace) }}</span>
              <span v-if="r.code" :title="TERRAIN_CODES[r.code] ?? r.code"> · {{ tr("земля") }} <span class="mono">{{ r.code }}</span></span>
            </div>
          </div>
          <span class="spacer" />
          <el-tag v-if="r.redesign.redesigned" type="danger" effect="dark" size="small" disable-transitions>{{ tr("переделана") }}</el-tag>
          <StatusTag :status="r.status" />
          <el-tag v-if="r.presence !== 'both'" size="small" :type="r.presence === 'onlyB' ? 'success' : 'danger'" disable-transitions>
            {{ r.presence === "onlyB" ? STATUS_LABEL.added : STATUS_LABEL.removed }}
          </el-tag>
        </div>
        <el-progress :percentage="Math.round(r.redesign.score * 100)" :stroke-width="8" :color="r.redesign.redesigned ? 'var(--el-color-danger)' : 'var(--el-color-warning)'" />
        <div class="race-rows">
          <div><span class="dim">{{ RACE_PARTS.units }}</span> {{ r.units.countA }} → {{ r.units.countB }} <CountChips :added="r.units.added.length" :removed="r.units.removed.length" :changed="r.units.changed.length" /></div>
          <div><span class="dim">{{ RACE_PARTS.buildings }}</span> {{ r.buildings.countA }} → {{ r.buildings.countB }} <CountChips :added="r.buildings.added.length" :removed="r.buildings.removed.length" :changed="r.buildings.changed.length" /></div>
          <div><span class="dim">{{ tr("Лорды") }}</span> {{ r.lords.countA }} → {{ r.lords.countB }} <CountChips :added="r.lords.added.length" :removed="r.lords.removed.length" :changed="r.lords.changed.length" /></div>
          <div>
            <span class="dim">{{ RACE_PARTS.capital }}</span>
            <template v-if="r.capital">{{ r.capital.layersA }} → {{ r.capital.layersB }} <CountChips :added="r.capital.layers.filter((l) => l.change === 'added').length" :removed="r.capital.layers.filter((l) => l.change === 'removed').length" :changed="r.capital.layers.filter((l) => l.change === 'changed').length" /></template>
            <span v-else class="dim">—</span>
          </div>
          <div><span class="dim">{{ RACE_PARTS.slots }}</span> {{ tr("изменено {n} из {total}", { n: r.slots.filter((s) => s.changed).length, total: r.slots.length }) }}</div>
          <div v-if="r.pictures.length"><span class="dim">{{ tr("Картинки") }}</span> {{ r.pictures.length }}</div>
        </div>
      </a>
    </div>

    <div v-if="subraces.length" class="mods-block subraces">
      <h2 class="mods-section-title">{{ tr("Подрасы") }}</h2>
      <a v-for="e in subraces" :key="e.uid" href="#" class="sub-row" @click.prevent="store.openCard({ kind: 'entity', uid: e.uid })">
        <b>{{ e.nameB ?? e.nameA ?? e.id }}</b> <span class="mono dim">{{ e.id }}</span> <StatusTag :status="e.status" />
      </a>
    </div>
  </div>
</template>

<style scoped>
.title {
  font-size: 20px;
  font-weight: 650;
  margin: 2px 0 4px;
}
.lead {
  margin: 0 0 12px;
}
.races {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(380px, 100%), 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.race {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: var(--d2-radius-lg);
  background: var(--el-bg-color);
  border: var(--d2-hairline);
  color: inherit;
  text-decoration: none;
}
.race:hover {
  border-color: var(--el-color-primary-light-5);
}
.race.redesigned {
  border-color: var(--el-color-danger-light-5);
}
.race-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.race-title b {
  font-size: 15px;
}
.small {
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.race-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.race-rows > div {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.race-rows .dim {
  min-width: 110px;
}
.sub-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 4px;
  color: inherit;
  text-decoration: none;
}
.sub-row:hover {
  background: var(--el-fill-color-light);
}
@media (max-width: 760px) {
  .race {
    padding: 12px;
  }
  .race-head,
  .sub-row {
    flex-wrap: wrap;
    gap: 6px 10px;
  }
}
</style>
