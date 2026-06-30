<script setup lang="ts">
/**
 * ItemPicker — a reusable, searchable, category-grouped item chooser (the itemCatalog).
 * Two modes:
 *   - value mode  (v-model)        : a single field (ruin artifact). The trigger shows the
 *                                    current item's name; picking replaces it; clearable.
 *   - add mode    (:trigger-label) : an "add to list" button; picking emits `pick` only.
 * Trackpad-friendly: a modal dialog, big rows, a text search + category dropdown — no
 * hover-only affordances.
 */
import { ref, computed, watch } from "vue";
import { Search, CircleClose } from "@element-plus/icons-vue";
import { useItemStore, type ItemEntry } from "../stores/itemStore";
import ItemIcon from "./ItemIcon.vue";
import PickerSortHeader from "./PickerSortHeader.vue";
import { sortBy, nextSort, type SortKey } from "./pickerSort";

/** Sort keys for the per-group sort control (shown in every subcategory header). */
const SORT_KEYS: SortKey<ItemEntry>[] = [
  { key: "name", label: "А-Я", get: (e) => e.name },
  { key: "gold", label: "цена", get: (e) => e.gold, desc: true },
];

const props = withDefaults(
  defineProps<{
    modelValue?: string | null;
    nullable?: boolean;
    title?: string;
    triggerLabel?: string;
  }>(),
  { modelValue: null, nullable: false, title: "Выбор предмета", triggerLabel: "" },
);
const emit = defineEmits<{
  "update:modelValue": [string | null];
  pick: [string];
}>();

const itemStore = useItemStore();
const NULL_ID = "G000000000";

const open = ref(false);
const query = ref("");
type Mode = "cat" | "bonus" | "cost" | "alpha";
const mode = ref<Mode>("cat");
const subFilter = ref<string>("all"); // narrow to one sub-group of the active mode
const MODE_OPTIONS = [
  { label: "Категория", value: "cat" },
  { label: "Бонус", value: "bonus" },
  { label: "Цена", value: "cost" },
  { label: "А-Я", value: "alpha" },
];

const sortKey = ref<string>("name");
const sortDir = ref<1 | -1>(1);
function setSort(key: string): void {
  const n = nextSort(SORT_KEYS, { key: sortKey.value, dir: sortDir.value }, key);
  sortKey.value = n.key;
  sortDir.value = n.dir;
}
const activeSort = computed(() => SORT_KEYS.find((k) => k.key === sortKey.value));

watch(open, (v) => {
  if (v) {
    void itemStore.load();
    query.value = "";
    mode.value = "cat";
    subFilter.value = "all";
    sortKey.value = "name";
    sortDir.value = 1;
  }
});
watch(mode, () => { subFilter.value = "all"; }); // sub-groups change with the mode

const COST_BUCKETS = [
  { key: "c0", label: "Без стоимости", lo: 0, hi: 0 },
  { key: "c1", label: "1–499", lo: 1, hi: 499 },
  { key: "c2", label: "500–1499", lo: 500, hi: 1499 },
  { key: "c3", label: "1500–2999", lo: 1500, hi: 2999 },
  { key: "c4", label: "3000+", lo: 3000, hi: Infinity },
];

interface DisplayGroup { key: string; label: string; items: ItemEntry[] }

/** Groups for the active mode, before the search filter. */
const baseGroups = computed<DisplayGroup[]>(() => {
  if (mode.value === "bonus") return itemStore.bonusGroups;
  if (mode.value === "alpha") {
    return [{ key: "all", label: "Все предметы", items: [...itemStore.all].sort((a, b) => a.name.localeCompare(b.name, "ru")) }];
  }
  if (mode.value === "cost") {
    return COST_BUCKETS.map((b) => ({
      key: b.key,
      label: b.label,
      items: itemStore.all
        .filter((e) => e.gold >= b.lo && e.gold <= b.hi)
        .sort((a, c) => c.gold - a.gold || a.name.localeCompare(c.name, "ru")),
    })).filter((g) => g.items.length);
  }
  return itemStore.groups.map((g) => ({ key: g.catKey || String(g.cat), label: g.label, items: g.items }));
});

/** Sub-group options for the active mode (drives the subcategory combobox). */
const subOptions = computed(() => baseGroups.value.map((g) => ({ value: g.key, label: `${g.label} (${g.items.length})` })));

/** baseGroups narrowed to the chosen sub-group, then filtered by the search query. */
const groups = computed<DisplayGroup[]>(() => {
  const q = query.value.trim().toLowerCase();
  let base = baseGroups.value;
  if (subFilter.value !== "all") base = base.filter((g) => g.key === subFilter.value);
  const sk = activeSort.value;
  const dir = sortDir.value;
  if (!q) return base.filter((g) => g.items.length).map((g) => ({ ...g, items: sortBy(g.items, sk, dir) }));
  const out: DisplayGroup[] = [];
  for (const g of base) {
    const items = g.items.filter(
      (it) => it.name.toLowerCase().includes(q) || (it.effect ?? "").toLowerCase().includes(q) || it.id.toLowerCase().includes(q),
    );
    if (items.length) out.push({ ...g, items: sortBy(items, sk, dir) });
  }
  return out;
});
const resultCount = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0));

