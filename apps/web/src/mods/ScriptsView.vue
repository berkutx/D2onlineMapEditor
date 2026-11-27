<script setup lang="ts">
/** The modscripts files that differ; the open one is shown A | B with line numbers. */
import { computed, ref, watch } from "vue";
import type { Change, ScriptChange } from "@d2/mod-diff";
import { tr } from "../i18n";
import { useCompareStore } from "./compareStore";
import { CHANGE_LABEL } from "./labels";
import { scriptRows, scriptText, type SideRow } from "./scriptText";
import EntityLink from "./EntityLink.vue";

const store = useCompareStore();
const search = ref("");
const changes = ref<Change[]>(["added", "changed", "removed"]);
const all = computed(() => store.diff?.scripts ?? []);
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return all.value.filter((s) => changes.value.includes(s.change) && (!q || s.path.toLowerCase().includes(q)));
});
const current = computed<ScriptChange | null>(() => all.value.find((s) => s.path === store.item) ?? null);

const rows = ref<SideRow[]>([]);
const loading = ref(false);
const failed = ref<string | null>(null);
const context = ref(3);
let ticket = 0;

async function textOf(side: "a" | "b", s: ScriptChange): Promise<string> {
  const sha = side === "a" ? s.a : s.b;
  if (!sha) return "";
  const url = store.fileOf(side, s.path);
  if (!url) return "";
  return scriptText(sha, url);
}

watch(
  [current, context],
  async ([s]) => {
    const mine = ++ticket;
    rows.value = [];
    failed.value = null;
    if (!s) return;
    loading.value = true;
    try {
      const [a, b] = await Promise.all([textOf("a", s), textOf("b", s)]);
      if (mine !== ticket) return;
      rows.value = scriptRows(a, b, context.value);
    } catch (e) {
      if (mine === ticket) failed.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === ticket) loading.value = false;
    }
  },
  { immediate: true },
);

