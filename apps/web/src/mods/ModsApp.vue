<script setup lang="ts">
/**
 * The mod compare page: header with the pair, a navigation of sections with counts, the
 * open screen, and a card drawer. Opened by `?mods&a=<id>&b=<id>`.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Moon, Sunny, Switch } from "@element-plus/icons-vue";
import { tr, LOCALES, currentLocale, switchLocale, type Locale } from "../i18n";
import { useCompareStore } from "./compareStore";
import { NAV, navLabel, type NavId } from "./labels";
import { usePhone } from "./phone";
import type { SectionId } from "@d2/mod-diff";
import OverviewView from "./OverviewView.vue";
import EntityListView from "./EntityListView.vue";
import RacesView from "./RacesView.vue";
import TerrainView from "./TerrainView.vue";
import GraphicsView from "./GraphicsView.vue";
import ScriptsView from "./ScriptsView.vue";
import TablesView from "./TablesView.vue";
import EntityCard from "./EntityCard.vue";
import RaceCard from "./RaceCard.vue";

const store = useCompareStore();

// the editor's theme choice (View ▸ Dark theme) is shared through its saved view settings
const VIEW_KEY = "d2.view.v1";
function readView(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
const dark = ref(readView().dark !== false);
function applyTheme(): void {
  document.documentElement.classList.toggle("dark", dark.value);
}
function toggleTheme(): void {
  dark.value = !dark.value;
  applyTheme();
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ ...readView(), dark: dark.value }));
  } catch {
    /* storage blocked: the choice lasts for this page */
  }
}

const editorHref = import.meta.env.BASE_URL;
// the interface language, as in the editor's top bar: the choice is shared with the editor,
// and the reload keeps the address (the pair, the open screen, a share key in the fragment)
const locale = currentLocale();

onMounted(() => {
  applyTheme();
  document.title = tr("Сравнение модов");
  void store.init(window.location.search, { hash: window.location.hash });
});

const ENTITY_VIEWS: readonly string[] = ["units", "attacks", "items", "spells", "buildings", "lords", "modifiers", "landmarks", "leaderUpgrades", "dynamicUpgrades", "texts", "rules"];

const badges = computed<Partial<Record<NavId, number>>>(() => {
  const d = store.diff;
  if (!d) return {};
  const out: Partial<Record<NavId, number>> = {};
  for (const s of ENTITY_VIEWS) out[s as SectionId] = d.summary.sections[s as SectionId].total;
  const subraces = d.sections.races.filter((e) => e.group.kind === "subrace").length;
  out.races = d.summary.races.changed.length + subraces;
  out.terrain = d.summary.terrain.changed.length;
  out.graphics = d.pictures.changes.length;
  out.scripts = d.scripts.length;
  out.tables = d.summary.tables.differ;
  return out;
});

// a card from the address waits for the diff (its entity is not known before)
const cardOpen = computed({
  get: () => ready.value && !!store.card,
  set: (v: boolean) => {
    if (!v) store.closeCard();
  },
});

function stageText(side: "a" | "b"): string {
  const p = store.progress[side];
  if (!p) return tr("Жду…");
  switch (p.stage) {
    case "files":
      return tr("Список файлов: {done} из {total}", { done: p.done, total: p.total });
    case "tables":
      return p.total ? tr("Таблицы: {done} из {total}", { done: p.done, total: p.total }) : tr("Таблиц нет");
    case "manifest":
      return tr("Манифест картинок…");
    default:
      return tr("Загружено");
  }
}
function stagePercent(side: "a" | "b"): number {
  const p = store.progress[side];
  if (!p) return 0;
  if (p.stage === "done") return 100;
  if (p.stage === "files") return Math.round((p.done / Math.max(1, p.total)) * 15);
  if (p.stage === "manifest") return 95;
  return 15 + Math.round((p.done / Math.max(1, p.total)) * 80);
}
const loadingSides = computed(() => (store.identical ? (["a"] as const) : (["a", "b"] as const)));

