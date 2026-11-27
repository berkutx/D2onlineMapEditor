<script setup lang="ts">
/**
 * Every table as it is: rows and ops per table, column changes; the open table lists its
 * ops (key, field, A, B; added and removed rows). This shows everything, also what no
 * entity covers (L*, AI, GVars, Gunits_2).
 */
import { computed, ref, watch } from "vue";
import type { TableChange, TableOp } from "@d2/mod-diff";
import { tr, intlLocale } from "../i18n";
import { useCompareStore } from "./compareStore";
import { keyText, labelOf, plain, rowLine } from "./display";
import EntityLink from "./EntityLink.vue";

const store = useCompareStore();
const onlyDiffering = ref(true);
const search = ref("");
const tab = ref<"set" | "add" | "delete" | "skipped">("set");
const page = ref(1);
const pageSize = ref(100);
const opSearch = ref("");

const all = computed(() => store.diff?.tables ?? []);
const list = computed(() => {
  const q = search.value.trim().toLowerCase();
  return all.value.filter(
    (t) =>
      (!onlyDiffering.value || t.ops.length || t.presence !== "both" || hasSchema(t) || t.skipped.length) &&
      (!q || t.name.toLowerCase().includes(q)),
  );
});
const current = computed<TableChange | null>(() => {
  const name = store.item?.toLowerCase();
  return name ? (all.value.find((t) => t.name.toLowerCase() === name) ?? null) : null;
});

function hasSchema(t: TableChange): boolean {
  return t.presence === "both" && !!(t.schema.added.length || t.schema.removed.length || t.schema.changed.length);
}

type SetOp = Extract<TableOp, { op: "dbf.set" }>;
type AddOp = Extract<TableOp, { op: "dbf.add" }>;
type DelOp = Extract<TableOp, { op: "dbf.delete" }>;

