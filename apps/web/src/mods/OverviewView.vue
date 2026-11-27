<script setup lang="ts">
/**
 * The front page of a comparison: a tile per section with its counts, the races a mod
 * rebuilt, the terrain art it added, and the tables and columns only one mod has.
 */
import { computed } from "vue";
import { SECTIONS, type PictureChange } from "@d2/mod-diff";
import { tr, trn, intlLocale } from "../i18n";
import { useCompareStore } from "./compareStore";
import { navLabel, RACE_PARTS, TERRAIN_CODES, type NavId } from "./labels";
import { capitalLayersChanged, overviewRaces, ownChanged } from "./raceRows";
import CountChips from "./CountChips.vue";
import PicturePair from "./PicturePair.vue";

const store = useCompareStore();
const d = computed(() => store.diff!);
const num = (n: number) => n.toLocaleString(intlLocale());

interface Tile {
  id: NavId;
  total: number;
  added: number;
  changed: number;
  removed: number;
  artOnly: number;
  viaShared: number;
  note?: string;
}

const tiles = computed<Tile[]>(() => {
  const s = d.value.summary;
  const out: Tile[] = [];
  for (const id of SECTIONS) {
    const c = s.sections[id];
    if (id === "races") {
      const rc = d.value.races;
      out.push({
        id,
        total: s.races.changed.length,
        added: rc.filter((r) => r.presence === "onlyB").length,
        removed: rc.filter((r) => r.presence === "onlyA").length,
        changed: rc.filter((r) => r.presence === "both" && s.races.changed.includes(r.id)).length,
        artOnly: 0,
        viaShared: 0,
        note: s.races.redesigned.length ? trn("{n} переделана|{n} переделаны|{n} переделано", s.races.redesigned.length) : undefined,
      });
      continue;
    }
    out.push({ id, total: c.total, added: c.added, changed: c.changed, removed: c.removed, artOnly: c.artOnly, viaShared: c.viaShared });
  }
  out.push({ id: "terrain", total: s.terrain.changed.length, added: 0, changed: s.terrain.changed.length, removed: 0, artOnly: 0, viaShared: 0, note: s.terrain.changed.join(" ") || undefined });
  const p = s.pictures;
  out.push({
    id: "graphics",
    total: d.value.pictures.changes.length,
    added: p.frames.added + p.animations.added + p.icons.added,
    changed: p.frames.changed + p.animations.changed + p.icons.changed,
    removed: p.frames.removed + p.animations.removed + p.icons.removed,
    artOnly: 0,
    viaShared: 0,
  });
  out.push({ id: "scripts", total: d.value.scripts.length, added: s.scripts.added, changed: s.scripts.changed, removed: s.scripts.removed, artOnly: 0, viaShared: 0 });
  out.push({
    id: "tables",
    total: s.tables.differ,
    added: s.tables.add,
    changed: s.tables.set,
    removed: s.tables.delete,
    artOnly: 0,
    viaShared: 0,
    note: tr("правок строк: {n}", { n: num(s.tables.ops) }),
  });
  return out;
});

const raceCapitalChanged = capitalLayersChanged;
const changedMembers = ownChanged;
const races = computed(() => overviewRaces(d.value.races, d.value.summary.races.changed));
const anyRedesigned = computed(() => d.value.races.some((r) => r.redesign.redesigned));

const terrains = computed(() =>
  d.value.terrain
    .filter((t) => d.value.summary.terrain.changed.includes(t.code))
    .map((t) => {
      const all: PictureChange[] = [...t.pictures.forests, ...t.pictures.mountains, ...t.pictures.ground, ...t.pictures.borders];
      return {
        t,
        added: all.filter((p) => p.change === "added").length,
        changed: all.filter((p) => p.change === "changed").length,
        removed: all.filter((p) => p.change === "removed").length,
        sample: all.filter((p) => p.change !== "removed").slice(0, 6),
      };
    }),
);

const schemaChanges = computed(() =>
  d.value.tables.filter((t) => t.presence === "both" && (t.schema.added.length || t.schema.removed.length || t.schema.changed.length)),
);
const noTables = computed(() => store.tablesMissing.a || store.tablesMissing.b);
const nothing = computed(() => d.value.summary.tables.ops === 0 && d.value.pictures.changes.length === 0 && d.value.scripts.length === 0);
</script>