const missingNames = computed(() => {
  const out: string[] = [];
  if (store.tablesMissing.a && store.modA) out.push(store.modA.name);
  if (store.tablesMissing.b && store.modB && store.bId !== store.aId) out.push(store.modB.name);
  return out;
});

const ready = computed(() => store.phase === "ready" && !!store.diff);

// the wording of texts: what the last diff did, else what the address asks
const skipTexts = computed(() => store.diff?.texts.skipped ?? store.texts === "skip");
const SCRIPT_NAMES = { latin: () => tr("на латинице"), cyrillic: () => tr("на кириллице") } as const;
/** Why the texts were not compared, shown above every screen. */
const textsNotice = computed(() => {
  const d = store.diff;
  if (!d?.texts.skipped || store.identical) return null;
  const n = d.summary.tables.translations;
  const { a, b } = d.texts;
  if (store.texts !== "skip" && a && b && a !== b) {
    return tr("Тексты {a} — {sa}, {b} — {sb}: один мод переведён с другого, поэтому формулировки текстов не сравниваются (не показано различий: {n}). Новые и удалённые тексты видны.", {
      a: store.modA?.name ?? "A",
      b: store.modB?.name ?? "B",
      sa: SCRIPT_NAMES[a](),
      sb: SCRIPT_NAMES[b](),
      n,
    });
  }
  return tr("Формулировки текстов не сравниваются (не показано различий: {n}). Новые и удалённые тексты видны.", { n });
});
const isEntityView = computed(() => ENTITY_VIEWS.includes(store.view));

// on a phone the navigation is a strip across the top: keep the open screen's tab in sight
const phone = usePhone();
const navEl = ref<HTMLElement | null>(null);
function showActiveTab(): void {
  if (!phone.value) return;
  void nextTick(() => navEl.value?.querySelector(".nav-item.active")?.scrollIntoView({ block: "nearest", inline: "center" }));
}
// the counts that come with the diff widen the tabs: center the open one again
watch([() => store.view, phone, ready], showActiveTab);
onMounted(showActiveTab);
</script>

