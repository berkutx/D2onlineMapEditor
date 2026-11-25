<script setup lang="ts">
/**
 * Map restrictions — the rules a map imposes on the game, edited as what they really are:
 * SCENARIO VARIABLES the mod reads by name. The mss32 toolset reads some (building in the
 * capital, hiring, city income, …), each mod's Lua reads its own, so the list comes from the
 * catalog of the map's mod (scenVariables.json). Every control here writes ordinary variables
 * through the same `setVariables` op as the Переменные tab — nothing is stored anywhere else.
 */
import { computed, onMounted, reactive } from "vue";
import { ElSelect, ElOption, ElInputNumber, ElSwitch, ElEmpty, ElScrollbar, ElTag, ElButton, ElMessage } from "element-plus";
import {
  readVariable, setRule, variableForms, writeVariable,
  type ScenVariableDef, type ScenVariableForm, type ScenVariableGroup,
} from "@d2/mod-catalog";
import type { ScenarioVariable } from "@d2/map-schema";
import { CONDITION_BY_KIND, EFFECT_BY_KIND } from "@d2/map-schema";
import { useEventStore } from "../stores/eventStore";
import { useModStore } from "../stores/modStore";

const store = useEventStore();
const mods = useModStore();
onMounted(() => {
  void mods.loadScenVariables();
  void mods.loadProfile();
});

const catalog = computed(() => mods.scenVariables);
const variables = computed<ScenarioVariable[]>(() => store.variables);

/** Variables with fixed names (controls below) and those only known by a name prefix. */
const fixedDefs = computed(() => (catalog.value?.variables ?? []).filter((d) => !d.prefix));
const prefixDefs = computed(() => (catalog.value?.variables ?? []).filter((d) => d.prefix));

/** Groups: several variables that are one rule along an axis, shown as a table of numbers. */
const groups = computed<{ group: ScenVariableGroup; defs: ScenVariableDef[] }[]>(() =>
  (catalog.value?.groups ?? [])
    .map((group) => ({ group, defs: fixedDefs.value.filter((d) => d.group === group.id) }))
    .filter((g) => g.defs.length > 0),
);
const groupIds = computed(() => new Set(groups.value.map((g) => g.group.id)));
/** Rules shown one per card: everything that is not part of a (known) group. */
const singleDefs = computed(() => fixedDefs.value.filter((d) => !d.group || !groupIds.value.has(d.group)));

const RACE_FALLBACK: Record<string, string> = {
  empire: "Империя", clans: "Кланы Гор", legions: "Легионы Проклятых", undead: "Орды Нежити", elves: "Эльфийский Союз",
};
const RACE_SHORT: Record<string, string> = {
  empire: "Империя", clans: "Кланы", legions: "Легионы", undead: "Нежить", elves: "Эльфы",
};
const raceLabel = (race: string | null): string =>
  race === null ? "Все расы" : mods.raceFactsByKey[race]?.name || RACE_FALLBACK[race] || race;

/** Races in the game's own order (the catalog lists them by key); unknown keys go last. */
const RACE_ORDER = ["empire", "legions", "clans", "undead", "elves"];
const raceRank = (race: string | null): number => {
  if (race === null) return -1;
  const i = RACE_ORDER.indexOf(race);
  return i < 0 ? RACE_ORDER.length : i;
};

const formsOf = (def: ScenVariableDef): ScenVariableForm[] =>
  catalog.value ? [...variableForms(catalog.value, def)].sort((a, b) => raceRank(a.race) - raceRank(b.race)) : [];
const valueOf = (name: string): number | null => readVariable(variables.value, name);

/** Ids of variables some event reads or writes — those must not be deleted from under it. */
const usedByEvents = computed<Set<number>>(() => {
  const used = new Set<number>();
  for (const ev of store.events) {
    for (const c of ev.conditions) {
      for (const f of CONDITION_BY_KIND[c.kind]?.fields ?? []) {
        if (f.type === "var") used.add(Number((c as Record<string, unknown>)[f.key] ?? 0));
      }
    }
    for (const e of ev.effects) {
      for (const f of EFFECT_BY_KIND[e.kind]?.fields ?? []) {
        if (f.type === "var") used.add(Number((e as Record<string, unknown>)[f.key] ?? 0));
      }
    }
  }
  return used;
});

/**
 * Set one form of a rule, or with null return it to "no variable". The rule's own logic —
 * what replaces a variable an event still refers to, and the state variables the game keeps
 * for the rule — lives in `setRule`.
 */