const ops = computed(() => {
  const t = current.value;
  const q = opSearch.value.trim().toLowerCase();
  const match = (o: TableOp) => !q || o.keyText.toLowerCase().includes(q) || (o.op === "dbf.set" && o.field.toLowerCase().includes(q));
  const sets: SetOp[] = [];
  const adds: AddOp[] = [];
  const dels: DelOp[] = [];
  for (const o of t?.ops ?? []) {
    if (!match(o)) continue;
    if (o.op === "dbf.set") sets.push(o);
    else if (o.op === "dbf.add") adds.push(o);
    else dels.push(o);
  }
  return { set: sets, add: adds, delete: dels };
});
const tabRows = computed<unknown[]>(() => {
  if (tab.value === "skipped") return current.value?.skipped ?? [];
  return ops.value[tab.value];
});
const pageRows = computed(() => tabRows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch([current, tab, opSearch, pageSize], () => (page.value = 1));
watch(current, (t) => {
  if (!t) return;
  // open on the first tab that has something
  const c = t.counts;
  tab.value = c.set ? "set" : c.add ? "add" : c.delete ? "delete" : t.skipped.length ? "skipped" : "set";
});

const num = (n: number | null) => (n === null ? "—" : n.toLocaleString(intlLocale()));
function open(t: TableChange): void {
  store.openItem(t.name);
}
const rowClass = ({ row }: { row: TableChange }) => (row.name === current.value?.name ? "is-open" : "");
const presenceText = (t: TableChange) => (t.presence === "onlyA" ? tr("только A") : t.presence === "onlyB" ? tr("только B") : "");
const setRow = (o: unknown) => o as SetOp;
const addRow = (o: unknown) => o as AddOp;
const delRow = (o: unknown) => o as DelOp;
const skipRow = (o: unknown) => o as TableChange["skipped"][number];
</script>

<template>
  <div>
    <h1 class="title">{{ tr("Таблицы") }}</h1>
    <div class="split">
      <div class="mods-block list">
        <div class="mods-toolbar">
          <el-input v-model="search" :placeholder="tr('Таблица')" clearable size="small" class="search" />
          <el-switch v-model="onlyDiffering" size="small" :active-text="tr('только различающиеся')" />
        </div>
        <el-table :data="list" size="small" :row-class-name="rowClass" @row-click="open" class="tlist">
          <el-table-column :label="tr('Таблица')" min-width="120">
            <template #default="{ row }">
              <span class="mono">{{ row.name }}</span>
              <span v-if="row.presence !== 'both'" class="tiny" :class="row.presence === 'onlyA' ? 'st-removed' : 'st-added'">{{ presenceText(row) }}</span>
              <span v-if="hasSchema(row)" class="tiny st-changed" :title="tr('Колонки различаются')">{{ tr("колонки") }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="tr('Строк A → B')" width="104" align="right">
            <template #default="{ row }"><span class="num">{{ num(row.rowsA) }} → {{ num(row.rowsB) }}</span></template>
          </el-table-column>
          <el-table-column :label="tr('Правки')" width="150" align="right">
            <template #default="{ row }">
              <span v-if="row.counts.set" class="tiny st-changed">~{{ row.counts.set }}</span>
              <span v-if="row.counts.add" class="tiny st-added">+{{ row.counts.add }}</span>
              <span v-if="row.counts.delete" class="tiny st-removed">−{{ row.counts.delete }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div class="mods-block detail">
        <div v-if="!current" class="dim pick">{{ tr("Выберите таблицу слева.") }}</div>
        <template v-else>
          <h2 class="mods-section-title">
            <span class="mono">{{ current.name }}</span>
            <span class="dim">{{ current.coverage === "entities" ? tr("правки разложены по сущностям") : tr("таблица без сущностей: правки только здесь") }}</span>
          </h2>
          <div class="facts">
            <span>{{ tr("Строк") }}: {{ num(current.rowsA) }} → {{ num(current.rowsB) }}</span>
            <span v-if="current.keyColumns.length">{{ tr("Ключ") }}: <span class="mono">{{ current.key?.kind === "row" ? tr("вся строка") : current.keyColumns.join(" + ") }}</span></span>
            <span v-if="current.key?.kind === 'only'">{{ tr("Ключ") }}: {{ tr("одна строка") }}</span>
          </div>
          <el-alert v-if="current.presence !== 'both'" type="info" :closable="false" class="note" :title="current.presence === 'onlyA' ? tr('Таблица есть только в A ({mod}); построчно не сравнивается.', { mod: store.modA?.name ?? '' }) : tr('Таблица есть только в B ({mod}); построчно не сравнивается.', { mod: store.modB?.name ?? '' })" />
          <el-alert v-if="current.error" type="error" :closable="false" class="note" :title="current.error" />
          <p v-if="current.note" class="dim note">{{ current.note }}</p>
          <p v-if="current.projected" class="dim note">{{ tr("Сравнивается по общим колонкам: {cols}", { cols: current.projected.join(", ") }) }}</p>

          <div v-if="hasSchema(current)" class="schema">
            <span v-for="c in current.schema.added" :key="`+${c.name}`" class="mono tiny st-added">+{{ c.name }} {{ c.type }}{{ c.length }}</span>
            <span v-for="c in current.schema.removed" :key="`-${c.name}`" class="mono tiny st-removed">−{{ c.name }} {{ c.type }}{{ c.length }}</span>
            <span v-for="c in current.schema.changed" :key="`~${c.name}`" class="mono tiny st-changed">{{ c.name }} {{ c.from.type }}{{ c.from.length }} → {{ c.to.type }}{{ c.to.length }}</span>
          </div>

          <template v-if="current.presence === 'both'">
            <div class="mods-toolbar">
              <el-radio-group v-model="tab" size="small">
                <el-radio-button value="set">{{ tr("Изменённые ячейки") }} ({{ ops.set.length }})</el-radio-button>
                <el-radio-button value="add">{{ tr("Новые строки") }} ({{ ops.add.length }})</el-radio-button>
                <el-radio-button value="delete">{{ tr("Удалённые строки") }} ({{ ops.delete.length }})</el-radio-button>
                <el-radio-button v-if="current.skipped.length" value="skipped">{{ tr("Не перенесено") }} ({{ current.skipped.length }})</el-radio-button>
              </el-radio-group>
              <el-input v-model="opSearch" :placeholder="tr('Ключ или колонка')" clearable size="small" class="search" />
            </div>

            <el-table v-if="tab === 'set'" :data="pageRows" size="small" class="ops">
              <el-table-column v-if="current.key?.kind !== 'only'" :label="tr('Ключ')" min-width="150">
                <template #default="{ row }"><span class="mono">{{ keyText(setRow(row).key) }}</span></template>
              </el-table-column>
              <el-table-column :label="tr('Колонка')" min-width="220">
                <template #default="{ row }">
                  <span>{{ labelOf(current!.name, setRow(row).field) }}</span>
                  <span v-if="labelOf(current!.name, setRow(row).field) !== setRow(row).field" class="mono dim col">{{ setRow(row).field }}</span>
                </template>
              </el-table-column>
              <el-table-column :label="tr('Было (A)')" min-width="150">
                <template #default="{ row }">
                  <span class="was">{{ setRow(row).wasText ?? plain(setRow(row).was) }}</span>
                  <span v-if="setRow(row).wasText" class="mono dim col">{{ plain(setRow(row).was) }}</span>
                </template>
              </el-table-column>
              <el-table-column :label="tr('Стало (B)')" min-width="150">
                <template #default="{ row }">
                  <span class="now">{{ setRow(row).valueText ?? plain(setRow(row).value) }}</span>
                  <span v-if="setRow(row).valueText" class="mono dim col">{{ plain(setRow(row).value) }}</span>
                </template>
              </el-table-column>
              <el-table-column v-if="current.coverage === 'entities'" :label="tr('Чьё')" min-width="150">
                <template #default="{ row }">
                  <span v-for="o in setRow(row).owners" :key="`${o.section}:${o.id}`" class="owner">
                    <EntityLink v-if="o.section !== 'terrain'" :section="o.section" :id="o.id" :name="store.entity(o.section, o.id)?.nameB ?? store.entity(o.section, o.id)?.nameA" />
                    <span v-else class="mono">{{ o.id }}</span>
                  </span>
                </template>
              </el-table-column>
            </el-table>

            <el-table v-else-if="tab === 'add' || tab === 'delete'" :data="pageRows" size="small" class="ops">
              <el-table-column :label="tr('Ключ')" width="200">
                <template #default="{ row }"><span class="mono">{{ keyText((row as AddOp | DelOp).key) }}</span></template>
              </el-table-column>
              <el-table-column :label="tab === 'add' ? tr('Строка в B') : tr('Строка в A')">
                <template #default="{ row }"><span class="mono line" :class="tab === 'add' ? 'now' : 'was'">{{ tab === "add" ? rowLine(addRow(row).values) : rowLine(delRow(row).was) }}</span></template>
              </el-table-column>
              <el-table-column v-if="current.coverage === 'entities'" :label="tr('Чьё')" width="200">
                <template #default="{ row }">
                  <span v-for="o in (row as AddOp | DelOp).owners" :key="`${o.section}:${o.id}`" class="owner">
                    <EntityLink v-if="o.section !== 'terrain'" :section="o.section" :id="o.id" :name="store.entity(o.section, o.id)?.nameB ?? store.entity(o.section, o.id)?.nameA" />
                    <span v-else class="mono">{{ o.id }}</span>
                  </span>
                </template>
              </el-table-column>
            </el-table>

            <el-table v-else :data="pageRows" size="small" class="ops">
              <el-table-column :label="tr('Ключ')" width="200">
                <template #default="{ row }"><span class="mono">{{ keyText(skipRow(row).key) }}</span></template>
              </el-table-column>
              <el-table-column :label="tr('Колонка')" width="140">
                <template #default="{ row }"><span class="mono">{{ skipRow(row).field }}</span></template>
              </el-table-column>
              <el-table-column :label="tr('Почему')">
                <template #default="{ row }">{{ skipRow(row).reason }}: {{ plain(skipRow(row).a) }} → {{ plain(skipRow(row).b) }}</template>
              </el-table-column>
            </el-table>

            <el-pagination
              v-if="tabRows.length > pageSize"
              v-model:current-page="page"
              v-model:page-size="pageSize"
              :total="tabRows.length"
              :page-sizes="[50, 100, 200, 500]"
              layout="total, sizes, prev, pager, next"
              size="small"
              class="pager"
            />
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.title {
  font-size: 20px;
  font-weight: 650;
  margin: 2px 0 10px;
}
.split {
  display: grid;
  grid-template-columns: minmax(380px, 430px) 1fr;
  gap: 12px;
  align-items: start;
}
.list {
  position: sticky;
  top: 0;
}
.tlist {
  max-height: calc(100vh - 190px);
  overflow: auto;
}
.tlist :deep(.el-table__row) {
  cursor: pointer;
}
.tlist :deep(.is-open) td {
  background: var(--d2-active-bg) !important;
}
.search {
  width: 200px;
}
.detail {
  min-width: 0;
}
.detail .mods-section-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
}
.pick {
  padding: 20px;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin-bottom: 8px;
}
.note {
  margin: 6px 0;
}
.schema {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 10px;
}
.tiny {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
  margin-left: 4px;
  white-space: nowrap;
}
.num {
  font-variant-numeric: tabular-nums;
}
.col {
  font-size: 11px;
  margin-left: 6px;
}
.was {
  color: var(--el-color-danger);
}
.now {
  color: var(--el-color-success);
}
html.dark .was {
  color: #f89898;
}
html.dark .now {
  color: #95d475;
}
.line {
  font-size: 12px;
  word-break: break-all;
}
.owner {
  margin-right: 8px;
}
.pager {
  margin-top: 10px;
}
</style>
