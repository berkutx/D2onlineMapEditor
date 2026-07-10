<script setup lang="ts">
/**
 * ModifierListEditor — per-unit modifier list editor (the web take on the game editor's
 * «Доступно | Выбрано» dialog): trigger button «⚙ N» opens a two-pane dialog — left the
 * catalog (search + class groups, the native ScenEdit dialog set pinned first), right the
 * unit's current list (duplicates legal — the .sg MODIF_ID list carries them; order kept).
 * Presentational: v-model only, the parent owns the undoable commit.
 */
import { ref, computed, watch } from "vue";
import { ElButton, ElDialog, ElInput } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import { useModifierStore, type ModifierEntry, type ModifierGroup } from "../stores/modifierStore";

const props = withDefaults(
  defineProps<{
    modelValue: readonly string[];
    /** Dialog headline — say WHOSE modifiers these are («Разбойник — модификаторы»). */
    title?: string;
    /** Compact trigger: icon-only (garrison cells) vs labeled (template rows). */
    compact?: boolean;
    /** Is this unit the stack leader? SOURCE=1 (L_STACK, stack-wide) modifiers are offered
     *  to LEADERS ONLY — the reference UnitEditor's rule («source1 = for leader»). */
    leader?: boolean;
  }>(),
  { title: "Модификаторы юнита", compact: false, leader: false },
);
const emit = defineEmits<{ "update:modelValue": [string[]] }>();

const store = useModifierStore();
const open = ref(false);
const query = ref("");
/** The reference editor offers ONLY the g???um9??? key family (the unit-modifier series,
 *  incl. mod-added G201UM9xxx…) — corpus maps stick to it. Off = the whole Gmodif table. */
const um9Only = ref(true);
const UM9 = /^G\d{3}UM9/i;
watch(open, (v) => {
  if (v) {
    void store.load();
    query.value = "";
  }
});

const groups = computed<ModifierGroup[]>(() => {
  const q = query.value.trim().toLowerCase();
  const out: ModifierGroup[] = [];
  for (const g of store.groups) {
    const mods = g.mods.filter(
      (m) =>
        (!um9Only.value || UM9.test(m.id)) &&
        (props.leader || m.source !== 1) &&
        (!q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)),
    );
    if (mods.length) out.push({ ...g, mods });
  }
  return out;
});
const resultCount = computed(() => groups.value.reduce((n, g) => n + g.mods.length, 0));

function add(id: string): void {
  emit("update:modelValue", [...props.modelValue, id]);
}
function removeAt(i: number): void {
  emit("update:modelValue", props.modelValue.filter((_, k) => k !== i));
}
const tip = (m: ModifierEntry | undefined): string =>
  m ? [m.effects?.join(" · "), m.comment, m.scripted ? "(скрипт)" : ""].filter(Boolean).join("\n") : "";
</script>

<template>
  <span class="ml-wrap">
    <el-button
      class="ml-trigger"
      size="small"
      :text="compact"
      :title="modelValue.length ? `Модификаторы: ${modelValue.length}` : 'Модификаторы юнита'"
      @click="open = true"
    >
      ⚙<template v-if="modelValue.length">&nbsp;{{ modelValue.length }}</template><template v-if="!compact && !modelValue.length">&nbsp;моды</template>
    </el-button>

    <el-dialog v-model="open" :title="title" width="720px" align-center append-to-body class="ml-dialog">
      <div class="ml-panes">
        <div class="ml-avail">
          <div class="ml-pane-head">
            Доступно <span v-if="query" class="ml-count">({{ resultCount }})</span>
            <el-tooltip content="Семейство UM9xxx — юнит-модификаторы, которые предлагает родной редактор игры. Снимите, чтобы видеть ВСЕ модификаторы базы (эффекты предметов/заклинаний)." :show-after="300">
              <label class="ml-um9"><input v-model="um9Only" type="checkbox" /> набор игры</label>
            </el-tooltip>
          </div>
          <el-input v-model="query" placeholder="Поиск по названию…" size="small" clearable :prefix-icon="Search" />
          <div class="ml-list">
            <div v-if="store.loading" class="ml-status">Загрузка каталога…</div>
            <div v-else-if="store.error" class="ml-status err">Ошибка: {{ store.error }}</div>
            <div v-else-if="!resultCount" class="ml-status">Ничего не найдено</div>
            <template v-for="g in groups" :key="g.key">
              <div class="ml-group">{{ g.label }} ({{ g.mods.length }})</div>
              <button v-for="m in g.mods" :key="m.id" type="button" class="ml-row" :title="tip(m)" @click="add(m.id)">
                <span class="ml-name">{{ m.name }}</span>
                <span class="ml-add">＋</span>
              </button>
            </template>
          </div>
        </div>
        <div class="ml-chosen">
          <div class="ml-pane-head">Выбрано ({{ modelValue.length }})</div>
          <div class="ml-list">
            <div v-if="!modelValue.length" class="ml-status">Пусто — кликните модификатор слева</div>
            <div v-for="(id, i) in modelValue" :key="`${id}-${i}`" class="ml-row chosen" :title="tip(store.get(id))">
              <span class="ml-name">{{ store.nameOf(id) }}</span>
              <button type="button" class="ml-del" title="Убрать" @click="removeAt(i)">✕</button>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button size="small" type="primary" @click="open = false">Готово</el-button>
      </template>
    </el-dialog>
  </span>
</template>

<style scoped>
.ml-trigger { padding: 4px 7px; }
.ml-panes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  min-height: 380px;
}
.ml-pane-head {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}
.ml-count { text-transform: none; letter-spacing: 0; }
.ml-um9 {
  float: right;
  text-transform: none;
  letter-spacing: 0;
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}
.ml-avail, .ml-chosen { display: flex; flex-direction: column; min-width: 0; }
.ml-list {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 420px;
  overflow-y: auto;
  margin-top: 6px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--d2-radius, 4px);
  padding: 4px;
}
.ml-group {
  position: sticky;
  top: 0;
  background: var(--el-bg-color);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--el-text-color-placeholder);
  padding: 6px 6px 3px;
}
.ml-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 4px 6px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  color: var(--el-text-color-regular);
}
button.ml-row:hover { background: var(--el-fill-color-light); }
.ml-row.chosen { cursor: default; }
.ml-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ml-add { flex: 0 0 auto; color: var(--el-color-primary); font-size: 13px; }
.ml-del {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  padding: 0 2px;
}
.ml-del:hover { color: var(--el-color-danger); }
.ml-status { padding: 14px 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.ml-status.err { color: var(--el-color-danger); }
</style>