function setValue(def: ScenVariableDef, name: string, value: number | null): void {
  if (!catalog.value) return;
  const out = setRule(catalog.value, variables.value, def, name, value, usedByEvents.value);
  if (out.blocked) {
    ElMessage.warning(
      `Переменную ${name} читает или меняет событие, а её отсутствие не заменить числом. ` +
        "Задайте значение или сначала уберите её из событий.",
    );
    return;
  }
  if (out.variables !== variables.value) store.setVariables(out.variables as ScenarioVariable[]);
}

// ----- a rule with ready-made choices ---------------------------------------------------------

interface Choice { key: string; value: number | null; label: string }
const ABSENT = "absent";
const CUSTOM = "custom";
/** Forms whose "Своё значение" was picked by hand: they stay on the number field. */
const customOpen = reactive(new Set<string>());

/**
 * The options of one row. A race row gets "Как у всех рас" for "no variable"; and when the
 * race's variable REPLACES the common one, also the default rule as an explicit choice of its
 * own — `EMPIRE_…=0` is "default rules for the Empire whatever the common rule says".
 */
function choicesOf(def: ScenVariableDef, form: ScenVariableForm): Choice[] {
  const presets = def.presets ?? [];
  const out: Choice[] = [];
  for (const p of presets) {
    if (p.value !== null) {
      out.push({ key: String(p.value), value: p.value, label: p.label });
    } else if (form.race === null) {
      out.push({ key: ABSENT, value: null, label: p.label });
    } else {
      out.push({ key: ABSENT, value: null, label: "Как у всех рас" });
      const dflt = def.absentValue;
      if (def.raceMode === "override" && dflt !== null && !presets.some((q) => q.value === dflt)) {
        out.push({ key: String(dflt), value: dflt, label: p.label });
      }
    }
  }
  out.push({ key: CUSTOM, value: null, label: "Своё значение" });
  return out;
}

/** Which option matches the form's current value ("custom" = none of them). */
function selected(def: ScenVariableDef, form: ScenVariableForm): string {
  const v = valueOf(form.name);
  const list = choicesOf(def, form);
  const hasAbsent = list.some((c) => c.key === ABSENT);
  if (v === null) return hasAbsent ? ABSENT : CUSTOM;
  if (customOpen.has(form.name)) return CUSTOM;
  const hit = list.find((c) => c.key !== CUSTOM && c.value === v);
  if (hit) return hit.key;
  // the absent value is the same rule as no variable — for the plain form, and for a race
  // form that is added to the plain one (never for a race form that overrides it)
  const sameAsAbsent = v === def.absentValue && (form.race === null || def.raceMode === "add");
  return sameAsAbsent && hasAbsent ? ABSENT : CUSTOM;
}

function pick(def: ScenVariableDef, form: ScenVariableForm, key: string): void {
  if (key === CUSTOM) {
    customOpen.add(form.name);
    if (valueOf(form.name) === null) setValue(def, form.name, def.absentValue ?? 0);
    return;
  }
  customOpen.delete(form.name);
  const choice = choicesOf(def, form).find((c) => c.key === key);
  if (choice) setValue(def, form.name, choice.value);
}

// ----- groups: a table of numbers -------------------------------------------------------------

interface Column { race: string | null; prefix: string }
function columnsOf(defs: ScenVariableDef[]): Column[] {
  const cols: Column[] = [{ race: null, prefix: "" }];
  if (defs.some((d) => d.scope === "perRace")) {
    for (const [race, prefix] of Object.entries(catalog.value?.racePrefixes ?? {})) cols.push({ race, prefix });
  }
  cols.sort((a, b) => raceRank(a.race) - raceRank(b.race));
  return cols;
}
/** The variable a cell edits, or null when the definition has no such form. */
const cellName = (def: ScenVariableDef, col: Column): string | null =>
  col.race === null ? def.name : def.scope === "perRace" ? col.prefix + def.name : null;
const columnLabel = (col: Column): string => (col.race === null ? "Все расы" : RACE_SHORT[col.race] || raceLabel(col.race));

/** How many variables of a group the map sets. */
function setCount(defs: ScenVariableDef[]): number {
  let n = 0;
  for (const def of defs) for (const f of formsOf(def)) if (valueOf(f.name) !== null) n += 1;
  return n;
}
/** Groups opened or closed by hand; untouched ones are open exactly when the map uses them. */
const groupOpen = reactive(new Map<string, boolean>());
const isOpen = (id: string, defs: ScenVariableDef[]): boolean => groupOpen.get(id) ?? setCount(defs) > 0;
const toggle = (id: string, defs: ScenVariableDef[]): void => void groupOpen.set(id, !isOpen(id, defs));

