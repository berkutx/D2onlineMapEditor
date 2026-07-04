<script setup lang="ts">
/**
 * UnitPicker — a reusable, searchable, grouped unit chooser (the unitCatalog).
 * Two modes (mirrors ItemPicker):
 *   - value mode  (v-model)        : a single garrison cell. The trigger shows the current
 *                                    unit's portrait + name; picking replaces it; clearable.
 *   - add mode    (:trigger-label) : an "add to list" button; picking emits `pick` only.
 * Group toggle: subrace / category / level / А-Я, with a subcategory combobox + text search.
 * Trackpad-friendly: a modal dialog with big rows, no hover-only affordances.
 */
import { ref, computed, watch } from "vue";
import { Search, CircleClose } from "@element-plus/icons-vue";
import { useUnitStore, roleLabel, type UnitEntry, type UnitGroup } from "../stores/unitStore";
import UnitIcon from "./UnitIcon.vue";
import PickerSortHeader from "./PickerSortHeader.vue";
import { sortBy, nextSort, type SortKey } from "./pickerSort";

/** Sort keys for the per-group sort control (shown in every subcategory header). */
const SORT_KEYS: SortKey<UnitEntry>[] = [
  { key: "name", label: "А-Я", get: (u) => u.name },
  { key: "level", label: "ур.", get: (u) => u.level, desc: true },
  { key: "hp", label: "HP", get: (u) => u.hp, desc: true },
  { key: "armor", label: "бр.", get: (u) => u.armor, desc: true },
  { key: "leadership", label: "лид.", get: (u) => u.leadership, desc: true },
];

const props = withDefaults(
  defineProps<{
    modelValue?: string | null;
    nullable?: boolean;
    title?: string;
    triggerLabel?: string;
    /**
     * Category roster (mirrors the reference editor's UnitSelectModel.leader filter):
     *   leaders  — ONLY L_LEADER + L_NOBLE (герои и воры) — the stack-leader pick;
     *   soldiers — everything EXCEPT leaders and summons/illusions (the Qt default
     *              showSummons=false; guardians pass, matching shipped maps);
     *   all      — unfiltered (city/ruin stocks, mercenaries).
     * Byte-verified: 14459 stack + 3333 template leaders across 134 shipped maps are
     * 100% L_LEADER/L_NOBLE — nothing else ever leads.
     */
    roster?: "leaders" | "soldiers" | "all";
  }>(),
  { modelValue: null, nullable: false, title: "Выбор юнита", triggerLabel: "", roster: "all" },
);
const emit = defineEmits<{
  "update:modelValue": [string | null];
  pick: [string];
}>();

const unitStore = useUnitStore();
const NULL_ID = "G000000000";

const open = ref(false);
const query = ref("");
type Mode = "subrace" | "cat" | "level" | "alpha";
const mode = ref<Mode>("subrace");
const subFilter = ref<string>("all");
const MODE_OPTIONS = [
  { label: "Раса", value: "subrace" },
  { label: "Тип", value: "cat" },
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
    void unitStore.load();
    query.value = "";
    mode.value = "subrace";
    subFilter.value = "all";
    sortKey.value = "level";
    sortDir.value = 1;
  }
});
watch(mode, () => { subFilter.value = "all"; });

interface DisplayGroup { key: string; label: string; units: UnitEntry[] }

/** Может ли юнит ВЕСТИ отряд (LEADER_ID): только герои и воры (L_LEADER/L_NOBLE). */
const isLeaderUnit = (u: UnitEntry): boolean => u.catKey === "L_LEADER" || u.catKey === "L_NOBLE";
const inRoster = (u: UnitEntry): boolean => {
  if (props.roster === "leaders") return isLeaderUnit(u);
  if (props.roster === "soldiers")
    return !isLeaderUnit(u) && u.catKey !== "L_SUMMON" && u.catKey !== "L_ILLUSION";
  return true;
};

const baseGroups = computed<DisplayGroup[]>(() => {
  let g: UnitGroup[];
  if (mode.value === "cat") g = unitStore.byCat;
  else if (mode.value === "level") g = unitStore.byLevel;
  else if (mode.value === "alpha") {
    const units = unitStore.all.filter(inRoster).sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return [{ key: "all", label: "Все юниты", units }];
  } else g = unitStore.bySubrace;
  return g
    .map((x) => ({ key: x.key, label: x.label, units: x.units.filter(inRoster) }))
    .filter((x) => x.units.length);
});

const subOptions = computed(() => baseGroups.value.map((g) => ({ value: g.key, label: `${g.label} (${g.units.length})` })));

const groups = computed<DisplayGroup[]>(() => {
  const q = query.value.trim().toLowerCase();
  let base = baseGroups.value;
  if (subFilter.value !== "all") base = base.filter((g) => g.key === subFilter.value);
  const sk = activeSort.value;
  const dir = sortDir.value;
  if (!q) return base.filter((g) => g.units.length).map((g) => ({ ...g, units: sortBy(g.units, sk, dir) }));
  const out: DisplayGroup[] = [];
  for (const g of base) {
    const units = g.units.filter(
      (u) => u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q) || u.race.toLowerCase().includes(q),
    );
    if (units.length) out.push({ ...g, units: sortBy(units, sk, dir) });
  }
  return out;
});
const resultCount = computed(() => groups.value.reduce((n, g) => n + g.units.length, 0));