<template>
  <div class="overview">
    <h1 class="title">
      {{ d.a.name }} → {{ d.b.name }}
    </h1>
    <p class="lead dim">
      <template v-if="!noTables">{{ tr("Правок строк: {ops}", { ops: num(d.summary.tables.ops) }) }} · {{ tr("различаются таблицы: {differ} из {compared}", { differ: d.summary.tables.differ, compared: d.summary.tables.compared }) }} · </template>
      {{ tr("картинки: {pics}", { pics: num(d.pictures.changes.length) }) }} · {{ tr("скрипты: {scripts}", { scripts: d.scripts.length }) }}
      <span v-if="store.result" class="ms">· {{ tr("посчитано за {ms} мс", { ms: store.result.ms }) }}</span>
    </p>

    <el-empty v-if="nothing" :description="tr('Моды не различаются: таблицы, картинки и скрипты совпадают.')" />

    <div class="tiles">
      <a v-for="t in tiles" :key="t.id" href="#" class="tile" :class="{ zero: !t.total }" @click.prevent="store.openView(t.id)">
        <div class="tile-head">
          <span class="tile-name">{{ navLabel(t.id) }}</span>
          <span class="tile-total">{{ num(t.total) }}</span>
        </div>
        <CountChips :added="t.added" :changed="t.changed" :removed="t.removed" :art-only="t.artOnly" :via-shared="t.viaShared" />
        <div v-if="t.note" class="tile-note dim">{{ t.note }}</div>
      </a>
    </div>

    <div v-if="races.length" class="mods-block">
      <h2 class="mods-section-title">
        {{ anyRedesigned ? tr("Переделанные расы") : tr("Изменения рас") }}
        <span v-if="!anyRedesigned" class="dim">{{ tr("ни одна раса не переделана целиком") }}</span>
      </h2>
      <div class="race-rows">
        <a v-for="r in races" :key="r.id" href="#" class="race-row" @click.prevent="store.openCard({ kind: 'race', id: r.id })">
          <div class="race-name">
            <b>{{ r.nameB ?? r.nameA }}</b>
            <span v-if="r.nameA && r.nameB && r.nameA !== r.nameB" class="dim"> ({{ r.nameA }})</span>
            <el-tag v-if="r.redesign.redesigned" type="danger" size="small" effect="dark" disable-transitions>{{ tr("переделана") }}</el-tag>
          </div>
          <div class="race-score" :title="tr('Насколько раса новая')">
            <el-progress :percentage="Math.round(r.redesign.score * 100)" :stroke-width="10" :color="r.redesign.redesigned ? 'var(--el-color-danger)' : 'var(--el-color-warning)'" />
          </div>
          <div class="race-parts">
            <span v-for="g in [{ label: RACE_PARTS.units, m: r.units }, { label: RACE_PARTS.buildings, m: r.buildings }]" :key="g.label">
              {{ g.label }}: {{ g.m.countA }} → <b>{{ g.m.countB }}</b>
              <span v-if="g.m.added.length" class="st-added chip">+{{ g.m.added.length }}</span>
              <span v-if="g.m.removed.length" class="st-removed chip">−{{ g.m.removed.length }}</span>
              <span v-if="changedMembers(g.m)" class="st-changed chip">~{{ changedMembers(g.m) }}</span>
            </span>
            <span v-if="raceCapitalChanged(r)">{{ RACE_PARTS.capital }}: {{ trn("{n} слой|{n} слоя|{n} слоёв", raceCapitalChanged(r)) }}</span>
            <span v-if="r.pictures.length">{{ tr("Картинки") }}: <b>{{ r.pictures.length }}</b></span>
          </div>
        </a>
      </div>
    </div>

    <div v-if="terrains.length" class="mods-block">
      <h2 class="mods-section-title">{{ tr("Ландшафт") }}</h2>
      <div class="terrain-rows">
        <div v-for="x in terrains" :key="x.t.code" class="terrain-row">
          <a href="#" class="terrain-name" @click.prevent="store.openView('terrain')">
            <b>{{ TERRAIN_CODES[x.t.code] ?? x.t.code }}</b> <span class="mono dim">{{ x.t.code }}</span>
          </a>
          <div class="terrain-counts">
            <span>{{ tr("Леса") }}: {{ x.t.counts.forestsA }} → <b>{{ x.t.counts.forestsB }}</b></span>
            <span v-if="x.t.counts.mountainsA || x.t.counts.mountainsB">{{ tr("Горы") }}: {{ x.t.counts.mountainsA }} → <b>{{ x.t.counts.mountainsB }}</b></span>
            <CountChips :added="x.added" :changed="x.changed" :removed="x.removed" />
            <span v-if="x.t.tiles.length" class="dim">{{ trn("GTileDBI: {n} строка|GTileDBI: {n} строки|GTileDBI: {n} строк", x.t.tiles.length) }}</span>
          </div>
          <div class="terrain-sample">
            <PicturePair v-for="p in x.sample" :key="p.name" :change="p" :size="52" :show-name="false" />
          </div>
        </div>
      </div>
    </div>

    <div v-if="d.summary.tables.onlyA.length || d.summary.tables.onlyB.length || schemaChanges.length" class="mods-block">
      <h2 class="mods-section-title">{{ tr("Таблицы и колонки") }}</h2>
      <div v-if="d.summary.tables.onlyA.length" class="only">
        <span class="dim">{{ tr("Только в A ({mod}):", { mod: d.a.name }) }}</span>
        <a v-for="t in d.summary.tables.onlyA" :key="t" href="#" class="mono st-removed chip" @click.prevent="store.openView('tables'); store.openItem(t)">{{ t }}</a>
      </div>
      <div v-if="d.summary.tables.onlyB.length" class="only">
        <span class="dim">{{ tr("Только в B ({mod}):", { mod: d.b.name }) }}</span>
        <a v-for="t in d.summary.tables.onlyB" :key="t" href="#" class="mono st-added chip" @click.prevent="store.openView('tables'); store.openItem(t)">{{ t }}</a>
      </div>
      <el-table v-if="schemaChanges.length" :data="schemaChanges" size="small" class="schema">
        <el-table-column :label="tr('Таблица')" width="150">
          <template #default="{ row }"><a href="#" class="mono" @click.prevent="store.openView('tables'); store.openItem(row.name)">{{ row.name }}</a></template>
        </el-table-column>
        <el-table-column :label="tr('Новые колонки (B)')">
          <template #default="{ row }"><span v-for="c in row.schema.added" :key="c.name" class="mono st-added chip">{{ c.name }}</span></template>
        </el-table-column>
        <el-table-column :label="tr('Убранные колонки (A)')">
          <template #default="{ row }"><span v-for="c in row.schema.removed" :key="c.name" class="mono st-removed chip">{{ c.name }}</span></template>
        </el-table-column>
        <el-table-column :label="tr('Другой тип или ширина')">
          <template #default="{ row }">
            <span v-for="c in row.schema.changed" :key="c.name" class="mono st-changed chip">{{ c.name }} {{ c.from.type }}{{ c.from.length }} → {{ c.to.type }}{{ c.to.length }}</span>
          </template>
        </el-table-column>
      </el-table>
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
  margin: 0 0 14px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--d2-radius-lg);
  background: var(--el-bg-color);
  border: var(--d2-hairline);
  color: inherit;
  text-decoration: none;
  transition: border-color 0.15s;
}
.tile:hover {
  border-color: var(--el-color-primary-light-5);
}
.tile.zero {
  opacity: 0.55;
}
.tile-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.tile-name {
  font-weight: 600;
}
.tile-total {
  font-size: 22px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.tile-note {
  font-size: 12px;
}
.chip {
  font-size: 12px;
  line-height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  margin-right: 4px;
  white-space: nowrap;
  text-decoration: none;
  display: inline-block;
  margin-bottom: 2px;
}
.race-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.race-row {
  display: grid;
  grid-template-columns: minmax(200px, 1.1fr) 220px 2fr;
  gap: 14px;
  align-items: center;
  padding: 8px 10px;
  border-radius: var(--d2-radius);
  color: inherit;
  text-decoration: none;
}
.race-row:hover {
  background: var(--el-fill-color-light);
}
.race-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.race-parts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
}
.terrain-rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.terrain-row {
  display: grid;
  grid-template-columns: 170px 1fr;
  gap: 6px 14px;
  align-items: start;
}
.terrain-name {
  color: inherit;
  text-decoration: none;
}
.terrain-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  align-items: center;
}
.terrain-sample {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.only {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  margin-bottom: 8px;
}
.schema {
  margin-top: 6px;
}
@media (max-width: 760px) {
  .tiles {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }
  .tile {
    padding: 10px 12px;
  }
  .tile-total {
    font-size: 19px;
  }
  .race-row,
  .terrain-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
  .terrain-sample {
    grid-column: 1;
  }
}
</style>
