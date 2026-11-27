<script setup lang="ts">
/**
 * A race, A | B: its Grace slots with unit icons, the units, buildings and lords it gained,
 * lost or changed, its capital screen layers, its pictures and how much of it is new.
 */
import { computed, ref } from "vue";
import { Back, Close } from "@element-plus/icons-vue";
import type { EntityRef, RaceMembers, SlotChange } from "@d2/mod-diff";
import { tr, trn } from "../i18n";
import { useCompareStore } from "./compareStore";
import { cellLink, labelOf } from "./display";
import { RACE_PARTS, STATUS_LABEL, TERRAIN_CODES, lookupLabel } from "./labels";
import StatusTag from "./StatusTag.vue";
import ModIcon from "./ModIcon.vue";
import EntityLink from "./EntityLink.vue";
import PicturePair from "./PicturePair.vue";
import OwnedRows from "./OwnedRows.vue";
import ListRows from "./ListRows.vue";
import CellView from "./CellView.vue";

const props = defineProps<{ raceId: string }>();
const store = useCompareStore();
const r = computed(() => store.index.races.get(props.raceId)!);
const raceEntity = computed(() => store.entity("races", r.value.id));

const name = computed(() => r.value.nameB ?? r.value.nameA ?? r.value.id);

function slotLabel(slot: string): string {
  return labelOf("Grace", slot);
}
function slotUnit(s: SlotChange, side: "a" | "b") {
  const v = side === "a" ? s.a : s.b;
  return cellLink("Grace", s.slot, v);
}

const groups = computed(() => [
  { id: "units", label: RACE_PARTS.units!, m: r.value.units },
  { id: "buildings", label: RACE_PARTS.buildings!, m: r.value.buildings },
  { id: "lords", label: tr("Лорды"), m: r.value.lords },
]);
const SHOWN = 30;
const expanded = ref<Record<string, boolean>>({});
function cut<T extends EntityRef>(list: T[], key: string): T[] {
  return expanded.value[key] ? list : list.slice(0, SHOWN);
}
function changedOwn(m: RaceMembers) {
  return m.changed.filter((x) => x.status !== "via-shared");
}

const capital = computed(() => r.value.capital);
const capitalBuildings = computed(() => (capital.value?.buildings ?? []).filter((b) => b.build));
const capitalLoose = computed(() => (capital.value?.buildings ?? []).find((b) => !b.build));

