<script setup lang="ts">
/**
 * One entity, «было | стало»: its pictures in A and B, every changed field with a label,
 * texts, owned rows and lists, the shared rows it uses that changed, and where it is used.
 * Linked entities open their own card (the drawer keeps a back step).
 */
import { computed, ref } from "vue";
import { Back, Close } from "@element-plus/icons-vue";
import type { FieldChange, PictureChange } from "@d2/mod-diff";
import { tr, trn } from "../i18n";
import { useCompareStore } from "./compareStore";
import { fieldText, isWorded, labelOf, plain } from "./display";
import { navLabel, CHANGE_LABEL } from "./labels";
import { unitFigure } from "./pictures";
import StatusTag from "./StatusTag.vue";
import ModIcon from "./ModIcon.vue";
import SpriteCrop from "./SpriteCrop.vue";
import PicturePair from "./PicturePair.vue";
import EntityLink from "./EntityLink.vue";
import CellView from "./CellView.vue";
import OwnedRows from "./OwnedRows.vue";
import ListRows from "./ListRows.vue";

const props = defineProps<{ uid: string }>();
const store = useCompareStore();
const e = computed(() => store.index.byUid.get(props.uid)!);
const exA = computed(() => store.extras("a"));
const exB = computed(() => store.extras("b"));

const name = computed(() => e.value.nameB ?? e.value.nameA ?? e.value.id);
const renamed = computed(() => !!e.value.nameA && !!e.value.nameB && e.value.nameA !== e.value.nameB);

const iconA = computed(() => (e.value.rowA ? store.iconUrl("a", e.value.section, e.value.id) : null));
const iconB = computed(() => (e.value.rowB ? store.iconUrl("b", e.value.section, e.value.id) : null));
const figureA = computed(() => (e.value.section === "units" && e.value.rowA ? unitFigure(store.side("a")?.manifest, e.value.id) : null));
const figureB = computed(() => (e.value.section === "units" && e.value.rowB ? unitFigure(store.side("b")?.manifest, e.value.id) : null));
const hasIcons = computed(() => ["units", "items", "spells", "lords"].includes(e.value.section));

const PICS_SHOWN = 24;
const allPics = ref(false);
const pictures = computed<PictureChange[]>(() => (allPics.value ? e.value.pictures : e.value.pictures.slice(0, PICS_SHOWN)));

// «все поля»: every column of the root row, the changed ones marked
const allFields = ref(false);
const changedSet = computed(() => new Set(e.value.fields.map((f) => f.field)));
const allRows = computed(() => {
  const keys = new Set<string>([...Object.keys(e.value.rowA ?? {}), ...Object.keys(e.value.rowB ?? {})]);
  return [...keys];
});
/** An added or removed entity shows its one row. */
const soleSide = computed<"a" | "b" | null>(() => (e.value.status === "added" ? "b" : e.value.status === "removed" ? "a" : null));
const soleRow = computed(() => (soleSide.value === "a" ? e.value.rowA : soleSide.value === "b" ? e.value.rowB : undefined));
const soleKeys = computed(() => Object.keys(soleRow.value ?? {}).filter((k) => soleRow.value![k] !== null && soleRow.value![k] !== ""));

function fieldA(f: FieldChange): string {
  return fieldText(f, "a", exA.value);
}
function fieldB(f: FieldChange): string {
  return fieldText(f, "b", exB.value);
}
function rawOf(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}
function numDelta(f: FieldChange): string {
  // a number that names something (a lookup id, a link) has no meaningful difference
  if (isWorded(f.table, f.field, f.a) || isWorded(f.table, f.field, f.b)) return "";
  if (typeof f.a === "number" && typeof f.b === "number") {
    const d = f.b - f.a;
    return d > 0 ? `+${d}` : String(d);
  }
  return "";
}

function viaLabel(via: string): string {
  const [table = "", column = ""] = via.split(".");
  return labelOf(table, column);
}

const usedGroups = computed(() => {
  const by = new Map<string, typeof e.value.usedBy>();
  for (const u of e.value.usedBy) {
    const list = by.get(u.via);
    if (list) list.push(u);
    else by.set(u.via, [u]);
  }
  return [...by.entries()].map(([via, list]) => ({ via, list }));
});
const USED_SHOWN = 40;
const allUsed = ref(false);

