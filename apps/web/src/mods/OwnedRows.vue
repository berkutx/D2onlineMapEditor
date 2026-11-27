<script setup lang="ts">
/**
 * Owned rows of an entity that changed (Gimmu, GimmuC, GLabi, Gtransf, GbuiList, ...), by
 * table: the row's key in words, then A's and B's cells. For Gimmu / GimmuC that reads as
 * "source (class) | A | B", the immunity view.
 */
import { computed } from "vue";
import { normId, type RowChange } from "@d2/mod-diff";
import { tr } from "../i18n";
import { useCompareStore } from "./compareStore";
import { labelOf } from "./display";
import { CHANGE_LABEL } from "./labels";
import CellView from "./CellView.vue";

const props = defineProps<{ rows: RowChange[]; ownerId?: string }>();
const store = useCompareStore();

const TITLES: Record<string, string> = {
  gimmu: tr("Иммунитеты и стойкость: источники атак"),
  gimmuc: tr("Иммунитеты и стойкость: классы атак"),
  glabi: tr("Способности лидера"),
  gmabi: tr("Передвижение"),
  gtransf: tr("Превращения и призывы"),
  gbuilist: tr("Постройки лорда"),
  gspellr: tr("Исследование заклинаний"),
  gcityinf: tr("Города расы"),
  tplayer: tr("Игроки"),
  gtiledbi: tr("Варианты тайлов"),
};

const groups = computed(() => {
  const by = new Map<string, RowChange[]>();
  for (const r of props.rows) {
    const list = by.get(r.table);
    if (list) list.push(r);
    else by.set(r.table, [r]);
  }
  return [...by.entries()].map(([table, rows]) => {
    const keyColumns = store.index.tables.get(table.toLowerCase())?.keyColumns ?? [];
    const owner = props.ownerId ? normId(props.ownerId) : null;
    const shownKeys = keyColumns.filter((c) => {
      const v = rows[0]?.rowA?.[c] ?? rows[0]?.rowB?.[c];
      return !(owner && typeof v === "string" && normId(v) === owner);
    });
    return { table, rows, keyColumns, shownKeys, title: TITLES[table.toLowerCase()] ?? table };
  });
});

function restCells(row: RowChange, side: "a" | "b", keyColumns: string[]): string[] {
  const r = side === "a" ? row.rowA : row.rowB;
  if (!r) return [];
  if (row.change === "changed") return row.fields.map((f) => f.field);
  return Object.keys(r).filter((k) => !keyColumns.includes(k) && r[k] !== null && r[k] !== "");
}
function keyValue(row: RowChange, col: string) {
  return row.rowB?.[col] ?? row.rowA?.[col] ?? null;
}
const tagType = (c: string) => (c === "added" ? "success" : c === "removed" ? "danger" : "warning");
</script>

<template>
  <div class="owned">
    <div v-for="g in groups" :key="g.table" class="group">
      <h3 class="group-title">{{ g.title }} <span class="mono dim">{{ g.table }}</span></h3>
      <table class="kv">
        <thead>
          <tr>
            <th>{{ g.shownKeys.map((k) => labelOf(g.table, k)).join(" · ") || tr("Строка") }}</th>
            <th class="tag-col" />
            <th><span class="side-label">A</span></th>
            <th><span class="side-label">B</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in g.rows" :key="row.keyText" :class="`ch-${row.change}`">
            <td>
              <template v-for="(k, i) in g.shownKeys" :key="k">
                <span v-if="i" class="dim"> · </span>
                <CellView :table="g.table" :column="k" :value="keyValue(row, k)" :side="row.rowB ? 'b' : 'a'" />
              </template>
            </td>
            <td class="tag-col"><el-tag :type="tagType(row.change)" size="small" disable-transitions>{{ CHANGE_LABEL[row.change] }}</el-tag></td>
            <td>
              <div v-for="c in restCells(row, 'a', g.keyColumns)" :key="c" class="cellrow">
                <span v-if="restCells(row, 'a', g.keyColumns).length > 1 || row.change === 'changed'" class="dim">{{ labelOf(g.table, c) }}: </span>
                <CellView :table="g.table" :column="c" :value="row.rowA?.[c]" side="a" />
              </div>
              <span v-if="!row.rowA" class="dim">—</span>
            </td>
            <td>
              <div v-for="c in restCells(row, 'b', g.keyColumns)" :key="c" class="cellrow">
                <span v-if="restCells(row, 'b', g.keyColumns).length > 1 || row.change === 'changed'" class="dim">{{ labelOf(g.table, c) }}: </span>
                <CellView :table="g.table" :column="c" :value="row.rowB?.[c]" side="b" />
              </div>
              <span v-if="!row.rowB" class="dim">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.group {
  margin-bottom: 12px;
}
.group-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 6px;
}
.kv {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.kv th {
  text-align: left;
  font-weight: 500;
  color: var(--el-text-color-secondary);
  padding: 4px 8px;
  border-bottom: var(--d2-hairline);
}
.kv td {
  padding: 5px 8px;
  border-bottom: var(--d2-hairline);
  vertical-align: top;
}
.tag-col {
  width: 96px;
}
tr.ch-added td:nth-child(4) {
  background: var(--el-color-success-light-9);
}
tr.ch-removed td:nth-child(3) {
  background: var(--el-color-danger-light-9);
}
tr.ch-changed td:nth-child(3),
tr.ch-changed td:nth-child(4) {
  background: var(--el-color-warning-light-9);
}
</style>