// ----- variables known by a name prefix, and the game's own state variables --------------------

/** Map variables that fall under a prefix definition (e.g. every PERK_LVL_*). */
const prefixed = (def: ScenVariableDef): ScenarioVariable[] =>
  variables.value.filter((v) => v.name.startsWith(def.name) && v.name.length > def.name.length);

function setPlain(name: string, value: number): void {
  const out = writeVariable(variables.value, name, value);
  if (out !== variables.value) store.setVariables(out as ScenarioVariable[]);
}

/** "3 из 5" — how many of a rule's state variables the map has. */
const companionsPresent = (def: ScenVariableDef): number =>
  (def.companions ?? []).filter((c) => valueOf(c) !== null).length;

const sourceLabel = (def: ScenVariableDef): string =>
  def.source === "mss32" ? "читает mss32" : `читает скрипт мода${def.origin ? ` (${def.origin})` : ""}`;
</script>

<template>
  <div class="mr-editor">
    <el-scrollbar class="mr-list">
      <el-empty
        v-if="!catalog || (!fixedDefs.length && !prefixDefs.length)"
        description="Для мода этой карты не собран список ограничений"
        :image-size="60"
      />
      <template v-else>
        <p class="mr-intro">
          Правила карты для мода «{{ mods.activeMod?.name ?? mods.activeModId }}». Каждое хранится в карте как
          переменная сценария — их же видно на вкладке
          <el-button link type="primary" size="small" @click="store.navigate({ tab: 'vars' })">Переменные</el-button>.
          Потолки уровней юнитов, заклинаний, лидеров и городов — на вкладке
          <el-button link type="primary" size="small" @click="store.navigate({ tab: 'settings' })">Настройки</el-button>.
        </p>

        <!-- one rule per card -->
        <div v-for="def in singleDefs" :key="def.name" class="mr-card d2-card">
          <div class="mr-title">
            {{ def.title || def.name }}
            <el-tag size="small" effect="plain" class="mr-src">{{ sourceLabel(def) }}</el-tag>
          </div>
          <div v-if="def.description" class="mr-desc">{{ def.description }}</div>

          <div v-for="form in formsOf(def)" :key="form.name" class="mr-row">
            <span class="mr-race">{{ raceLabel(form.race) }}</span>

            <!-- a rule with ready-made choices -->
            <template v-if="def.presets?.length">
              <el-select
                size="small"
                class="mr-select"
                :model-value="selected(def, form)"
                @update:model-value="pick(def, form, $event as string)"
              >
                <el-option v-for="c in choicesOf(def, form)" :key="c.key" :value="c.key" :label="c.label" />
              </el-select>
              <el-input-number
                v-if="selected(def, form) === CUSTOM"
                size="small"
                controls-position="right"
                class="mr-num"
                :model-value="valueOf(form.name) ?? 0"
                @change="setValue(def, form.name, ($event as number | undefined) ?? 0)"
              />
            </template>

            <!-- a plain switch -->
            <template v-else-if="def.kind === 'flag'">
              <el-switch
                size="small"
                :model-value="(valueOf(form.name) ?? 0) !== 0"
                @update:model-value="setValue(def, form.name, $event ? 1 : null)"
              />
            </template>

            <!-- a number -->
            <template v-else>
              <el-switch
                size="small"
                :model-value="valueOf(form.name) !== null"
                @update:model-value="setValue(def, form.name, $event ? (def.absentValue ?? 0) : null)"
              />
              <el-input-number
                v-if="valueOf(form.name) !== null"
                size="small"
                controls-position="right"
                class="mr-num"
                :model-value="valueOf(form.name) ?? 0"
                @change="setValue(def, form.name, ($event as number | undefined) ?? 0)"
              />
            </template>

            <span class="mr-var">{{ form.name }}{{ valueOf(form.name) === null ? "" : ` = ${valueOf(form.name)}` }}</span>
          </div>

          <div v-if="def.companions?.length" class="mr-note">
            Служебные переменные игры ({{ companionsPresent(def) }} из {{ def.companions.length }} на карте):
            <span class="mr-mono">{{ def.companions.join(", ") }}</span>
          </div>
        </div>

        <!-- a group: one rule along an axis, as a table of numbers (empty cell = no variable) -->
        <div v-for="g in groups" :key="g.group.id" class="mr-card d2-card">
          <button type="button" class="mr-title mr-fold" :aria-expanded="isOpen(g.group.id, g.defs)" @click="toggle(g.group.id, g.defs)">
            <span class="mr-caret">{{ isOpen(g.group.id, g.defs) ? "▾" : "▸" }}</span>
            {{ g.group.title }}
            <el-tag size="small" effect="plain" class="mr-src">{{ sourceLabel(g.defs[0]!) }}</el-tag>
            <span class="mr-count">{{ setCount(g.defs) ? `задано: ${setCount(g.defs)}` : "не задано" }}</span>
          </button>
          <template v-if="isOpen(g.group.id, g.defs)">
            <div v-if="g.group.description" class="mr-desc">{{ g.group.description }}</div>
            <table class="mr-table">
              <thead>
                <tr>
                  <th />
                  <th v-for="col in columnsOf(g.defs)" :key="col.race ?? ''" :title="raceLabel(col.race)">{{ columnLabel(col) }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="def in g.defs" :key="def.name">
                  <th scope="row" :title="def.name">{{ def.title || def.name }}</th>
                  <td v-for="col in columnsOf(g.defs)" :key="col.race ?? ''">
                    <el-input-number
                      v-if="cellName(def, col)"
                      size="small"
                      class="mr-cell"
                      :controls="false"
                      placeholder="—"
                      :title="cellName(def, col)!"
                      :model-value="valueOf(cellName(def, col)!) ?? undefined"
                      @change="setValue(def, cellName(def, col)!, ($event as number | null | undefined) ?? null)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>

        <div v-for="def in prefixDefs" :key="def.name" class="mr-card d2-card">
          <div class="mr-title">
            {{ def.title || def.name + "…" }}
            <el-tag size="small" effect="plain" class="mr-src">{{ sourceLabel(def) }}</el-tag>
          </div>
          <div class="mr-desc">
            {{ def.description || `Мод читает переменные, имя которых начинается с ${def.name}.` }}
            Такие переменные добавляются на вкладке «Переменные».
          </div>
          <div v-for="v in prefixed(def)" :key="v.id" class="mr-row">
            <span class="mr-var mr-var-wide">{{ v.name }}</span>
            <el-input-number
              size="small"
              controls-position="right"
              class="mr-num"
              :model-value="v.value"
              @change="setPlain(v.name, ($event as number | undefined) ?? 0)"
            />
          </div>
          <div v-if="!prefixed(def).length" class="mr-none">на этой карте таких переменных нет</div>
        </div>
      </template>
    </el-scrollbar>
  </div>
</template>

<style scoped>
.mr-editor { display: flex; flex-direction: column; height: 100%; font-size: 12px; }
.mr-list { flex: 1; padding: 0 12px; }
.mr-intro { margin: 10px 0 4px; color: var(--el-text-color-secondary); line-height: 1.5; }
.mr-card { margin: 8px 0; }
.mr-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
.mr-fold { width: 100%; padding: 0; border: 0; background: none; color: inherit; font: inherit; font-weight: 600; font-size: 13px; cursor: pointer; text-align: left; }
.mr-fold:focus-visible { outline: 1px solid var(--el-color-primary); outline-offset: 2px; }
.mr-caret { width: 12px; flex: none; color: var(--el-text-color-secondary); }
.mr-count { margin-left: auto; font-weight: 400; font-size: 12px; color: var(--el-text-color-secondary); }
.mr-src { color: var(--el-text-color-secondary); font-weight: 400; }
.mr-desc { margin: 4px 0 8px; color: var(--el-text-color-secondary); line-height: 1.45; }
.mr-row { display: flex; align-items: center; gap: 8px; margin: 5px 0; }
.mr-race { width: 150px; flex: none; }
.mr-select { width: 290px; flex: none; }
.mr-num { width: 110px; flex: none; }
.mr-var { margin-left: auto; font-family: monospace; font-size: 11px; color: var(--el-text-color-secondary); }
.mr-var-wide { margin-left: 0; flex: 1; }
.mr-none { color: var(--el-text-color-secondary); font-style: italic; }
.mr-note { margin-top: 8px; color: var(--el-text-color-secondary); line-height: 1.45; }
.mr-mono { font-family: monospace; font-size: 11px; }
.mr-table { border-collapse: collapse; }
.mr-table th { padding: 2px 6px; font-weight: 400; color: var(--el-text-color-secondary); text-align: center; white-space: nowrap; }
.mr-table th[scope="row"] { text-align: left; color: inherit; padding-left: 0; padding-right: 12px; }
.mr-table td { padding: 2px 3px; }
.mr-cell { width: 76px; }
</style>