const triggerText = computed(() => {
  if (props.triggerLabel) return props.triggerLabel;
  return unitStore.nameOf(props.modelValue) || "— пусто —";
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
  <span class="up-wrap">
    <el-button class="up-trigger" size="small" @click="open = true">
      <UnitIcon
        v-if="!triggerLabel && unitStore.nameOf(modelValue)"
        :id="modelValue"
        :level="unitStore.get(modelValue)?.level"
        :subrace-id="unitStore.get(modelValue)?.subraceId ?? -1"
        :size="18"
        class="up-trigger-icon"
      />
      <span class="up-trigger-text" :class="{ empty: !triggerLabel && !unitStore.nameOf(modelValue) }">
        {{ triggerText }}
      </span>
    </el-button>
    <el-button
      v-if="!triggerLabel && nullable && unitStore.nameOf(modelValue)"
      class="up-clear"
      size="small"
      text
      :icon="CircleClose"
      title="Убрать"
      @click="clear()"
    />

    <el-dialog v-model="open" :title="title" width="560px" align-center append-to-body class="up-dialog">
      <div class="up-controls">
        <el-input v-model="query" placeholder="Поиск по имени или расе…" size="default" clearable :prefix-icon="Search" class="up-search" />
        <el-select v-model="subFilter" filterable size="default" class="up-sub" placeholder="Все">
          <el-option label="Все" value="all" />
          <el-option v-for="o in subOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
      <el-segmented v-model="mode" :options="MODE_OPTIONS" size="small" class="up-modes" />

      <div v-if="unitStore.loading" class="up-status">Загрузка каталога…</div>
      <div v-else-if="unitStore.error" class="up-status err">Ошибка: {{ unitStore.error }}</div>
      <div v-else class="up-list">
        <div v-if="!resultCount" class="up-status">Ничего не найдено</div>
        <template v-for="g in groups" :key="g.key">
          <PickerSortHeader
            :label="g.label"
            :count="g.units.length"
            :sort-keys="SORT_KEYS"
            :sort-key="sortKey"
            :sort-dir="sortDir"
            @sort="setSort"
          />
          <button
            v-for="u in g.units"
            :key="u.id"
            class="up-row"
            :class="{ active: u.id === modelValue }"
            type="button"
            :title="u.desc || u.name"
            @click="choose(u.id)"
          >
            <UnitIcon :id="u.id" :level="u.level" :subrace-id="u.subraceId" :size="30" />
            <span class="up-text">
              <span class="up-name">{{ u.name || u.id }}</span>
              <span class="up-meta">
                {{ u.race }}<template v-if="roleLabel(u.catKey)"> · {{ roleLabel(u.catKey) }}</template>
                · ур.{{ u.level }} · {{ u.hp }} HP · бр.{{ u.armor }}<template v-if="u.leadership"> · лид.{{ u.leadership }}</template>
              </span>
            </span>
          </button>
        </template>
      </div>

      <template #footer>
        <span class="up-foot">
          <span class="up-foot-info">{{ resultCount }} юнитов</span>
          <el-button v-if="nullable" size="small" @click="clear()">Очистить клетку</el-button>
          <el-button size="small" @click="open = false">Закрыть</el-button>
        </span>
      </template>
    </el-dialog>
  </span>
</template>

<style scoped>
.up-wrap { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; }
.up-trigger { max-width: 100%; }
.up-trigger-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
.up-trigger-text.empty { color: var(--el-text-color-secondary); }
.up-trigger-icon { margin-right: 4px; vertical-align: -4px; }
.up-clear { flex: 0 0 auto; padding: 0 2px; }
.up-controls { display: flex; gap: var(--d2-sp-2); margin-bottom: var(--d2-sp-2); }
.up-search { flex: 1 1 auto; }
.up-sub { flex: 0 0 200px; }
.up-modes { width: 100%; margin-bottom: var(--d2-sp-2); }
.up-list { max-height: 52vh; overflow-y: auto; margin: 0 -8px; padding: 0 8px; }
.up-status { padding: 24px 8px; text-align: center; color: var(--el-text-color-secondary); font-size: 13px; }
.up-status.err { color: var(--el-color-danger); }
.up-group {
  position: sticky; top: 0; background: var(--el-bg-color);
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--el-text-color-secondary); padding: 8px 6px 4px; z-index: 1;
}
.up-count { color: var(--el-text-color-placeholder); font-weight: 400; }
.up-row {
  display: flex; align-items: center; gap: 8px; width: 100%; border: none; background: transparent;
  text-align: left; padding: 6px 8px; border-radius: var(--d2-radius-sm, 6px); cursor: pointer;
  font: inherit; color: var(--el-text-color-primary);
}
.up-row:hover { background: var(--el-fill-color-light); }
.up-row.active { background: var(--el-color-primary-light-9); outline: 1px solid var(--el-color-primary-light-5); }
.up-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.up-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.up-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--el-text-color-secondary); }
.up-foot { display: flex; align-items: center; gap: var(--d2-sp-2); }
.up-foot-info { margin-right: auto; font-size: 12px; color: var(--el-text-color-secondary); }
</style>