<template>
  <div class="mods-app">
    <header class="mods-head">
      <div class="brand"><span class="mark" />{{ tr("Сравнение модов") }}</div>
      <div class="pair">
        <span class="side-label">A</span>
        <el-select
          class="mod-select"
          :model-value="store.aId ?? ''"
          :placeholder="tr('Мод A')"
          filterable
          :disabled="!store.mods.length"
          @update:model-value="(v: string) => store.setPair(v, store.bId)"
        >
          <el-option v-for="m in store.mods" :key="m.id" :value="m.id" :label="m.name">
            <span>{{ m.name }}</span>
            <span class="opt-id mono">{{ m.id }}</span>
            <span v-if="m.hidden" class="opt-hidden">{{ tr("скрыт") }}</span>
          </el-option>
        </el-select>
        <el-button :icon="Switch" circle size="small" :title="tr('Поменять местами')" :disabled="!store.aId || !store.bId" @click="store.swap()" />
        <span class="side-label">B</span>
        <el-select
          class="mod-select"
          :model-value="store.bId ?? ''"
          :placeholder="tr('Мод B')"
          filterable
          :disabled="!store.mods.length"
          @update:model-value="(v: string) => store.setPair(store.aId, v)"
        >
          <el-option v-for="m in store.mods" :key="m.id" :value="m.id" :label="m.name">
            <span>{{ m.name }}</span>
            <span class="opt-id mono">{{ m.id }}</span>
            <span v-if="m.hidden" class="opt-hidden">{{ tr("скрыт") }}</span>
          </el-option>
        </el-select>
      </div>
      <div v-if="store.modA && store.modB" class="pair-names" :title="`${store.modA.id} → ${store.modB.id}`">
        <b>{{ store.modA.name }}</b> → <b>{{ store.modB.name }}</b>
      </div>
      <el-checkbox
        class="texts-box"
        size="small"
        :model-value="skipTexts"
        :disabled="!ready || store.identical"
        :title="tr('Тексты, которые есть в обоих модах и написаны по-разному, не считаются правкой. Так сравнение английской игры с русским модом показывает только настоящие изменения. Новые и удалённые тексты видны.')"
        @update:model-value="(v: string | number | boolean) => store.setTexts(v === true)"
      >
        {{ tr("Не сравнивать переводы") }}
      </el-checkbox>
      <div class="spacer" />
      <el-dropdown class="lang-menu" trigger="click" @command="(l: Locale) => switchLocale(l)">
        <el-button class="lang-btn" text size="small" :title="tr('Язык интерфейса')">{{ locale.toUpperCase() }}</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="l in LOCALES" :key="l.value" :command="l.value" :class="{ 'lang-current': l.value === locale }">
              {{ l.label }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button class="theme-btn" text size="small" :icon="phone ? (dark ? Sunny : Moon) : undefined" :title="dark ? tr('Светлая тема') : tr('Тёмная тема')" @click="toggleTheme">
        <span v-if="!phone">{{ dark ? tr("Светлая тема") : tr("Тёмная тема") }}</span>
      </el-button>
      <a class="back-link" :href="editorHref">{{ tr("← К редактору карт") }}</a>
    </header>

    <div class="mods-body">
      <nav ref="navEl" class="mods-nav">
        <a
          v-for="n in NAV"
          :key="n.id"
          href="#"
          class="nav-item"
          :class="{ active: store.view === n.id, empty: ready && n.id !== 'overview' && !badges[n.id] }"
          @click.prevent="store.openView(n.id)"
        >
          <span class="nav-label">{{ n.label }}</span>
          <span v-if="ready && n.id !== 'overview'" class="nav-badge">{{ badges[n.id] ?? 0 }}</span>
        </a>
      </nav>

      <main class="mods-main">
        <el-alert v-for="n in store.notices" :key="n" :title="n" type="warning" show-icon :closable="false" class="notice" />
        <el-alert
          v-for="name in missingNames"
          :key="name"
          :title="tr('Таблицы этого мода не выложены на сервер')"
          :description="tr('{mod}: юниты, предметы, расы и правила сравнить нельзя; сравниваются картинки и скрипты.', { mod: name })"
          type="warning"
          show-icon
          :closable="false"
          class="notice"
        />
        <el-alert v-if="ready && textsNotice" :title="textsNotice" type="info" show-icon :closable="false" class="notice" />

        <div v-if="store.phase === 'error'" class="state">
          <el-result icon="error" :title="tr('Сравнение не получилось')" :sub-title="store.error ?? ''">
            <template #extra>
              <el-button type="primary" @click="store.load()">{{ tr("Повторить") }}</el-button>
            </template>
          </el-result>
        </div>

        <div v-else-if="!ready" class="state loading">
          <h2>{{ store.phase === "diffing" ? tr("Сравниваю моды…") : store.phase === "listing" ? tr("Получаю список модов…") : tr("Загружаю данные модов…") }}</h2>
          <div v-if="store.phase !== 'listing'" class="progress">
            <div v-for="s in loadingSides" :key="s" class="progress-row">
              <span class="side-label">{{ s.toUpperCase() }}</span>
              <span class="progress-mod">{{ (s === "a" ? store.modA : store.modB)?.name }}</span>
              <el-progress :percentage="stagePercent(s)" :stroke-width="8" :show-text="false" class="bar" />
              <span class="progress-text">{{ stageText(s) }}</span>
            </div>
            <div v-if="store.phase === 'diffing'" class="dim">{{ tr("Таблицы загружены, считаю разницу — это займёт пару секунд.") }}</div>
          </div>
        </div>

        <template v-else>
          <el-empty
            v-if="store.identical"
            :description="tr('Выбран один и тот же мод — сравнивать нечего. Выберите другой мод A или B.')"
          />
          <template v-else>
            <OverviewView v-if="store.view === 'overview'" />
            <RacesView v-else-if="store.view === 'races'" />
            <EntityListView v-else-if="isEntityView" :key="store.view" :section="store.view as SectionId" />
            <TerrainView v-else-if="store.view === 'terrain'" />
            <GraphicsView v-else-if="store.view === 'graphics'" />
            <ScriptsView v-else-if="store.view === 'scripts'" />
            <TablesView v-else-if="store.view === 'tables'" />
            <div v-else class="dim">{{ navLabel(store.view) }}</div>
          </template>
        </template>
      </main>
    </div>

    <el-drawer v-model="cardOpen" :with-header="false" :size="phone ? '100%' : 'min(860px, 94vw)'" class="mods-drawer" append-to-body>
      <template v-if="ready">
        <RaceCard v-if="store.card?.kind === 'race' && store.index.races.has(store.card.id)" :key="store.card.id" :race-id="store.card.id" />
        <EntityCard v-else-if="store.card?.kind === 'entity' && store.index.byUid.has(store.card.uid)" :key="store.card.uid" :uid="store.card.uid" />
      </template>
    </el-drawer>
  </div>
</template>

<style>
/* shared by every screen of the compare page */
:root {
  --mods-pic-bg: #e8ebef;
}
html.dark {
  --mods-pic-bg: #262a31;
}
.mods-app .mono,
.mods-drawer .mono {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.mods-app .dim,
.mods-drawer .dim {
  color: var(--el-text-color-secondary);
}
/* the drawer is appended to <body>, outside the app: give it the app's text colour */
.mods-drawer {
  color: var(--el-text-color-primary);
  font-size: 13px;
}
.mods-app a,
.mods-drawer a {
  color: var(--el-color-primary);
  text-decoration: none;
}
.mods-app a:hover,
.mods-drawer a:hover {
  text-decoration: underline;
}
.st-added {
  color: var(--el-color-success);
  background: var(--el-color-success-light-9);
}
.st-changed {
  color: var(--el-color-warning-dark-2);
  background: var(--el-color-warning-light-9);
}
html.dark .st-changed {
  color: var(--el-color-warning);
}
.st-removed {
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
}
.st-art {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.st-shared {
  color: var(--el-color-info);
  background: var(--el-color-info-light-9);
}
.mods-app .side-label,
.mods-drawer .side-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  background: var(--el-fill-color-dark);
  color: var(--el-text-color-regular);
  flex: 0 0 auto;
}
.mods-section-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 8px;
}
.mods-section-title .dim {
  font-size: 13px;
  font-weight: 400;
}
.mods-block {
  background: var(--el-bg-color);
  border: var(--d2-hairline);
  border-radius: var(--d2-radius-lg);
  padding: 14px 16px;
  margin-bottom: 14px;
}
.mods-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.mods-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 8px;
}
.mods-drawer .el-drawer__body {
  padding: 0;
}

