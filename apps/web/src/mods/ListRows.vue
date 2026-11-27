<script setup lang="ts">
/** Whole-row lists of an entity (GmodifL effects, GUmodif, Tleader, TAiMsg): A's list | B's list. */
import { computed, ref } from "vue";
import { normId, type ListChange, type Row } from "@d2/mod-diff";
import { tr, trn } from "../i18n";
import { labelOf } from "./display";
import CellView from "./CellView.vue";

const props = defineProps<{ lists: ListChange[] }>();

const TITLES: Record<string, string> = {
  gmodifl: tr("Эффекты модификатора"),
  gumodif: tr("Модификаторы юнита"),
  tleader: tr("Имена лидеров"),
  taimsg: tr("Сообщения ИИ"),
};

/** A long list shows its differing rows only, until asked for all. */
const LONG = 12;
const showAll = ref<Record<number, boolean>>({});

const view = computed(() =>
  props.lists.map((l) => {
    const removed = new Set(l.removed.map((r) => JSON.stringify(r)));
    const added = new Set(l.added.map((r) => JSON.stringify(r)));
    const cells = (r: Row) => Object.keys(r).filter((k) => k !== l.ownerColumn && r[k] !== null && r[k] !== "" && !(typeof r[k] === "string" && normId(r[k]) === normId(l.owner) && k === l.ownerColumn));
    // one row on each side (a GUmodif row of MODIF_n columns): mark the cells, not the rows
    const single = l.a.length === 1 && l.b.length === 1 ? { a: l.a[0]!, b: l.b[0]! } : null;
    const cellDiffers = (k: string) => !!single && String(single.a[k] ?? "") !== String(single.b[k] ?? "");
    return {
      l,
      title: TITLES[l.table.toLowerCase()] ?? l.table,
      cellDiffers,
      a: l.a.map((r) => ({ r, cells: cells(r), mark: !single && removed.has(JSON.stringify(r)) })),
      b: l.b.map((r) => ({ r, cells: cells(r), mark: !single && added.has(JSON.stringify(r)) })),
      long: !single && Math.max(l.a.length, l.b.length) > LONG && l.added.length + l.removed.length > 0,
    };
  }),
);
</script>

<template>
  <div class="lists">
    <div v-for="(v, i) in view" :key="i" class="list">
      <h3 class="group-title">{{ v.title }} <span class="mono dim">{{ v.l.table }}</span></h3>
      <div class="cols">
        <div class="col">
          <div class="col-head"><span class="side-label">A</span> <span class="dim">{{ trn("{n} строка|{n} строки|{n} строк", v.a.length) }}</span></div>
          <div v-if="!v.a.length" class="dim empty">{{ tr("пусто") }}</div>
          <div v-for="(x, k) in v.long && !showAll[i] ? v.a.filter((y) => y.mark) : v.a" :key="k" class="row" :class="{ removed: x.mark }">
            <span v-for="c in x.cells" :key="c" class="cell" :class="{ 'st-removed': v.cellDiffers(c) }"><span class="dim">{{ labelOf(v.l.table, c) }}:</span> <CellView :table="v.l.table" :column="c" :value="x.r[c]" side="a" /></span>
          </div>
        </div>
        <div class="col">
          <div class="col-head"><span class="side-label">B</span> <span class="dim">{{ trn("{n} строка|{n} строки|{n} строк", v.b.length) }}</span></div>
          <div v-if="!v.b.length" class="dim empty">{{ tr("пусто") }}</div>
          <div v-for="(x, k) in v.long && !showAll[i] ? v.b.filter((y) => y.mark) : v.b" :key="k" class="row" :class="{ added: x.mark }">
            <span v-for="c in x.cells" :key="c" class="cell" :class="{ 'st-added': v.cellDiffers(c) }"><span class="dim">{{ labelOf(v.l.table, c) }}:</span> <CellView :table="v.l.table" :column="c" :value="x.r[c]" side="b" /></span>
          </div>
        </div>
      </div>
      <el-button v-if="v.long && !showAll[i]" text size="small" @click="showAll[i] = true">
        {{ tr("Показаны только различающиеся строки. Показать все ({n})", { n: Math.max(v.a.length, v.b.length) }) }}
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.list {
  margin-bottom: 12px;
}
.group-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 6px;
}
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.col-head {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  padding: 5px 8px;
  border-radius: var(--d2-radius);
  border: var(--d2-hairline);
  margin-bottom: 4px;
  font-size: 12.5px;
}
.row.removed {
  background: var(--el-color-danger-light-9);
  border-color: var(--el-color-danger-light-5);
}
.row.added {
  background: var(--el-color-success-light-9);
  border-color: var(--el-color-success-light-5);
}
.cell.st-added,
.cell.st-removed {
  border-radius: 4px;
  padding: 0 4px;
}
.empty {
  padding: 4px 8px;
}
</style>
