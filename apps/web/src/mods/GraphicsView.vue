<script setup lang="ts">
/** Every frame, animation and icon that one mod added, changed or dropped, by archive. */
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import type { Change, PictureChange } from "@d2/mod-diff";
import { tr, intlLocale } from "../i18n";
import { useCompareStore } from "./compareStore";
import { CHANGE_LABEL, PICTURE_KINDS } from "./labels";
import { comparable, pictureStats, sourcesFor, type PictureStats } from "./pictureCompare";
import { usePhone } from "./phone";
import PicturePair from "./PicturePair.vue";
import CountChips from "./CountChips.vue";

const store = useCompareStore();
const phone = usePhone();
const kind = ref<string>("");
const archive = ref<string>("");
const changes = ref<Change[]>(["added", "changed", "removed"]);
const search = ref("");
const page = ref(1);
const pageSize = ref(60);

const all = computed(() => store.diff?.pictures.changes ?? []);

// ---- every changed picture compared by pixels: which changed for real, which only moved
/** Up to this many changed pictures are checked as soon as the screen opens. */
const AUTO_CHECK = 300;
const checkable = computed(() => all.value.filter(comparable));
/** Stats of each checked picture; null when it could not be compared. */
const checked = shallowRef<Map<PictureChange, PictureStats | null>>(new Map());
const checking = ref(false);
const checkedCount = ref(0);
const hideSame = ref(false);
let checkRun = 0;

async function checkAll(): Promise<void> {
  const mine = ++checkRun;
  const list = checkable.value;
  const out = new Map<PictureChange, PictureStats | null>();
  checking.value = true;
  checkedCount.value = 0;
  await Promise.all(
    list.map(async (c) => {
      try {
        out.set(c, await pictureStats(c, sourcesFor(store, c)));
      } catch {
        out.set(c, null);
      }
      if (mine === checkRun) checkedCount.value++;
    }),
  );
  if (mine !== checkRun) return;
  checked.value = out;
  checking.value = false;
}
const checkSummary = computed(() => {
  let real = 0;
  let same = 0;
  let failed = 0;
  for (const s of checked.value.values()) {
    if (!s) failed++;
    else if (s.changed) real++;
    else same++;
  }
  return { real, same, failed, done: checked.value.size > 0 };
});
watch(
  () => store.diff,
  () => {
    checkRun++;
    checked.value = new Map();
    checking.value = false;
    hideSame.value = false;
    if (checkable.value.length && checkable.value.length <= AUTO_CHECK) void checkAll();
  },
);
onMounted(() => {
  if (checkable.value.length && checkable.value.length <= AUTO_CHECK) void checkAll();
});
const archives = computed(() => {
  const by = store.diff?.pictures.byArchive ?? {};
  return Object.entries(by)
    .map(([name, c]) => ({ name, label: name || tr("без архива"), ...c, total: c.added + c.changed + c.removed }))
    .sort((a, b) => b.total - a.total);
});
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return all.value.filter(
    (p) =>
      (!kind.value || p.kind === kind.value) &&
      (!archive.value || (p.archive ?? "") === archive.value) &&
      changes.value.includes(p.change) &&
      !(hideSame.value && checked.value.get(p)?.changed === 0) &&
      (!q || p.name.toLowerCase().includes(q)),
  );
});
const pageItems = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch([kind, archive, changes, search, pageSize, hideSame], () => (page.value = 1));
const counts = computed(() => store.diff?.summary.pictures);
const num = (n: number) => n.toLocaleString(intlLocale());
</script>