/* phone: toolbars take the whole width, button groups wrap as separate buttons */
@media (max-width: 760px) {
  .mods-block {
    padding: 10px 12px;
  }
  .mods-app .mods-toolbar .el-input {
    flex: 1 1 100%;
    width: auto;
  }
  .mods-app .mods-toolbar .el-select {
    flex: 1 1 140px;
    width: auto;
  }
  .mods-app .mods-toolbar .el-checkbox-group,
  .mods-app .mods-toolbar .el-radio-group {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .mods-app .mods-toolbar .el-checkbox-button .el-checkbox-button__inner,
  .mods-app .mods-toolbar .el-radio-button .el-radio-button__inner {
    border-left: var(--el-border);
    border-radius: var(--el-border-radius-base);
  }
  .mods-app .mods-toolbar .el-checkbox-button.is-checked .el-checkbox-button__inner,
  .mods-app .mods-toolbar .el-radio-button.is-active .el-radio-button__inner {
    border-left-color: var(--el-color-primary);
  }
  /* two columns of picture pairs also in a block on a 360 px phone (PicturePair: 60 px thumbs) */
  .mods-gallery {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 6px;
  }
}
</style>

<style scoped>
.mods-app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--el-bg-color-page);
  color: var(--el-text-color-primary);
  font-size: 13px;
}
.mods-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 16px;
  height: 52px;
  flex: 0 0 auto;
  background: var(--el-bg-color);
  border-bottom: var(--d2-hairline);
  min-width: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 15px;
  white-space: nowrap;
}
.mark {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  background: linear-gradient(135deg, var(--el-color-primary), var(--el-color-success));
}
.pair {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mod-select {
  width: 190px;
}
.opt-id {
  margin-left: 8px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.opt-hidden {
  margin-left: 6px;
  font-size: 11px;
  color: var(--el-color-warning);
}
.pair-names {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--el-text-color-regular);
  min-width: 0;
}
.spacer {
  flex: 1;
}
.texts-box {
  flex: 0 0 auto;
  margin-right: 0;
}
.back-link {
  color: var(--el-color-primary);
  text-decoration: none;
  white-space: nowrap;
}
.lang-btn {
  min-width: 34px;
  padding: 0 6px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
:global(.lang-current) {
  color: var(--el-color-primary);
  font-weight: 600;
}
.back-link:hover {
  text-decoration: underline;
}
.mods-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.mods-nav {
  width: 210px;
  flex: 0 0 auto;
  overflow-y: auto;
  padding: 10px 8px;
  border-right: var(--d2-hairline);
  background: var(--el-bg-color);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--d2-radius);
  color: var(--el-text-color-regular);
  text-decoration: none;
}
.nav-item:hover {
  background: var(--el-fill-color-light);
}
.nav-item.active {
  background: var(--d2-active-bg);
  color: var(--d2-active-fg);
  font-weight: 600;
}
.nav-item.empty {
  color: var(--el-text-color-placeholder);
}
.nav-badge {
  font-size: 11px;
  min-width: 22px;
  text-align: center;
  padding: 0 6px;
  line-height: 18px;
  border-radius: 9px;
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}
.nav-item.active .nav-badge {
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}
.mods-main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 16px 20px 40px;
}
.notice {
  margin-bottom: 10px;
}
.state.loading h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 20px 0 16px;
}
.progress {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}
.progress-row {
  display: grid;
  grid-template-columns: 24px 160px 1fr 200px;
  gap: 10px;
  align-items: center;
}
.progress-mod {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.progress-text {
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

/* phone: the header wraps (brand and buttons, then the pair, then the switch and the way
   back), the navigation becomes a strip of tabs above the screen */
@media (max-width: 760px) {
  .mods-head {
    flex-wrap: wrap;
    height: auto;
    gap: 8px 10px;
    padding: 8px 12px;
  }
  .spacer {
    order: 1;
  }
  .lang-menu {
    order: 2;
  }
  .theme-btn {
    order: 3;
  }
  .pair {
    order: 4;
    flex: 1 1 100%;
    min-width: 0;
  }
  .mod-select {
    flex: 1 1 0;
    width: auto;
    min-width: 0;
  }
  .pair-names {
    display: none;
  }
  .texts-box {
    order: 5;
  }
  .back-link {
    order: 6;
    margin-left: auto;
  }
  .mods-body {
    flex-direction: column;
  }
  .mods-nav {
    width: auto;
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 6px 8px;
    gap: 4px;
    border-right: 0;
    border-bottom: var(--d2-hairline);
    scrollbar-width: none;
  }
  .nav-item {
    flex: 0 0 auto;
    white-space: nowrap;
    padding: 5px 10px;
  }
  .mods-main {
    min-height: 0;
    padding: 12px 12px 32px;
  }
  .progress-row {
    grid-template-columns: 24px 1fr;
    gap: 6px 10px;
  }
  .progress-row .bar,
  .progress-text {
    grid-column: 1 / -1;
  }
}
</style>