function openScript(path: string): void {
  store.closeCard();
  store.openView("scripts");
  store.openItem(path);
}
const opsCount = computed(() => e.value.ops.length);
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div class="head-actions">
        <el-button v-if="store.history.length" :icon="Back" size="small" text @click="store.back()">{{ tr("Назад") }}</el-button>
        <span class="spacer" />
        <el-button :icon="Close" size="small" text circle :title="tr('Закрыть')" @click="store.closeCard()" />
      </div>
      <div class="title-row">
        <div v-if="hasIcons" class="head-icons">
          <ModIcon :url="iconA" :size="48" :title="store.modA?.name" />
          <ModIcon :url="iconB" :size="48" :title="store.modB?.name" />
        </div>
        <div class="title-text">
          <h2 class="title">
            <template v-if="renamed"><span class="dim">{{ e.nameA }}</span> → {{ e.nameB }}</template>
            <template v-else>{{ name }}</template>
          </h2>
          <div class="meta">
            <StatusTag :status="e.status" size="default" />
            <span>{{ navLabel(e.section) }}</span>
            <span class="mono dim">{{ e.table }} · {{ e.id }}</span>
            <span v-if="e.orphan" class="dim">{{ tr("строки без основной записи") }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card-body">
      <!-- pictures -->
      <section v-if="hasIcons || figureA || figureB || e.pictures.length" class="block">
        <h3 class="block-title">{{ tr("Картинки") }}</h3>
        <div class="pics-ab">
          <div class="pic-col">
            <div class="col-head"><span class="side-label">A</span> {{ store.modA?.name }}</div>
            <div class="pic-row">
              <ModIcon v-if="hasIcons" :url="iconA" :size="72" />
              <SpriteCrop v-if="figureA || figureB" :pic="figureA" :size="96" />
            </div>
          </div>
          <div class="pic-col">
            <div class="col-head"><span class="side-label">B</span> {{ store.modB?.name }}</div>
            <div class="pic-row">
              <ModIcon v-if="hasIcons" :url="iconB" :size="72" />
              <SpriteCrop v-if="figureA || figureB" :pic="figureB" :size="96" />
            </div>
          </div>
        </div>
        <template v-if="e.pictures.length">
          <div class="sub dim">{{ trn("{n} картинка изменилась|{n} картинки изменились|{n} картинок изменилось", e.pictures.length) }}</div>
          <div class="mods-gallery dense">
            <PicturePair v-for="p in pictures" :key="`${p.kind}:${p.name}:${p.change}:${p.a?.layer?.z ?? ''}${p.b?.layer?.z ?? ''}`" :change="p" :size="60" />
          </div>
          <el-button v-if="e.pictures.length > PICS_SHOWN && !allPics" text size="small" @click="allPics = true">{{ tr("Показать все ({n})", { n: e.pictures.length }) }}</el-button>
        </template>
      </section>

      <!-- fields -->
      <section v-if="soleRow" class="block">
        <h3 class="block-title">{{ e.status === "added" ? tr("Запись в B") : tr("Запись в A") }}</h3>
        <table class="fields">
          <tbody>
            <tr v-for="k in soleKeys" :key="k">
              <th>{{ labelOf(e.table, k) }} <span class="mono col">{{ k }}</span></th>
              <td>
                <CellView :table="e.table" :column="k" :value="soleRow![k]" :side="soleSide!" :text="(soleSide === 'a' ? e.rowTextA : e.rowTextB)?.[k]" />
                <span v-if="isWorded(e.table, k, soleRow![k])" class="mono raw">{{ rawOf(soleRow![k]) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-else-if="e.fields.length || e.newColumns.length || e.rowA" class="block">
        <div class="block-head">
          <h3 class="block-title">{{ tr("Поля") }}</h3>
          <el-switch v-if="e.rowA && e.rowB" v-model="allFields" size="small" :active-text="tr('все поля')" />
        </div>
        <div v-if="!e.fields.length && !e.newColumns.length && !allFields" class="dim">{{ tr("Поля основной записи не менялись.") }}</div>
        <table v-else class="fields ab">
          <thead>
            <tr>
              <th />
              <th><span class="side-label">A</span> {{ store.modA?.name }}</th>
              <th><span class="side-label">B</span> {{ store.modB?.name }}</th>
            </tr>
          </thead>
          <tbody v-if="!allFields">
            <tr v-for="f in e.fields" :key="f.field" class="changed">
              <th>{{ labelOf(f.table, f.field) }} <span class="mono col">{{ f.field }}</span></th>
              <td>
                {{ fieldA(f) }}
                <span v-if="isWorded(f.table, f.field, f.a)" class="mono raw">{{ rawOf(f.a) }}</span>
              </td>
              <td>
                {{ fieldB(f) }}
                <span v-if="isWorded(f.table, f.field, f.b)" class="mono raw">{{ rawOf(f.b) }}</span>
                <span v-if="numDelta(f)" class="delta" :class="numDelta(f).startsWith('+') ? 'up' : 'down'">{{ numDelta(f) }}</span>
                <span v-if="f.uncarried" class="dim"> · {{ tr("не помещается в колонку A") }}</span>
              </td>
            </tr>
            <tr v-for="f in e.newColumns" :key="`new:${f.field}`" class="newcol">
              <th>{{ labelOf(f.table, f.field) }} <span class="mono col">{{ f.field }}</span> <span class="st-added tiny">{{ f.a === null ? tr("колонка только в B") : tr("колонка только в A") }}</span></th>
              <td>{{ f.a === null ? "" : fieldA(f) }}</td>
              <td>{{ f.b === null ? "" : fieldB(f) }}</td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr v-for="k in allRows" :key="k" :class="{ changed: changedSet.has(k) }">
              <th>{{ labelOf(e.table, k) }} <span class="mono col">{{ k }}</span></th>
              <td><CellView :table="e.table" :column="k" :value="e.rowA?.[k]" side="a" :text="e.rowTextA?.[k]" /></td>
              <td><CellView :table="e.table" :column="k" :value="e.rowB?.[k]" side="b" :text="e.rowTextB?.[k]" /></td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- texts -->
      <section v-if="e.texts.length" class="block">
        <h3 class="block-title">{{ tr("Тексты") }}</h3>
        <table class="fields ab">
          <tbody>
            <tr v-for="t in e.texts" :key="`${t.via}:${t.id}`" class="changed">
              <th>{{ viaLabel(t.via) }} <span class="mono col">{{ t.id }}</span></th>
              <td class="text">{{ t.a ?? "—" }}</td>
              <td class="text">{{ t.b ?? "—" }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- owned rows and lists -->
      <section v-if="e.owned.length" class="block">
        <h3 class="block-title">{{ tr("Связанные строки") }}</h3>
        <OwnedRows :rows="e.owned" :owner-id="e.id" />
      </section>
      <section v-if="e.lists.length" class="block">
        <h3 class="block-title">{{ tr("Списки") }}</h3>
        <ListRows :lists="e.lists" />
      </section>

      <!-- shared rows, children, scripts -->
      <section v-if="e.shared.length" class="block">
        <h3 class="block-title">{{ tr("Общие строки, которые изменились") }}</h3>
        <p class="sub dim">{{ tr("Эти записи использует не только эта сущность; их изменение видно у каждой.") }}</p>
        <div v-for="s in e.shared" :key="`${s.via}:${s.id}`" class="link-row">
          <span class="via">{{ viaLabel(s.via) }}</span>
          <EntityLink :section="s.section" :id="s.id" :name="s.name" show-id />
          <StatusTag :status="s.status" />
        </div>
      </section>
      <section v-if="e.children.length" class="block">
        <h3 class="block-title">{{ tr("Улучшения лидеров") }}</h3>
        <div v-for="s in e.children" :key="s.id" class="link-row">
          <EntityLink :section="s.section" :id="s.id" :name="s.name" show-id />
          <StatusTag :status="s.status" />
        </div>
      </section>
      <section v-if="e.scripts.length" class="block">
        <h3 class="block-title">{{ tr("Скрипт") }}</h3>
        <div v-for="s in e.scripts" :key="s.path" class="link-row">
          <a href="#" class="mono" @click.prevent="openScript(s.path)">{{ s.path }}</a>
          <el-tag size="small" :type="s.change === 'added' ? 'success' : s.change === 'removed' ? 'danger' : 'warning'" disable-transitions>{{ CHANGE_LABEL[s.change] }}</el-tag>
        </div>
      </section>

      <!-- used by -->
      <section v-if="e.usedBy.length" class="block">
        <h3 class="block-title">{{ tr("Используется в") }} <span class="dim">({{ e.usedBy.length }})</span></h3>
        <div v-for="g in usedGroups" :key="g.via" class="used-group">
          <div class="via">{{ viaLabel(g.via) }} <span class="mono dim">{{ g.via }}</span></div>
          <div class="used-list">
            <span v-for="u in allUsed ? g.list : g.list.slice(0, USED_SHOWN)" :key="`${u.section}:${u.id}:${u.side}`" class="used">
              <EntityLink v-if="u.section" :section="u.section" :id="u.id" :name="u.name" />
              <span v-else class="mono">{{ u.id }}</span>
              <span v-if="u.side !== 'both'" class="side-note" :class="u.side === 'a' ? 'st-removed' : 'st-added'">{{ u.side === "a" ? tr("только A") : tr("только B") }}</span>
            </span>
          </div>
        </div>
        <el-button v-if="!allUsed && usedGroups.some((g) => g.list.length > USED_SHOWN)" text size="small" @click="allUsed = true">{{ tr("Показать все") }}</el-button>
      </section>

      <p class="foot dim">{{ trn("{n} правка таблиц|{n} правки таблиц|{n} правок таблиц", opsCount) }} · {{ plain(e.uid) }}</p>
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
  position: sticky;
  top: 0;
  z-index: 2;
}
.head-actions {
  display: flex;
  align-items: center;
  min-height: 24px;
}
.spacer {
  flex: 1;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.head-icons {
  display: flex;
  gap: 6px;
}
.title {
  font-size: 19px;
  font-weight: 650;
  margin: 0 0 4px;
  word-break: break-word;
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
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.block-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 8px;
}
.sub {
  margin: 6px 0;
  font-size: 12px;
}
.pics-ab {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 8px;
}
.col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-weight: 500;
}
.pic-row {
  display: flex;
  gap: 10px;
  align-items: center;
}
.fields {
  width: 100%;
  border-collapse: collapse;
}
.fields th,
.fields td {
  text-align: left;
  padding: 5px 8px;
  border-bottom: var(--d2-hairline);
  vertical-align: top;
}
.fields th {
  font-weight: 500;
  width: 34%;
  color: var(--el-text-color-regular);
}
.fields.ab td {
  width: 33%;
}
.fields thead th {
  color: var(--el-text-color-secondary);
}
.fields tr.changed td {
  background: var(--el-color-warning-light-9);
}
.fields tr.newcol td {
  background: var(--el-fill-color-lighter);
}
.col {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-left: 4px;
}
.raw {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  margin-left: 6px;
}
.delta {
  font-size: 11px;
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
}
.delta.up {
  color: var(--el-color-success);
}
.delta.down {
  color: var(--el-color-danger);
}
.tiny {
  font-size: 10.5px;
  padding: 0 5px;
  border-radius: 8px;
  margin-left: 4px;
  font-weight: 400;
  white-space: nowrap;
}
.text {
  white-space: pre-wrap;
  word-break: break-word;
}
.link-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 4px 0;
}
.via {
  color: var(--el-text-color-secondary);
  min-width: 130px;
}
.used-group {
  margin-bottom: 8px;
}
.used-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 3px;
}
.used {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.side-note {
  font-size: 10.5px;
  padding: 0 5px;
  border-radius: 8px;
}
.foot {
  font-size: 11px;
  margin-top: 20px;
}
@media (max-width: 760px) {
  .card-head {
    padding: 8px 12px 10px;
  }
  .card-body {
    padding: 10px 12px 24px;
  }
  .title-row {
    align-items: flex-start;
  }
  .via {
    flex: 1 1 100%;
    min-width: 0;
  }
  .fields th,
  .fields td {
    padding: 4px 6px;
    word-break: break-word;
  }
}
</style>
