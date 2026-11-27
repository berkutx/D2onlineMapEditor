<script setup lang="ts">
/**
 * The changed entities of one section: filters by status, race and category, a search by
 * name or id, and a paged table. A row opens the entity's card.
 */
import { computed, ref, watch } from "vue";
import { linkOf, type EntityChange, type EntityStatus, type SectionId } from "@d2/mod-diff";
import { tr } from "../i18n";
import { useCompareStore } from "./compareStore";
import { lookupLabel, navLabel, STATUS_LABEL, STATUSES } from "./labels";
import StatusTag from "./StatusTag.vue";
import ModIcon from "./ModIcon.vue";

const props = defineProps<{ section: SectionId }>();
const store = useCompareStore();

/** The group value a section is filtered by as "category", with its root column. */
const CATEGORY: Partial<Record<SectionId, { key: string; table: string; column: string; label: string }>> = {
  units: { key: "category", table: "Gunits", column: "UNIT_CAT", label: tr("Категория") },
  attacks: { key: "class", table: "Gattacks", column: "CLASS", label: tr("Класс") },
  items: { key: "category", table: "GItem", column: "ITEM_CAT", label: tr("Категория") },
  spells: { key: "category", table: "Gspells", column: "CATEGORY", label: tr("Категория") },
  buildings: { key: "category", table: "Gbuild", column: "CATEGORY", label: tr("Категория") },
  lords: { key: "category", table: "Glord", column: "CATEGORY", label: tr("Тип") },
  modifiers: { key: "source", table: "Gmodif", column: "SOURCE", label: tr("Носитель") },
  landmarks: { key: "category", table: "GLmark", column: "CATEGORY", label: tr("Категория") },
};
const RACE_SECTIONS: ReadonlySet<SectionId> = new Set(["units", "lords", "leaderUpgrades", "buildings"]);
const HAS_ICONS: ReadonlySet<SectionId> = new Set(["units", "items", "spells", "lords"]);

const all = computed<EntityChange[]>(() => store.diff?.sections[props.section] ?? []);
const search = ref("");
const statuses = ref<EntityStatus[]>([]);
const race = ref<string>("");
const category = ref<string>("");
const page = ref(1);
const pageSize = ref(50);
const sort = ref<{ prop: string; order: "ascending" | "descending" | null }>({ prop: "", order: null });

const raceNames = computed(() => new Map((store.diff?.races ?? []).map((r) => [r.id, r.nameB ?? r.nameA ?? r.id])));

function racesOf(e: EntityChange): string[] {
  const g = e.group.races;
  if (Array.isArray(g)) return g;
  const r = e.group.race;
  return typeof r === "string" && r ? [r] : [];
}

function categoryOf(e: EntityChange): string | null {
  const c = CATEGORY[props.section];
  if (!c) return null;
  const v = e.group[c.key];
  if (v === null || v === undefined || Array.isArray(v)) return null;
  return String(v);
}
function categoryText(e: EntityChange): string {
  const c = CATEGORY[props.section];
  const v = categoryOf(e);
  if (!c || v === null) return "";
  const shown = e.groupText[c.key];
  const link = linkOf(c.table, c.column);
  if (shown && link?.target.kind === "lookup") return lookupLabel(link.target.table, shown);
  return shown ?? v;
}