const short = (path: string) => path.replace(/^modscripts\//, "");
const tagType = (c: Change) => (c === "added" ? "success" : c === "removed" ? "danger" : "warning");
const stats = computed(() => ({
  removed: rows.value.filter((r) => r.kind === "removed" || r.kind === "changed").length,
  added: rows.value.filter((r) => r.kind === "added" || r.kind === "changed").length,
}));
</script>

<template>
  <div class="scripts">
    <h1 class="title">{{ tr("Скрипты") }}</h1>
    <el-empty v-if="!all.length" :description="tr('Скрипты modscripts у модов одинаковы.')" />
    <div v-else class="split">
      <div class="list mods-block">
        <div class="mods-toolbar">
          <el-input v-model="search" :placeholder="tr('Путь файла')" clearable size="small" />
          <el-checkbox-group v-model="changes" size="small">
            <el-checkbox-button value="added">{{ CHANGE_LABEL.added }}</el-checkbox-button>
            <el-checkbox-button value="changed">{{ CHANGE_LABEL.changed }}</el-checkbox-button>
            <el-checkbox-button value="removed">{{ CHANGE_LABEL.removed }}</el-checkbox-button>
          </el-checkbox-group>
        </div>
        <div class="dim count">{{ tr("{shown} из {total}", { shown: filtered.length, total: all.length }) }}</div>
        <div class="files">
          <a v-for="s in filtered" :key="s.path" href="#" class="file" :class="{ active: s.path === store.item }" @click.prevent="store.openItem(s.path)">
            <span :class="`dot ch-${s.change}`" />
            <span class="mono path" :title="s.path">{{ short(s.path) }}</span>
          </a>
        </div>
      </div>

      <div class="viewer mods-block">
        <div v-if="!current" class="dim pick">{{ tr("Выберите файл слева.") }}</div>
        <template v-else>
          <div class="viewer-head">
            <span class="mono path-title">{{ current.path }}</span>
            <el-tag :type="tagType(current.change)" size="small" disable-transitions>{{ CHANGE_LABEL[current.change] }}</el-tag>
            <span v-if="rows.length" class="dim"><span v-if="stats.removed" class="st-removed tiny">−{{ stats.removed }}</span> <span v-if="stats.added" class="st-added tiny">+{{ stats.added }}</span></span>
            <span class="spacer" />
            <el-radio-group v-model="context" size="small">
              <el-radio-button :value="3">{{ tr("Только изменения") }}</el-radio-button>
              <el-radio-button :value="Infinity">{{ tr("Весь файл") }}</el-radio-button>
            </el-radio-group>
          </div>
          <div v-if="current.modifiers.length" class="mods-line">
            <span class="dim">{{ tr("Модификаторы с этим скриптом:") }}</span>
            <EntityLink v-for="m in current.modifiers" :key="m.id" :section="m.section" :id="m.id" :name="m.name" />
          </div>
          <div v-if="loading" class="dim">{{ tr("Загружаю тексты…") }}</div>
          <el-alert v-else-if="failed" type="error" :title="tr('Не удалось загрузить скрипт: {error}', { error: failed })" :closable="false" />
          <div v-else-if="!rows.length" class="dim">{{ tr("Тексты совпадают построчно (различаются только байты, например переводы строк).") }}</div>
          <div v-else class="code">
            <div class="code-head">
              <span><span class="side-label">A</span> {{ store.modA?.name }}</span>
              <span><span class="side-label">B</span> {{ store.modB?.name }}</span>
            </div>
            <table class="diff">
              <tbody>
                <tr v-for="(r, i) in rows" :key="i" :class="`k-${r.kind}`">
                  <template v-if="r.kind === 'gap'">
                    <td colspan="4" class="gap">⋯</td>
                  </template>
                  <template v-else>
                    <td class="no">{{ r.a?.no ?? "" }}</td>
                    <td class="src a" :class="{ hit: r.kind === 'removed' || r.kind === 'changed', none: !r.a }">{{ r.a?.text ?? "" }}</td>
                    <td class="no">{{ r.b?.no ?? "" }}</td>
                    <td class="src b" :class="{ hit: r.kind === 'added' || r.kind === 'changed', none: !r.b }">{{ r.b?.text ?? "" }}</td>
                  </template>
                </tr>
              </tbody>
            </table>
          </div>
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
  grid-template-columns: 340px 1fr;
  gap: 12px;
  align-items: start;
}
.list {
  position: sticky;
  top: 0;
  max-height: calc(100vh - 120px);
  display: flex;
  flex-direction: column;
}
.count {
  font-size: 12px;
  margin-bottom: 4px;
}
.files {
  overflow-y: auto;
  min-height: 0;
  flex: 1;
}
.file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: var(--d2-radius);
  color: inherit;
  text-decoration: none;
  font-size: 12px;
}
.file:hover {
  background: var(--el-fill-color-light);
}
.file.active {
  background: var(--d2-active-bg);
  color: var(--d2-active-fg);
}
.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.dot.ch-added {
  background: var(--el-color-success);
}
.dot.ch-changed {
  background: var(--el-color-warning);
}
.dot.ch-removed {
  background: var(--el-color-danger);
}
.viewer {
  min-width: 0;
}
.viewer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.path-title {
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.tiny {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
}
.mods-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-bottom: 8px;
}
.pick {
  padding: 20px;
}
.code {
  border: var(--d2-hairline);
  border-radius: var(--d2-radius);
  overflow: auto;
}
.code-head {
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 6px 10px;
  border-bottom: var(--d2-hairline);
  background: var(--el-fill-color-lighter);
}
.code-head > span {
  display: flex;
  gap: 6px;
  align-items: center;
}
.diff {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 12px;
}
.diff td {
  padding: 0 6px;
  vertical-align: top;
  line-height: 18px;
}
.no {
  width: 46px;
  text-align: right;
  color: var(--el-text-color-placeholder);
  user-select: none;
  background: var(--el-fill-color-lighter);
}
.src {
  white-space: pre-wrap;
  word-break: break-all;
}
.src.a.hit {
  background: var(--el-color-danger-light-9);
}
.src.b.hit {
  background: var(--el-color-success-light-9);
}
.src.none {
  background: var(--el-fill-color-light);
}
.gap {
  text-align: center;
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-lighter);
}
</style>
