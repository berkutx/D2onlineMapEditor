<script setup lang="ts">
/**
 * ModifierListEditor — per-unit modifier list editor (the web take on the game editor's
 * «Доступно | Выбрано» dialog): trigger «⚙ N» opens a two-pane dialog.
 *
 * Left («Доступно»): search + TWO filters — набор (Редактор ★ / Совместимые / Все) и
 * класс эффекта (подгруппа) — over class-grouped rows. Marks: ★ = стандартный набор
 * диалога родного редактора, 🧪 = вне UM9-семейства (модовый/скриптовый — редактор игры
 * такое не предлагает). A row already picked shows its ×N and stays highlighted.
 *
 * Right («Выбрано»): AGGREGATED — one row per modifier with «×N» and −/+/✕ steppers
 * (the on-disk MODIF_ID list legally carries duplicates; we keep them in the model but
 * never show duplicate rows). Order = first-pick order (writers re-sort as needed).
 *
 * SOURCE=1 (L_STACK, stack-wide) modifiers are offered to LEADERS only — the reference
 * UnitEditor's rule. Presentational: v-model only, the parent owns the undoable commit.
 */
import { ref, computed, watch } from "vue";
import { ElButton, ElDialog, ElInput, ElSelect, ElOption, ElSegmented } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import { useModifierStore, type ModifierEntry, type ModifierGroup } from "../stores/modifierStore";
import LuaView from "./LuaView.vue";
import { assetUrl } from "../services/api";

const props = withDefaults(
  defineProps<{
    modelValue: readonly string[];
    /** Dialog headline — say WHOSE modifiers these are («Разбойник — модификаторы»). */
    title?: string;
    /** Compact trigger: icon-only (garrison cells) vs labeled (template rows). */
    compact?: boolean;
    /** Is this unit the stack leader? Gates SOURCE=1 (L_STACK) modifiers. */
    leader?: boolean;
  }>(),
  { title: "Модификаторы юнита", compact: false, leader: false },
);
const emit = defineEmits<{ "update:modelValue": [string[]] }>();

const store = useModifierStore();
const UM9 = /^G\d{3}UM9/i;

const open = ref(false);
const query = ref("");
/** Набор: dialog = только диалог родного редактора; um9 = всё UM9-семейство (default,
 *  правило эталона); all = вся база Gmodif (эффекты предметов/заклинаний). */
const scope = ref<"dialog" | "um9" | "all">("um9");
const SCOPES = [
  { label: "★ Редактор", value: "dialog" },
  { label: "Совместимые", value: "um9" },
  { label: "Все", value: "all" },
];
/** Подгруппа (класс эффекта); "all" = все классы. */
const classFilter = ref<string>("all");

watch(open, (v) => {
  if (v) {
    void store.load();
    query.value = "";
    classFilter.value = "all";
  }
});

const inScope = (m: ModifierEntry): boolean => {
  if (!props.leader && m.source === 1) return false; // L_STACK — только лидеру
  if (scope.value === "dialog") return m.dialog;
  if (scope.value === "um9") return UM9.test(m.id);
  return true;
};

/** Пометки строк: стандарт диалога редактора / вне UM9-семейства. */
const isStandard = (m: ModifierEntry | undefined): boolean => !!m?.dialog;
const isOutside = (m: ModifierEntry | undefined): boolean => !!m && !UM9.test(m.id);

/** Классы, доступные в текущем наборе (для селекта подгрупп), с количеством. */
const classOptions = computed(() => {
  const opts: { value: string; label: string }[] = [{ value: "all", label: "Все классы" }];
  let total = 0;
  for (const g of store.groups) {
    const n = g.mods.filter(inScope).length;
    if (!n) continue;
    total += n;
    opts.push({ value: g.key, label: `${g.label} (${n})` });
  }
  opts[0] = { value: "all", label: `Все классы (${total})` };
  return opts;
});

const groups = computed<ModifierGroup[]>(() => {
  const q = query.value.trim().toLowerCase();
  const out: ModifierGroup[] = [];
  for (const g of store.groups) {
    if (classFilter.value !== "all" && g.key !== classFilter.value) continue;
    const mods = g.mods.filter(
      (m) => inScope(m) && (!q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)),
    );
    if (mods.length) out.push({ ...g, mods });
  }
  return out;
});
const resultCount = computed(() => groups.value.reduce((n, g) => n + g.mods.length, 0));

/** Выбранные СВЁРНУТО: {id, count} в порядке первого добавления (дубли легальны в .sg,
 *  но в UI никогда не рисуются отдельными строками). */