const statusCounts = computed(() => {
  const out: Record<string, number> = {};
  for (const e of all.value) out[e.status] = (out[e.status] ?? 0) + 1;
  return out;
});
const raceOptions = computed(() => {
  if (!RACE_SECTIONS.has(props.section)) return [];
  const seen = new Map<string, number>();
  for (const e of all.value) for (const r of racesOf(e)) seen.set(r, (seen.get(r) ?? 0) + 1);
  return [...seen.entries()].map(([id, n]) => ({ id, n, name: raceNames.value.get(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name));
});
const categoryOptions = computed(() => {
  const seen = new Map<string, { text: string; n: number }>();
  for (const e of all.value) {
    const v = categoryOf(e);
    if (v === null) continue;
    const s = seen.get(v);
    if (s) s.n++;
    else seen.set(v, { text: categoryText(e), n: 1 });
  }
  return [...seen.entries()].map(([value, s]) => ({ value, ...s })).sort((a, b) => a.text.localeCompare(b.text));
});

function nameOf(e: EntityChange): string {
  return e.nameB ?? e.nameA ?? "";
}
function changeCount(e: EntityChange): number {
  return e.fields.length + e.owned.length + e.lists.length + e.texts.length + e.scripts.length + e.children.length;
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  const st = new Set(statuses.value);
  let rows = all.value.filter((e) => {
    if (st.size && !st.has(e.status)) return false;
    if (race.value && !racesOf(e).includes(race.value)) return false;
    if (category.value && categoryOf(e) !== category.value) return false;
    if (q && !e.id.toLowerCase().includes(q) && !(e.nameA ?? "").toLowerCase().includes(q) && !(e.nameB ?? "").toLowerCase().includes(q)) return false;
    return true;
  });
  const { prop, order } = sort.value;
  if (prop && order) {
    const dir = order === "ascending" ? 1 : -1;
    const key = (e: EntityChange): string | number =>
      prop === "name" ? nameOf(e).toLowerCase() : prop === "status" ? STATUSES.indexOf(e.status) : prop === "changes" ? changeCount(e) : e.id;
    rows = [...rows].sort((x, y) => {
      const a = key(x);
      const b = key(y);
      return (a < b ? -1 : a > b ? 1 : 0) * dir;
    });
  }
  return rows;
});
const pageRows = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch([search, statuses, race, category, pageSize], () => (page.value = 1));

function onSort(s: { prop: string; order: "ascending" | "descending" | null }): void {
  sort.value = { prop: s.prop, order: s.order };
}
function open(e: EntityChange): void {
  store.openCard({ kind: "entity", uid: e.uid });
}
const showIcons = HAS_ICONS.has(props.section);
const noTables = computed(() => store.tablesMissing.a || store.tablesMissing.b);
</script>

<template>
  <div class="entity-list">
    <div class="head">
      <h1 class="title">{{ navLabel(section) }}</h1>
      <span class="dim">{{ tr("{shown} из {total}", { shown: filtered.length, total: all.length }) }}</span>
    </div>

    <el-empty v-if="noTables" :description="tr('Таблицы одного из модов не выложены на сервер — этот раздел сравнить нельзя.')" />
    <el-empty v-else-if="!all.length" :description="tr('В этом разделе моды не различаются.')" />

    <template v-else>
      <div class="mods-toolbar">
        <el-input v-model="search" :placeholder="tr('Имя или id')" clearable class="search" />
        <el-checkbox-group v-model="statuses" size="small">
          <el-checkbox-button v-for="s in STATUSES.filter((x) => statusCounts[x])" :key="s" :value="s">
            <span :class="`dot dot-${s}`" />{{ STATUS_LABEL[s] }} <span class="dim">{{ statusCounts[s] }}</span>
          </el-checkbox-button>
        </el-checkbox-group>
        <el-select v-if="raceOptions.length" v-model="race" :placeholder="tr('Раса')" clearable class="sel">
          <el-option v-for="r in raceOptions" :key="r.id" :value="r.id" :label="`${r.name} (${r.n})`" />
        </el-select>
        <el-select v-if="categoryOptions.length > 1" v-model="category" :placeholder="CATEGORY[section]?.label" clearable class="sel">
          <el-option v-for="c in categoryOptions" :key="c.value" :value="c.value" :label="`${c.text} (${c.n})`" />
        </el-select>
      </div>

      <el-table :data="pageRows" size="small" row-key="uid" class="table" highlight-current-row @row-click="open" @sort-change="onSort">
        <el-table-column v-if="showIcons" width="84" label="A | B">
          <template #default="{ row }">
            <span class="icons">
              <ModIcon :url="row.status === 'added' ? null : store.iconUrl('a', section, row.id)" :size="30" />
              <ModIcon :url="row.status === 'removed' ? null : store.iconUrl('b', section, row.id)" :size="30" />
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="name" :label="tr('Название')" sortable="custom" min-width="260">
          <template #default="{ row }">
            <span class="name">
              <template v-if="row.nameA && row.nameB && row.nameA !== row.nameB">
                <span class="dim">{{ row.nameA }}</span> → <b>{{ row.nameB }}</b>
              </template>
              <b v-else>{{ row.nameB ?? row.nameA ?? "—" }}</b>
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="id" label="Id" sortable="custom" width="190">
          <template #default="{ row }"><span class="mono">{{ row.id }}</span></template>
        </el-table-column>
        <el-table-column prop="status" :label="tr('Статус')" sortable="custom" width="140">
          <template #default="{ row }"><StatusTag :status="row.status" /></template>
        </el-table-column>
        <el-table-column prop="changes" :label="tr('Изменений')" sortable="custom" width="120" align="right">
          <template #default="{ row }">
            <span v-if="row.status === 'changed'" class="count">{{ changeCount(row) || "" }}</span>
            <span v-if="row.shared.length" class="extra st-shared" :title="tr('Изменились общие строки')">↪{{ row.shared.length }}</span>
            <span v-if="row.pictures.length" class="extra st-art" :title="tr('Изменились картинки')">◩{{ row.pictures.length }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="CATEGORY[section] || raceOptions.length" :label="tr('Группа')" min-width="180">
          <template #default="{ row }">
            <span class="dim">{{ [racesOf(row).map((r) => raceNames.get(r) ?? r).join(", "), categoryText(row)].filter(Boolean).join(" · ") }}</span>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-if="filtered.length > 25"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="filtered.length"
        :page-sizes="[25, 50, 100, 200]"
        layout="total, sizes, prev, pager, next"
        class="pager"
        size="small"
      />
    </template>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}
.title {
  font-size: 20px;
  font-weight: 650;
  margin: 2px 0 0;
}
.search {
  width: 240px;
}
.sel {
  width: 220px;
}
.table :deep(.el-table__row) {
  cursor: pointer;
}
.icons {
  display: inline-flex;
  gap: 4px;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.count {
  font-variant-numeric: tabular-nums;
}
.extra {
  font-size: 11px;
  padding: 0 5px;
  margin-left: 4px;
  border-radius: 8px;
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 5px;
}
.dot-added {
  background: var(--el-color-success);
}
.dot-changed {
  background: var(--el-color-warning);
}
.dot-removed {
  background: var(--el-color-danger);
}
.dot-art-only {
  background: var(--el-color-primary);
}
.dot-via-shared {
  background: var(--el-color-info);
}
.pager {
  margin-top: 10px;
}
</style>