<template>
  <div>
    <h1 class="title">{{ tr("Графика") }}</h1>
    <div v-if="counts" class="summary">
      <span>{{ PICTURE_KINDS.frame }}: <CountChips :added="counts.frames.added" :changed="counts.frames.changed" :removed="counts.frames.removed" /> <span class="dim">{{ tr("одинаковых {n}", { n: num(counts.frames.same) }) }}</span></span>
      <span>{{ PICTURE_KINDS.animation }}: <CountChips :added="counts.animations.added" :changed="counts.animations.changed" :removed="counts.animations.removed" /></span>
      <span>{{ PICTURE_KINDS.icon }}: <CountChips :added="counts.icons.added" :changed="counts.icons.changed" :removed="counts.icons.removed" /></span>
    </div>
    <p class="dim lead">{{ tr("Кадр считается изменённым, когда у него другой лист или прямоугольник: пиксели могут и совпадать, если мод только пересобрал лист.") }} {{ tr("Изменённые картинки сравниваются по пикселям; щелчок по картинке открывает её крупно.") }}</p>
    <div v-if="checkable.length" class="pixel-check">
      <template v-if="checking">
        <span class="dim">{{ tr("Сравниваю по пикселям: {done} из {total}", { done: num(checkedCount), total: num(checkable.length) }) }}</span>
      </template>
      <template v-else-if="checkSummary.done">
        <span>{{ tr("По пикселям:") }}</span>
        <span class="px-real">{{ tr("отличаются {n}", { n: num(checkSummary.real) }) }}</span>
        <span class="px-same">{{ tr("совпадают {n} — изменилась только упаковка листа", { n: num(checkSummary.same) }) }}</span>
        <span v-if="checkSummary.failed" class="dim">{{ tr("не удалось сравнить {n}", { n: num(checkSummary.failed) }) }}</span>
        <el-switch v-if="checkSummary.same" v-model="hideSame" size="small" :active-text="tr('Скрыть совпадающие по пикселям')" />
      </template>
      <el-button v-else size="small" @click="checkAll">{{ tr("Сравнить все изменённые по пикселям ({n})", { n: num(checkable.length) }) }}</el-button>
    </div>

    <el-empty v-if="!all.length" :description="tr('Картинки модов совпадают.')" />
    <template v-else>
      <div class="archives">
        <a href="#" class="arch" :class="{ active: !archive }" @click.prevent="archive = ''">{{ tr("Все архивы") }} <span class="dim">{{ all.length }}</span></a>
        <a v-for="a in archives" :key="a.name" href="#" class="arch" :class="{ active: archive === a.name }" @click.prevent="archive = a.name">
          <span class="mono">{{ a.label }}</span>
          <CountChips :added="a.added" :changed="a.changed" :removed="a.removed" />
        </a>
      </div>
      <div class="mods-toolbar">
        <el-input v-model="search" :placeholder="tr('Имя кадра или файла')" clearable class="search" />
        <el-select v-model="kind" :placeholder="tr('Тип')" clearable class="sel">
          <el-option value="frame" :label="PICTURE_KINDS.frame" />
          <el-option value="animation" :label="PICTURE_KINDS.animation" />
          <el-option value="icon" :label="PICTURE_KINDS.icon" />
        </el-select>
        <el-checkbox-group v-model="changes" size="small">
          <el-checkbox-button value="added">{{ CHANGE_LABEL.added }}</el-checkbox-button>
          <el-checkbox-button value="changed">{{ CHANGE_LABEL.changed }}</el-checkbox-button>
          <el-checkbox-button value="removed">{{ CHANGE_LABEL.removed }}</el-checkbox-button>
        </el-checkbox-group>
        <span class="dim">{{ tr("{shown} из {total}", { shown: filtered.length, total: all.length }) }}</span>
      </div>
      <div class="mods-gallery dense">
        <PicturePair v-for="p in pageItems" :key="`${p.kind}:${p.archive}:${p.name}:${p.change}`" :change="p" :size="72" />
      </div>
      <el-pagination
        v-if="filtered.length > pageSize"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="filtered.length"
        :page-sizes="[60, 120, 240]"
        :layout="phone ? 'prev, pager, next' : 'total, sizes, prev, pager, next'"
        :pager-count="phone ? 5 : 7"
        size="small"
        class="pager"
      />
    </template>
  </div>
</template>

<style scoped>
.title {
  font-size: 20px;
  font-weight: 650;
  margin: 2px 0 6px;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  margin-bottom: 6px;
  align-items: center;
}
.lead {
  margin: 4px 0 8px;
  font-size: 12px;
}
.pixel-check {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  margin-bottom: 12px;
}
.px-real {
  color: rgb(214, 110, 0);
  font-weight: 600;
}
.px-same {
  color: var(--el-color-success);
}
.dense {
  grid-auto-flow: row dense;
}
.archives {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.arch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-radius: var(--d2-radius);
  border: var(--d2-hairline);
  background: var(--el-bg-color);
  color: inherit;
  text-decoration: none;
}
.arch.active {
  border-color: var(--el-color-primary);
  background: var(--d2-active-bg);
}
.search {
  width: 240px;
}
.sel {
  width: 150px;
}
.pager {
  margin-top: 12px;
}
/* phone: the archives are a strip that scrolls sideways */
@media (max-width: 760px) {
  .archives {
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  .arch {
    flex: 0 0 auto;
    white-space: nowrap;
  }
}
</style>