const triggerText = computed(() => {
  if (props.triggerLabel) return props.triggerLabel;
  return itemStore.nameOf(props.modelValue) || "— нет —";
});

function choose(id: string): void {
  if (props.triggerLabel) emit("pick", id);
  else emit("update:modelValue", id);
  open.value = false;
}
function clear(): void {
  emit("update:modelValue", props.nullable ? null : NULL_ID);
  open.value = false;
}
</script>

<template>
  <span class="ip-wrap">
    <el-button class="ip-trigger" size="small" @click="open = true">
      <ItemIcon
        v-if="!triggerLabel && itemStore.nameOf(modelValue)"
        :id="modelValue"
        :cat="itemStore.get(modelValue)?.cat ?? -1"
        :size="18"
        class="ip-trigger-icon"
      />
      <span class="ip-trigger-text" :class="{ empty: !triggerLabel && !itemStore.nameOf(modelValue) }">
        {{ triggerText }}
      </span>
    </el-button>
    <el-button
      v-if="!triggerLabel && nullable && itemStore.nameOf(modelValue)"
      class="ip-clear"
      size="small"
      text
      :icon="CircleClose"
      title="Убрать"
      @click="clear()"
    />

    <el-dialog
      v-model="open"
      :title="title"
      width="540px"
      align-center
      append-to-body
      class="ip-dialog"
    >
      <div class="ip-controls">
        <el-input
          v-model="query"
          placeholder="Поиск по названию или эффекту…"
          size="default"
          clearable
          :prefix-icon="Search"
          class="ip-search"
        />
        <el-select v-model="subFilter" filterable size="default" class="ip-sub" placeholder="Все">
          <el-option label="Все" value="all" />
          <el-option v-for="o in subOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
      <el-segmented v-model="mode" :options="MODE_OPTIONS" size="small" class="ip-modes" />

      <div v-if="itemStore.loading" class="ip-status">Загрузка каталога…</div>
      <div v-else-if="itemStore.error" class="ip-status err">Ошибка: {{ itemStore.error }}</div>
      <div v-else class="ip-list">
        <div v-if="!resultCount" class="ip-status">Ничего не найдено</div>
        <template v-for="g in groups" :key="g.key">
          <PickerSortHeader
            :label="g.label"
            :count="g.items.length"
            :sort-keys="SORT_KEYS"
            :sort-key="sortKey"
            :sort-dir="sortDir"
            @sort="setSort"
          />
          <button
            v-for="it in g.items"
            :key="it.id"
            class="ip-row"
            :class="{ active: it.id === modelValue }"
            type="button"
            :title="it.desc || it.name"
            @click="choose(it.id)"
          >
            <ItemIcon :id="it.id" :cat="it.cat" :size="28" />
            <span class="ip-text">
              <span class="ip-name">{{ it.name || it.id }}</span>
              <span v-if="it.effect" class="ip-effect">{{ it.effect }}</span>
            </span>
            <span v-if="it.gold > 0" class="ip-gold">{{ it.gold }}</span>
          </button>
        </template>
      </div>

      <template #footer>
        <span class="ip-foot">
          <span class="ip-foot-info">{{ resultCount }} предметов</span>
          <el-button v-if="nullable" size="small" @click="clear()">Убрать предмет</el-button>
          <el-button size="small" @click="open = false">Закрыть</el-button>
        </span>
      </template>
    </el-dialog>
  </span>
</template>

<style scoped>
.ip-wrap {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
}
.ip-trigger {
  max-width: 100%;
}
.ip-trigger-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}
.ip-trigger-text.empty {
  color: var(--el-text-color-secondary);
}
.ip-clear {
  flex: 0 0 auto;
  padding: 0 2px;
}
.ip-controls {
  display: flex;
  gap: var(--d2-sp-2);
  margin-bottom: var(--d2-sp-2);
}
.ip-search {
  flex: 1 1 auto;
}
.ip-sub {
  flex: 0 0 190px;
}
.ip-modes {
  width: 100%;
  margin-bottom: var(--d2-sp-2);
}
.ip-list {
  max-height: 52vh;
  overflow-y: auto;
  margin: 0 -8px;
  padding: 0 8px;
}
.ip-status {
  padding: 24px 8px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.ip-status.err {
  color: var(--el-color-danger);
}
.ip-group {
  position: sticky;
  top: 0;
  background: var(--el-bg-color);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--el-text-color-secondary);
  padding: 8px 6px 4px;
  z-index: 1;
}
.ip-count {
  color: var(--el-text-color-placeholder);
  font-weight: 400;
}
.ip-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 7px 8px;
  border-radius: var(--d2-radius-sm, 6px);
  cursor: pointer;
  font: inherit;
  color: var(--el-text-color-primary);
}
.ip-row:hover {
  background: var(--el-fill-color-light);
}
.ip-row.active {
  background: var(--el-color-primary-light-9);
  outline: 1px solid var(--el-color-primary-light-5);
}
.ip-trigger-icon {
  margin-right: 4px;
  vertical-align: -4px;
}
.ip-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.ip-effect {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.ip-gold {
  flex: 0 0 auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-color-warning);
}
.ip-gold::after {
  content: " ⛁";
  opacity: 0.7;
}
.ip-foot {
  display: flex;
  align-items: center;
  gap: var(--d2-sp-2);
}
.ip-foot-info {
  margin-right: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