const PICS = 36;
const allPics = ref(false);
/** The parts of "how new the race is", each with the counts behind its share. */
const parts = computed(() => {
  const x = r.value;
  const fresh = (m: RaceMembers) => tr("новых {n} из {total}", { n: m.added.length - m.copies.length, total: m.countB });
  const list = [
    { key: "units", label: RACE_PARTS.units!, text: fresh(x.units), share: x.redesign.parts.units },
    { key: "buildings", label: RACE_PARTS.buildings!, text: fresh(x.buildings), share: x.redesign.parts.buildings },
  ];
  if (x.capital) {
    const n = x.capital.layers.filter((l) => l.change !== "removed").length;
    list.push({ key: "capital", label: RACE_PARTS.capital!, text: tr("новых или изменённых слоёв {n} из {total}", { n, total: x.capital.layersB }), share: x.redesign.parts.capital });
  }
  list.push({ key: "slots", label: RACE_PARTS.slots!, text: tr("изменено {n} из {total}", { n: x.slots.filter((s) => s.changed).length, total: x.slots.length }), share: x.redesign.parts.slots });
  return list;
});
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div class="head-actions">
        <el-button v-if="store.history.length" :icon="Back" size="small" text @click="store.back()">{{ tr("Назад") }}</el-button>
        <span class="spacer" />
        <el-button :icon="Close" size="small" text circle :title="tr('Закрыть')" @click="store.closeCard()" />
      </div>
      <h2 class="title">
        <template v-if="r.nameA && r.nameB && r.nameA !== r.nameB"><span class="dim">{{ r.nameA }}</span> → {{ r.nameB }}</template>
        <template v-else>{{ name }}</template>
      </h2>
      <div class="meta">
        <el-tag v-if="r.redesign.redesigned" type="danger" effect="dark" disable-transitions>{{ tr("переделана") }}</el-tag>
        <StatusTag :status="r.status" size="default" />
        <el-tag v-if="r.presence !== 'both'" :type="r.presence === 'onlyB' ? 'success' : 'danger'" disable-transitions>
          {{ r.presence === "onlyB" ? STATUS_LABEL.added : STATUS_LABEL.removed }}
        </el-tag>
        <span>{{ tr("Раса") }}</span>
        <span v-if="r.lrace" :title="r.lrace">{{ lookupLabel("Lrace", r.lrace) }}</span>
        <span v-if="r.code" class="dim" :title="TERRAIN_CODES[r.code] ?? r.code">{{ tr("земля") }} <span class="mono">{{ r.code }}</span></span>
        <span class="mono dim">{{ r.id }}</span>
        <a v-if="raceEntity" href="#" @click.prevent="store.openCard({ kind: 'entity', uid: raceEntity.uid })">{{ tr("Строки расы →") }}</a>
      </div>
    </div>

    <div class="card-body">
      <section class="block">
        <h3 class="block-title">{{ tr("Насколько раса новая") }}</h3>
        <div class="score">
          <el-progress :percentage="Math.round(r.redesign.score * 100)" :stroke-width="12" :color="r.redesign.redesigned ? 'var(--el-color-danger)' : 'var(--el-color-warning)'" class="score-bar" />
          <div class="parts">
            <span v-for="p in parts" :key="p.key">{{ p.label }}: {{ p.text }} <b>{{ Math.round(p.share * 100) }}%</b></span>
          </div>
          <div class="dim score-note">
            {{ tr("Доля нового в расе мода B: то, чего у этой расы в A нет. Убранное из A новым не считается. Юнит под новым id, но с картинкой юнита из A, тоже не считается новым.") }}
          </div>
          <div v-if="r.units.copies.length" class="copies">
            <span class="dim">{{ tr("Новый id, картинка из A:") }}</span>
            <span v-for="c in r.units.copies" :key="c.id" class="copy">
              <EntityLink :section="c.section" :id="c.id" :name="c.name" /> ← <EntityLink :section="c.of.section" :id="c.of.id" :name="c.of.name" />
            </span>
          </div>
        </div>
      </section>

      <section class="block">
        <h3 class="block-title">{{ tr("Слоты расы") }} <span class="mono dim">Grace</span></h3>
        <table class="slots">
          <thead>
            <tr>
              <th />
              <th><span class="side-label">A</span> {{ store.modA?.name }}</th>
              <th><span class="side-label">B</span> {{ store.modB?.name }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in r.slots" :key="s.slot" :class="{ changed: s.changed }">
              <th>{{ slotLabel(s.slot) }} <span class="mono col">{{ s.slot }}</span></th>
              <td v-for="side in ['a', 'b'] as const" :key="side">
                <span class="slot-cell">
                  <ModIcon v-if="slotUnit(s, side)?.section === 'units'" :url="store.iconUrl(side, 'units', slotUnit(s, side)!.id)" :size="28" />
                  <CellView table="Grace" :column="s.slot" :value="side === 'a' ? s.a : s.b" :side="side" :text="side === 'a' ? s.aText : s.bText" />
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-for="g in groups" :key="g.id" class="block">
        <h3 class="block-title">
          {{ g.label }}
          <span class="dim">{{ g.m.countA }} → {{ g.m.countB }}</span>
        </h3>
        <div v-if="!g.m.added.length && !g.m.removed.length && !changedOwn(g.m).length" class="dim">{{ tr("Без изменений") }}</div>
        <div v-if="g.m.added.length" class="members">
          <span class="mtitle st-added">+{{ g.m.added.length }}</span>
          <span v-for="x in cut(g.m.added, g.id + '+')" :key="x.id" class="member">
            <ModIcon v-if="g.id === 'units' || g.id === 'lords'" :url="store.iconUrl('b', x.section, x.id)" :size="24" />
            <EntityLink :section="x.section" :id="x.id" :name="x.name" />
          </span>
          <el-button v-if="g.m.added.length > SHOWN && !expanded[g.id + '+']" text size="small" @click="expanded[g.id + '+'] = true">{{ tr("Показать все") }}</el-button>
        </div>
        <div v-if="g.m.removed.length" class="members">
          <span class="mtitle st-removed">−{{ g.m.removed.length }}</span>
          <span v-for="x in cut(g.m.removed, g.id + '-')" :key="x.id" class="member">
            <ModIcon v-if="g.id === 'units' || g.id === 'lords'" :url="store.iconUrl('a', x.section, x.id)" :size="24" />
            <EntityLink :section="x.section" :id="x.id" :name="x.name" />
          </span>
          <el-button v-if="g.m.removed.length > SHOWN && !expanded[g.id + '-']" text size="small" @click="expanded[g.id + '-'] = true">{{ tr("Показать все") }}</el-button>
        </div>
        <div v-if="changedOwn(g.m).length" class="members">
          <span class="mtitle st-changed">~{{ changedOwn(g.m).length }}</span>
          <span v-for="x in cut(changedOwn(g.m), g.id + '~')" :key="x.id" class="member">
            <EntityLink :section="x.section" :id="x.id" :name="x.name" />
            <span v-if="x.status === 'art-only'" class="st-art tiny">{{ STATUS_LABEL["art-only"] }}</span>
          </span>
          <el-button v-if="changedOwn(g.m).length > SHOWN && !expanded[g.id + '~']" text size="small" @click="expanded[g.id + '~'] = true">{{ tr("Показать все") }}</el-button>
        </div>
      </section>

      <section v-if="capital" class="block">
        <h3 class="block-title">
          {{ tr("Экран столицы") }} <span class="mono dim">capital.dat [{{ capital.name }}]</span>
          <span class="dim">{{ trn("{n} слой|{n} слоя|{n} слоёв", capital.layersA) }} → {{ capital.layersB }}</span>
        </h3>
        <div v-if="!capital.layers.length" class="dim">{{ tr("Слои не менялись") }}</div>
        <table v-else class="slots">
          <thead>
            <tr>
              <th>{{ tr("Постройка") }}</th>
              <th>{{ tr("Слои") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in expanded.cap ? capitalBuildings : capitalBuildings.slice(0, SHOWN)" :key="b.build">
              <th><EntityLink section="buildings" :id="b.build" :name="b.nameB ?? b.nameA" /></th>
              <td>
                <span v-if="b.added" class="st-added tiny">+{{ b.added }}</span>
                <span v-if="b.removed" class="st-removed tiny">−{{ b.removed }}</span>
                <span v-if="b.changed" class="st-changed tiny">~{{ b.changed }}</span>
                <span class="mono dim pics">{{ [...new Set(b.layers.map((l) => l.picture))].slice(0, 6).join(", ") }}</span>
              </td>
            </tr>
            <tr v-if="capitalLoose">
              <th class="dim">{{ tr("Фон и анимации без постройки") }}</th>
              <td>
                <span v-if="capitalLoose.added" class="st-added tiny">+{{ capitalLoose.added }}</span>
                <span v-if="capitalLoose.removed" class="st-removed tiny">−{{ capitalLoose.removed }}</span>
                <span v-if="capitalLoose.changed" class="st-changed tiny">~{{ capitalLoose.changed }}</span>
                <span class="mono dim pics">{{ [...new Set(capitalLoose.layers.map((l) => l.picture))].slice(0, 6).join(", ") }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <el-button v-if="capitalBuildings.length > SHOWN && !expanded.cap" text size="small" @click="expanded.cap = true">{{ tr("Показать все ({n})", { n: capitalBuildings.length }) }}</el-button>
        <div v-if="capital.infoAdded.length || capital.infoRemoved.length" class="sub">
          <span class="dim">LAYERINFO:</span>
          <span v-for="b in capital.infoAdded" :key="`+${b}`" class="st-added tiny">+<EntityLink section="buildings" :id="b" /></span>
          <span v-for="b in capital.infoRemoved" :key="`-${b}`" class="st-removed tiny">−<EntityLink section="buildings" :id="b" /></span>
        </div>
      </section>

      <section v-if="r.owned.length" class="block">
        <h3 class="block-title">{{ tr("Связанные строки") }}</h3>
        <OwnedRows :rows="r.owned" :owner-id="r.id" />
      </section>
      <section v-if="r.lists.length" class="block">
        <h3 class="block-title">{{ tr("Списки") }}</h3>
        <ListRows :lists="r.lists" />
      </section>

      <section v-if="r.pictures.length" class="block">
        <h3 class="block-title">{{ tr("Картинки расы") }} <span class="dim">({{ r.pictures.length }})</span></h3>
        <div class="mods-gallery dense">
          <PicturePair v-for="p in allPics ? r.pictures : r.pictures.slice(0, PICS)" :key="`${p.kind}:${p.name}:${p.change}`" :change="p" :size="60" />
        </div>
        <el-button v-if="r.pictures.length > PICS && !allPics" text size="small" @click="allPics = true">{{ tr("Показать все ({n})", { n: r.pictures.length }) }}</el-button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.card-head {
  padding: 10px 18px 12px;
  border-bottom: var(--d2-hairline);
  background: var(--el-bg-color);
}
.head-actions {
  display: flex;
  align-items: center;
  min-height: 24px;
}
.spacer {
  flex: 1;
}
.title {
  font-size: 19px;
  font-weight: 650;
  margin: 0 0 6px;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}
.card-body {
  padding: 12px 18px 30px;
  overflow: auto;
  flex: 1;
}
.block {
  margin-bottom: 18px;
}
.dense {
  grid-auto-flow: row dense;
}
.block-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 8px;
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.score {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.score-bar {
  max-width: 420px;
}
.parts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
}
.score-note {
  font-size: 12px;
  max-width: 720px;
}
.copies {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 13px;
}
.slots {
  width: 100%;
  border-collapse: collapse;
}
.slots th,
.slots td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: var(--d2-hairline);
  vertical-align: middle;
}
.slots th {
  font-weight: 500;
  width: 30%;
}
.slots thead th {
  color: var(--el-text-color-secondary);
}
.slots tr.changed td {
  background: var(--el-color-warning-light-9);
}
.col {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-left: 4px;
}
.slot-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.members {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  align-items: center;
  margin-bottom: 8px;
}
.mtitle {
  font-weight: 600;
  padding: 0 7px;
  border-radius: 9px;
}
.member {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.tiny {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
  margin-right: 4px;
}
.pics {
  font-size: 11px;
  margin-left: 6px;
}
.sub {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
</style>
