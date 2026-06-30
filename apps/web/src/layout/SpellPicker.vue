<script setup lang="ts">
/**
 * SpellPicker — a reusable, searchable, grouped spell chooser (the spellCatalog), used by
 * the mage-shop spell-list editor. Add-mode only (emits `pick`); group toggle by
 * school / level / А-Я with a subcategory combobox + text search. Trackpad-friendly modal.
 */
import { ref, computed, watch } from "vue";
import { Search } from "@element-plus/icons-vue";
import { useSpellStore, type SpellEntry, type SpellGroup } from "../stores/spellStore";
import SpellIcon from "./SpellIcon.vue";
import PickerSortHeader from "./PickerSortHeader.vue";
import { sortBy, nextSort, type SortKey } from "./pickerSort";

/** Sort keys for the per-group sort control (shown in every subcategory header). */
const SORT_KEYS: SortKey<SpellEntry>[] = [
  { key: "name", label: "А-Я", get: (e) => e.name },
  { key: "level", label: "ур.", get: (e) => e.level, desc: true },
];

const props = withDefaults(
  defineProps<{ title?: string; triggerLabel?: string }>(),
  { title: "Выбор заклинания", triggerLabel: "+ Добавить заклинание" },
);
const emit = defineEmits<{ pick: [string] }>();

const spellStore = useSpellStore();

const open = ref(false);
const query = ref("");
type Mode = "cat" | "level" | "alpha";
const mode = ref<Mode>("cat");
const subFilter = ref<string>("all");
const MODE_OPTIONS = [
  { label: "Школа", value: "cat" },
  { label: "Уровень", value: "level" },
  { label: "А-Я", value: "alpha" },
];

const sortKey = ref<string>("level");
const sortDir = ref<1 | -1>(1);
function setSort(key: string): void {
  const n = nextSort(SORT_KEYS, { key: sortKey.value, dir: sortDir.value }, key);
  sortKey.value = n.key;
  sortDir.value = n.dir;
}
const activeSort = computed(() => SORT_KEYS.find((k) => k.key === sortKey.value));

watch(open, (v) => {
  if (v) {
    void spellStore.load();
    query.value = "";
    mode.value = "cat";
    subFilter.value = "all";
    sortKey.value = "level";
    sortDir.value = 1;
  }
});
watch(mode, () => { subFilter.value = "all"; });

interface DisplayGroup { key: string; label: string; spells: SpellEntry[] }

const baseGroups = computed<DisplayGroup[]>(() => {
  let g: SpellGroup[];
  if (mode.value === "level") g = spellStore.byLevel;
  else if (mode.value === "alpha")
    return [{ key: "all", label: "Все заклинания", spells: [...spellStore.all].sort((a, b) => a.name.localeCompare(b.name, "ru")) }];
  else g = spellStore.byCat;
  return g.map((x) => ({ key: x.key, label: x.label, spells: x.spells }));
});

const subOptions = computed(() => baseGroups.value.map((g) => ({ value: g.key, label: `${g.label} (${g.spells.length})` })));

const groups = computed<DisplayGroup[]>(() => {
  const q = query.value.trim().toLowerCase();
  let base = baseGroups.value;
  if (subFilter.value !== "all") base = base.filter((g) => g.key === subFilter.value);
  const sk = activeSort.value;
  const dir = sortDir.value;
  if (!q) return base.filter((g) => g.spells.length).map((g) => ({ ...g, spells: sortBy(g.spells, sk, dir) }));
  const out: DisplayGroup[] = [];
  for (const g of base) {
    const spells = g.spells.filter(
      (s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.desc ?? "").toLowerCase().includes(q),
    );
    if (spells.length) out.push({ ...g, spells: sortBy(spells, sk, dir) });
  }
  return out;
});
const resultCount = computed(() => groups.value.reduce((n, g) => n + g.spells.length, 0));

function choose(id: string): void {
  emit("pick", id);
  open.value = false;
}
</script>

<template>
  <span class="sp-wrap">
    <el-button class="sp-trigger" size="small" @click="open = true">{{ triggerLabel }}</el-button>

    <el-dialog v-model="open" :title="title" width="560px" align-center append-to-body class="sp-dialog">
      <div class="sp-controls">
        <el-input v-model="query" placeholder="Поиск по названию или эффекту…" size="default" clearable :prefix-icon="Search" class="sp-search" />
        <el-select v-model="subFilter" filterable size="default" class="sp-sub" placeholder="Все">
          <el-option label="Все" value="all" />
          <el-option v-for="o in subOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
      <el-segmented v-model="mode" :options="MODE_OPTIONS" size="small" class="sp-modes" />

      <div v-if="spellStore.loading" class="sp-status">Загрузка каталога…</div>
      <div v-else-if="spellStore.error" class="sp-status err">Ошибка: {{ spellStore.error }}</div>
      <div v-else class="sp-list">
        <div v-if="!resultCount" class="sp-status">Ничего не найдено</div>
        <template v-for="g in groups" :key="g.key">
          <PickerSortHeader
            :label="g.label"
            :count="g.spells.length"
            :sort-keys="SORT_KEYS"
            :sort-key="sortKey"
            :sort-dir="sortDir"
            @sort="setSort"
          />
          <button
            v-for="s in g.spells"
            :key="s.id"
            class="sp-row"
            type="button"
            :title="s.desc || s.name"
            @click="choose(s.id)"
          >
            <SpellIcon :id="s.id" :level="s.level" :cat="s.cat" :size="30" />
            <span class="sp-text">
              <span class="sp-name">{{ s.name || s.id }}</span>
              <span v-if="s.desc" class="sp-desc">{{ s.desc }}</span>
            </span>
            <span class="sp-lvl">ур.{{ s.level }}</span>
          </button>
        </template>
      </div>

      <template #footer>
        <span class="sp-foot">
          <span class="sp-foot-info">{{ resultCount }} заклинаний</span>
          <el-button size="small" @click="open = false">Закрыть</el-button>
        </span>
      </template>
    </el-dialog>
  </span>
</template>

<style scoped>
.sp-wrap { display: inline-flex; align-items: center; max-width: 100%; }
.sp-controls { display: flex; gap: var(--d2-sp-2); margin-bottom: var(--d2-sp-2); }
.sp-search { flex: 1 1 auto; }
.sp-sub { flex: 0 0 200px; }
.sp-modes { width: 100%; margin-bottom: var(--d2-sp-2); }
.sp-list { max-height: 52vh; overflow-y: auto; margin: 0 -8px; padding: 0 8px; }
.sp-status { padding: 24px 8px; text-align: center; color: var(--el-text-color-secondary); font-size: 13px; }
.sp-status.err { color: var(--el-color-danger); }
.sp-group {
  position: sticky; top: 0; background: var(--el-bg-color);
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--el-text-color-secondary); padding: 8px 6px 4px; z-index: 1;
}
.sp-count { color: var(--el-text-color-placeholder); font-weight: 400; }
.sp-row {
  display: flex; align-items: center; gap: 8px; width: 100%; border: none; background: transparent;
  text-align: left; padding: 6px 8px; border-radius: var(--d2-radius-sm, 6px); cursor: pointer;
  font: inherit; color: var(--el-text-color-primary);
}
.sp-row:hover { background: var(--el-fill-color-light); }
.sp-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.sp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.sp-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--el-text-color-secondary); }
.sp-lvl { flex: 0 0 auto; font-size: 11px; color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
.sp-foot { display: flex; align-items: center; gap: var(--d2-sp-2); }
.sp-foot-info { margin-right: auto; font-size: 12px; color: var(--el-text-color-secondary); }
</style>