const chosen = computed<{ id: string; count: number }[]>(() => {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const id of props.modelValue) {
    if (!counts.has(id)) order.push(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return order.map((id) => ({ id, count: counts.get(id)! }));
});
const countOf = (id: string): number => chosen.value.find((c) => c.id === id)?.count ?? 0;
const totalPicked = computed(() => props.modelValue.length);

function addOne(id: string): void {
  emit("update:modelValue", [...props.modelValue, id]);
}
function removeOne(id: string): void {
  const arr = props.modelValue.slice();
  const i = arr.lastIndexOf(id);
  if (i >= 0) arr.splice(i, 1);
  emit("update:modelValue", arr);
}
function removeAll(id: string): void {
  emit("update:modelValue", props.modelValue.filter((x) => x !== id));
}

// ── Lua source viewer: a scripted modifier's `.lua` lives on the asset volume (assets/modscripts/,
// the game's Scripts/modifiers tree). Lazy-fetch ONE file on demand + cache; the catalog stays lean.
const codeCache = new Map<string, string>();
const codeOpen = ref(false);
const codeMod = ref<ModifierEntry | null>(null);
const codeText = ref("");
const codeErr = ref("");
const codeLoading = ref(false);
async function viewCode(m: ModifierEntry, ev?: Event): Promise<void> {
  ev?.stopPropagation(); // don't also add/step the modifier
  if (!m.script) return;
  codeMod.value = m;
  codeErr.value = "";
  codeOpen.value = true;
  const cached = codeCache.get(m.script);
  if (cached !== undefined) { codeText.value = cached; return; }
  codeLoading.value = true;
  codeText.value = "";
  try {
    const url = assetUrl("modscripts/" + m.script.split("/").map(encodeURIComponent).join("/"));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const t = await res.text();
    codeCache.set(m.script, t);
    codeText.value = t;
  } catch (e) {
    codeErr.value = `Не удалось загрузить ${m.script}: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    codeLoading.value = false;
  }
}

const tip = (m: ModifierEntry | undefined): string =>
  m
    ? [
        m.id, // уникальный id — для сверки в базе (Gmodif.dbf)
        m.effects?.join(" · "),
        m.comment,
        m.script ? `источник: ${m.script}` : m.scripted ? "(скрипт)" : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";
const markTip = (m: ModifierEntry | undefined): string =>
  isStandard(m)
    ? "Стандартный набор редактора игры"
    : isOutside(m)
      ? "Вне набора редактора — модовый/скриптовый модификатор"
      : "";
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

    <el-dialog v-model="open" :title="title" width="760px" align-center append-to-body class="ml-dialog">
      <div class="ml-controls">
        <el-input v-model="query" class="ml-search" placeholder="Поиск по названию…" size="small" clearable :prefix-icon="Search" />
        <el-select v-model="classFilter" size="small" class="ml-class" filterable>
          <el-option v-for="o in classOptions" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
        <el-segmented v-model="scope" :options="SCOPES" size="small"
          title="★ Редактор — набор диалога родного редактора · Совместимые — всё UM9-семейство · Все — вся база (эффекты предметов/заклинаний)" />
      </div>
      <div class="ml-panes">
        <div class="ml-avail">
          <div class="ml-pane-head">Доступно <span class="ml-count">({{ resultCount }})</span></div>
          <div class="ml-list">
            <div v-if="store.loading" class="ml-status">Загрузка каталога…</div>
            <div v-else-if="store.error" class="ml-status err">Ошибка: {{ store.error }}</div>
            <div v-else-if="!resultCount" class="ml-status">Ничего не найдено — смените набор или подгруппу</div>
            <template v-for="g in groups" :key="g.key">
              <div class="ml-group">{{ g.label }} ({{ g.mods.length }})</div>
              <button v-for="m in g.mods" :key="m.id" type="button" class="ml-row"
                :class="{ picked: countOf(m.id) > 0 }" :title="tip(m)" @click="addOne(m.id)">
                <span class="ml-mark" :title="markTip(m)">{{ isStandard(m) ? "★" : isOutside(m) ? "🧪" : "" }}</span>
                <span class="ml-name">{{ m.name }} <span class="ml-id">{{ m.id }}</span></span>
                <span v-if="m.script" class="ml-code" title="Показать Lua-код модификатора" @click.stop="viewCode(m, $event)">📜</span>
                <span v-if="countOf(m.id)" class="ml-x">×{{ countOf(m.id) }}</span>
                <span class="ml-add">＋</span>
              </button>
            </template>
          </div>
        </div>
        <div class="ml-chosen">
          <div class="ml-pane-head">
            Выбрано <span class="ml-count">({{ chosen.length }}<template v-if="totalPicked !== chosen.length"> · {{ totalPicked }} шт</template>)</span>
          </div>
          <div class="ml-list">
            <div v-if="!chosen.length" class="ml-status">Пусто — кликните модификатор слева</div>
            <div v-for="c in chosen" :key="c.id" class="ml-row chosen" :title="tip(store.get(c.id))">
              <span class="ml-mark" :title="markTip(store.get(c.id))">{{ isStandard(store.get(c.id)) ? "★" : isOutside(store.get(c.id)) ? "🧪" : "" }}</span>
              <span class="ml-name">{{ store.nameOf(c.id) }} <span class="ml-id">{{ c.id }}</span></span>
              <span v-if="store.get(c.id)?.script" class="ml-code" title="Показать Lua-код модификатора" @click.stop="viewCode(store.get(c.id)!, $event)">📜</span>
              <span class="ml-step">
                <button type="button" class="ml-stepbtn" title="Убрать одну" @click="removeOne(c.id)">−</button>
                <span class="ml-x">×{{ c.count }}</span>
                <button type="button" class="ml-stepbtn" title="Добавить ещё одну" @click="addOne(c.id)">＋</button>
              </span>
              <button type="button" class="ml-del" title="Убрать все" @click="removeAll(c.id)">✕</button>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <span class="ml-legend">★ набор редактора игры · 🧪 вне редактора (мод/скрипт)</span>
        <el-button size="small" type="primary" @click="open = false">Готово</el-button>
      </template>
    </el-dialog>

    <!-- Lua source of a scripted modifier — nested dialog, lazy-loaded on 📜 click. -->
    <el-dialog
      v-model="codeOpen"
      :title="codeMod ? `${codeMod.name} — Lua` : 'Lua'"
      width="720px"
      align-center
      append-to-body
      class="ml-code-dialog"
    >
      <div v-if="codeMod" class="ml-code-head">
        <span class="ml-id">{{ codeMod.id }}</span>
        <span class="ml-code-path">{{ codeMod.script }}</span>
      </div>
      <div v-if="codeLoading" class="ml-status">Загрузка кода…</div>
      <div v-else-if="codeErr" class="ml-status err">{{ codeErr }}</div>
      <LuaView v-else :code="codeText" />
    </el-dialog>
  </span>
</template>

<style scoped>
.ml-trigger { padding: 4px 7px; }
.ml-controls {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.ml-search { flex: 1 1 auto; min-width: 0; }
.ml-class { flex: 0 0 190px; }
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
.ml-avail, .ml-chosen { display: flex; flex-direction: column; min-width: 0; }
.ml-list {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 430px;
  overflow-y: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--d2-radius, 4px);
  padding: 4px;
}
.ml-group {
  position: sticky;
  top: 0;
  z-index: 1;
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
.ml-row.picked { background: var(--el-color-primary-light-9); }
.ml-row.chosen { cursor: default; }
.ml-row.chosen:hover { background: var(--el-fill-color-lighter); }
.ml-mark {
  flex: 0 0 14px;
  text-align: center;
  font-size: 11px;
  opacity: 0.85;
}
.ml-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* уникальный id — приглушённо, моноширинно; сверить в базе / развести дубли по имени */
.ml-id {
  font-family: var(--el-font-family-mono, ui-monospace, monospace);
  font-size: 10px;
  color: var(--el-text-color-placeholder);
  margin-left: 4px;
}
.ml-x {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--el-color-primary);
  font-variant-numeric: tabular-nums;
  min-width: 24px;
  text-align: center;
}
.ml-add { flex: 0 0 auto; color: var(--el-color-primary); font-size: 13px; }
.ml-step {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.ml-stepbtn {
  border: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-blank);
  border-radius: 3px;
  width: 20px;
  height: 20px;
  line-height: 1;
  cursor: pointer;
  color: var(--el-text-color-regular);
  font-size: 13px;
}
.ml-stepbtn:hover { border-color: var(--el-color-primary); color: var(--el-color-primary); }
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
/* 📜 — reveal the modifier's Lua source (only shown for scripted modifiers). */
.ml-code {
  flex: 0 0 auto;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.6;
  padding: 0 2px;
  line-height: 1;
}
.ml-code:hover { opacity: 1; }
.ml-code-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.ml-code-path {
  font-family: var(--el-font-family-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}
.ml-legend {
  float: left;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
</style>
