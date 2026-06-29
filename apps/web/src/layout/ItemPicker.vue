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
import { useItemStore, ITEM_CAT_LABELS } from "../stores/itemStore";

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
const catFilter = ref<number | "all">("all");

watch(open, (v) => {
  if (v) {
    void itemStore.load();
    query.value = "";
    catFilter.value = "all";
  }
});

/** The flat, filtered, grouped result. */
const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  const out = [];
  for (const g of itemStore.groups) {
    if (catFilter.value !== "all" && g.cat !== catFilter.value) continue;
    const items = q
      ? g.items.filter((it) => it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q))
      : g.items;
    if (items.length) out.push({ ...g, items });
  }
  return out;
});
const resultCount = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0));

/** Category options for the filter dropdown. */
const catOptions = computed(() =>
  itemStore.groups.map((g) => ({ value: g.cat, label: `${g.label} (${g.items.length})` })),
);

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

function catLabel(catKey: string): string {
  return ITEM_CAT_LABELS[catKey] ?? "";
}
</script>

<template>
  <span class="ip-wrap">
    <el-button class="ip-trigger" size="small" @click="open = true">
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
          placeholder="Поиск по названию…"
          size="default"
          clearable
          :prefix-icon="Search"
          class="ip-search"
        />
        <el-select v-model="catFilter" size="default" class="ip-cat">
          <el-option label="Все категории" value="all" />
          <el-option v-for="c in catOptions" :key="c.value" :label="c.label" :value="c.value" />
        </el-select>
      </div>

      <div v-if="itemStore.loading" class="ip-status">Загрузка каталога…</div>
      <div v-else-if="itemStore.error" class="ip-status err">Ошибка: {{ itemStore.error }}</div>
      <div v-else class="ip-list">
        <div v-if="!resultCount" class="ip-status">Ничего не найдено</div>
        <template v-for="g in groups" :key="g.cat">
          <div class="ip-group">{{ g.label }} <span class="ip-count">{{ g.items.length }}</span></div>
          <button
            v-for="it in g.items"
            :key="it.id"
            class="ip-row"
            :class="{ active: it.id === modelValue }"
            type="button"
            @click="choose(it.id)"
          >
            <span class="ip-dot" :data-cat="it.cat" />
            <span class="ip-name">{{ it.name || it.id }}</span>
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
.ip-cat {
  flex: 0 0 200px;
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
.ip-dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--el-color-info);
}
/* category accents (one per LmagItm enum index) so the eye can sort the list */
.ip-dot[data-cat="0"] { background: #8d99ae; }
.ip-dot[data-cat="1"] { background: #c08457; }
.ip-dot[data-cat="2"] { background: #d1495b; }
.ip-dot[data-cat="3"] { background: #6a994e; }
.ip-dot[data-cat="4"] { background: #4895ef; }
.ip-dot[data-cat="5"] { background: #43aa8b; }
.ip-dot[data-cat="6"] { background: #90be6d; }
.ip-dot[data-cat="7"] { background: #577590; }
.ip-dot[data-cat="8"] { background: #b5838d; }
.ip-dot[data-cat="9"] { background: #9d4edd; }
.ip-dot[data-cat="10"] { background: #f9c74f; }
.ip-dot[data-cat="11"] { background: #4cc9f0; }
.ip-dot[data-cat="12"] { background: #f3722c; }
.ip-dot[data-cat="13"] { background: #adb5bd; }
.ip-dot[data-cat="14"] { background: #b08968; }
.ip-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
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
