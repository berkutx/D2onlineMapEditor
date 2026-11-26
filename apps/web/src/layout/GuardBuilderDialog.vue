<script setup lang="ts">
/**
 * «Охрана по бюджету»: a stack composed out of the mod's units for a wanted strength, and loot
 * out of its items for a wanted value. The window only PROPOSES — the settings on the left, the
 * variant it gives on the right, another variant at a click; nothing touches the map until
 * «Применить».
 *
 * It serves four things (`kind`): a party on the map, the defense of a city and the guards of a
 * ruin (both with nobody leading: soldiers only), and a party template of the scenario (levels
 * only, nothing to carry). A ruin's loot is its reward: one item and gold.
 *
 * A variant is a number: the same number with the same settings is the same guard, so ◀ goes
 * back to the one just seen. The window opens on a random number, or a mapmaker with unchanged
 * settings would be offered the same stack for every guard post.
 */
import { computed, reactive, ref, watch } from "vue";
import { ElAlert, ElButton, ElCheckbox, ElCheckboxGroup, ElDialog, ElInputNumber, ElOption, ElSelect, ElTag } from "element-plus";
import { Close } from "@element-plus/icons-vue";
import {
  composeGuard,
  composeLoot,
  composeRuinReward,
  guardBudgetRange,
  GUARD_ROLES,
  LOOT_SPECIAL_CATS,
  type GuardMember,
  type GuardRole,
} from "@d2/map-edit";
import { useUnitStore } from "../stores/unitStore";
import { useItemStore } from "../stores/itemStore";
import { useSpriteStore } from "../stores/spriteStore";
import {
  GUARD_PRESETS, GUARD_SCALE_MAX, GUARD_SCALE_MIN, loadGuardSettings, saveGuardSettings, scaledPreset,
  type GuardApply, type GuardKind,
} from "../services/guardSettings";
import UnitIcon from "./UnitIcon.vue";
import ItemIcon from "./ItemIcon.vue";
import { tr, trn, intlLocale } from "../i18n";

const props = withDefaults(defineProps<{
  modelValue: boolean;
  /** what is being composed (see GuardKind) */
  kind?: GuardKind;
  /** the unit leading the stack now (it may be kept), if the stack has one */
  currentLeader?: string | null;
  /** how many things are there now and will be replaced when loot is asked for: the items a
   *  party or a city holds; for a ruin — 1 when it has a reward */
  carried?: number;
  /** the stack stands on water */
  onWater?: boolean;
}>(), { kind: "stack", currentLeader: null, carried: 0, onWater: false });
const emit = defineEmits<{ "update:modelValue": [value: boolean]; apply: [payload: GuardApply] }>();

const unitStore = useUnitStore();
const itemStore = useItemStore();
const spriteStore = useSpriteStore();

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});

const s = reactive(loadGuardSettings());
watch(s, () => saveGuardSettings({ ...s, roles: [...s.roles], lootCats: [...s.lootCats] }), { deep: true });

/** nobody leads: the defense of a city, the guards of a ruin */
const leaderless = computed(() => props.kind === "garrison" || props.kind === "ruin");
/** a template stores neither hit points nor things to carry */
const isTemplate = computed(() => props.kind === "template");
const isRuin = computed(() => props.kind === "ruin");

const variant = ref(1);
const lootVariant = ref(1);
/** units the mapmaker struck out of the offers — for this opening of the window */
const struck = ref<string[]>([]);
const randomVariant = (): number => 1 + Math.floor(Math.random() * 900);

/**
 * Leaders the mod has no map figure for. A stack is drawn as its leader's figure, so one led by
 * such a unit would stand on the map invisible — they are never offered. (Soldiers have no
 * figures at all, which is why only a leader can head a stack.)
 */
const figureless = ref<string[]>([]);
watch(
  () => [props.modelValue, unitStore.loaded] as const,
  async ([open, loaded]) => {
    if (!open || !loaded) return;
    const leaders = unitStore.all.filter((u) => u.catKey === "L_LEADER");
    try {
      const known = await spriteStore.known(leaders.map((u) => `${u.id}STOP0`));
      figureless.value = leaders.filter((u) => !known.has(`${u.id}STOP0`)).map((u) => u.id);
    } catch {
      figureless.value = []; // no manifest: nothing to go by, offer everybody
    }
  },
  { immediate: true },
);
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    void unitStore.load();
    void itemStore.load();
    variant.value = randomVariant();
    lootVariant.value = randomVariant();
    struck.value = [];
  },
  { immediate: true },
);

const num = (n: number): string => n.toLocaleString(intlLocale());

// ───────── the stack

const ROLE_LABELS: Record<GuardRole, string> = {
  fighter: tr("Бойцы"),
  archer: tr("Стрелки"),
  mage: tr("Маги"),
  support: tr("Поддержка"),
};
const ROLE_ONE: Record<GuardRole, string> = {
  fighter: tr("Боец"),
  archer: tr("Стрелок"),
  mage: tr("Маг"),
  support: tr("Поддержка"),
};
const ROLE_HINTS: Record<GuardRole, string> = {
  fighter: tr("Бьют только соседа — стоят в переднем ряду."),
  archer: tr("Бьют издалека по одной цели — стоят сзади."),
  mage: tr("Бьют издалека по нескольким целям сразу — стоят сзади."),
  support: tr("Лечат, усиливают или призывают — стоят сзади."),
};
const PRESET_LABELS = [tr("Слабый"), tr("Средний"), tr("Сильный"), tr("Грозный")];
/** the ready-made strengths with the mapmaker's coefficient applied */
/** the coefficient as a number to multiply by (the field is empty while it is being retyped) */
const scale = computed(() => (Number.isFinite(s.scale) && s.scale > 0 ? s.scale : 1));
const presets = computed(() => GUARD_PRESETS.map((p) => scaledPreset(p, scale.value)));
// a strength that was one of the ready-made ones stays that one when the coefficient changes
watch(
  scale,
  (now, was) => {
    const i = GUARD_PRESETS.findIndex((p) => scaledPreset(p, was) === s.budget);
    if (i >= 0) s.budget = scaledPreset(GUARD_PRESETS[i] as number, now);
  },
);

/** A catalogue built before the strength fields existed has nobody the composer can take. */
const hasStrength = computed(() => unitStore.all.some((u) => (u.xp ?? 0) > 0));

const keptLeader = computed(() => (!leaderless.value && props.currentLeader && unitStore.isLeaderCategory(props.currentLeader) ? props.currentLeader : null));
const keeping = computed(() => (s.keepLeader && keptLeader.value ? keptLeader.value : undefined));

/** Subraces that can field a guard at all (have somebody to lead one). */
const subraceOptions = computed(() =>
  unitStore.bySubrace
    .map((g) => ({ id: g.units[0]?.subraceId ?? -1, label: g.label }))
    .filter((o) => o.id >= 0 && guardBudgetRange(unitStore.all, { subrace: o.id, onWater: props.onWater, leaderless: leaderless.value }) !== null),
);
/** the stored subrace may belong to another mod: fall back to "one per stack" */
const subrace = computed<"one" | "mixed" | number>(() =>
  typeof s.subrace === "number" && !subraceOptions.value.some((o) => o.id === s.subrace) ? "one" : s.subrace,
);
watch([subrace, () => unitStore.loaded], () => {
  if (unitStore.loaded && s.subrace !== subrace.value) s.subrace = subrace.value; // so the list shows what is used
});
const levelCap = computed(() => Math.max(1, unitStore.levelCap));

const guardOptions = computed(() => ({
  subrace: subrace.value,
  roles: s.roles,
  onWater: props.onWater,
  maxUnits: s.maxUnits,
  level: s.levelOn ? Math.min(s.level, levelCap.value) : undefined,
  leader: keeping.value,
  exclude: leaderless.value ? struck.value : [...struck.value, ...figureless.value],
  leaderless: leaderless.value,
}));
const guard = computed(() =>
  props.modelValue && unitStore.loaded && hasStrength.value
    ? composeGuard(unitStore.all, { ...guardOptions.value, budget: s.budget, seed: variant.value })
    : null,
);
const range = computed(() => (unitStore.loaded ? guardBudgetRange(unitStore.all, guardOptions.value) : null));

/** the formation as rows of the picture: back cell on the left, front on the right, a big unit across */
interface Slot { cell: number; member: GuardMember | null; wide: boolean }
const rows = computed<Slot[][]>(() => {
  const cells = guard.value?.cells ?? [null, null, null, null, null, null];
  const out: Slot[][] = [];
  for (let r = 0; r < 3; r++) {
    const front = cells[2 * r] ?? null, back = cells[2 * r + 1] ?? null;
    if (front && front === back) out.push([{ cell: 2 * r, member: front, wide: true }]);
    else out.push([{ cell: 2 * r + 1, member: back, wide: false }, { cell: 2 * r, member: front, wide: false }]);
  }
  return out;
});
const isLeader = (slot: Slot): boolean => !!guard.value && !!slot.member && guard.value.cells[guard.value.leaderCell] === slot.member;
const subraceNames = computed(() =>
  (guard.value?.subraces ?? []).map((id) => unitStore.bySubrace.find((g) => g.units[0]?.subraceId === id)?.label ?? String(id)).join(", "),
);
function strike(id: string): void {
  if (!struck.value.includes(id)) struck.value = [...struck.value, id];
}
function unstrike(id: string): void {
  struck.value = struck.value.filter((x) => x !== id);
}

// ───────── the loot

const lootCatOptions = computed(() => itemStore.groups.map((g) => ({ key: g.catKey || String(g.cat), label: g.label })));
const lootWanted = computed(() => props.modelValue && s.lootOn && !isTemplate.value && itemStore.loaded);
const loot = computed(() =>
  lootWanted.value && !isRuin.value
    ? composeLoot(itemStore.all, { budget: s.lootBudget, seed: lootVariant.value, cats: s.lootCats, maxItems: s.lootMax })
    : null,
);
/** a ruin gives one item and gold: the value is split between them */
const ruinReward = computed(() =>
  lootWanted.value && isRuin.value
    ? composeRuinReward(itemStore.all, { budget: s.lootBudget, seed: lootVariant.value, cats: s.lootCats })
    : null,
);

/** the words that differ with what is being composed */
const WORDS = computed(() => {
  switch (props.kind) {
    case "garrison":
      return {
        lead: tr("Соберу оборону города из солдат мода на заданную силу и добычу на заданную стоимость. Лидера в гарнизоне нет — он и не нужен."),
        section: tr("Оборона города"),
        apply: tr("Применить к обороне"),
      };
    case "ruin":
      return {
        lead: tr("Соберу стражей руины из солдат мода на заданную силу и награду — предмет и золото — на заданную стоимость. Лидера у стражей нет."),
        section: tr("Стражи руины"),
        apply: tr("Применить к руине"),
      };
    case "template":
      return {
        lead: tr("Соберу состав шаблона из юнитов мода на заданную силу. Здоровье и снаряжение в шаблоне не задаются — только юниты и их уровни."),
        section: tr("Состав шаблона"),
        apply: tr("Применить к шаблону"),
      };
    default:
      return {
        lead: tr("Соберу отряд из юнитов мода на заданную силу и добычу на заданную стоимость."),
        section: tr("Отряд"),
        apply: tr("Применить к отряду"),
      };
  }
});
const specialNote = computed(() => {
  const label = lootCatOptions.value.find((o) => LOOT_SPECIAL_CATS.includes(o.key))?.label;
  return label ? tr("Все виды, кроме «{special}»", { special: label }) : tr("Все виды предметов");
});

function apply(): void {
  if (!guard.value) return;
  const r = ruinReward.value;
  emit("apply", {
    cells: guard.value.cells,
    leaderCell: guard.value.leaderCell,
    loot: r ? (r.item ? [r.item] : []) : loot.value ? loot.value.items : null,
    gold: r ? r.gold : null,
  });
  visible.value = false;
}
</script>

<template>
  <el-dialog v-model="visible" :title="tr('Охрана по бюджету')" width="min(940px, 96vw)" top="5vh" class="guard-dialog" append-to-body>
    <p class="gb-lead">
      {{ WORDS.lead }}
      {{ tr("Сила — опыт, который даёт победа над отрядом: так игра сама меряет юнитов. Не тот вариант — листайте дальше.") }}
    </p>
    <el-alert v-if="unitStore.loaded && !hasStrength" type="warning" :closable="false" show-icon
      :title="tr('В каталоге юнитов этого мода нет силы юнитов')"
      :description="tr('Каталог собран старой версией сборщика. Пересоберите мод (tools/asset-pipeline/build_mod.py) — и окно заработает.')" />

    <div v-else class="gb-body">
      <!-- settings -->
      <div class="gb-settings">
        <div class="gb-h">{{ WORDS.section }}</div>
        <div class="gb-row">
          <label>{{ tr("Сила") }}</label>
          <div class="gb-field">
            <el-input-number v-model="s.budget" :min="1" :max="99999" :step="50" size="small" controls-position="right" :aria-label="tr('Сила отряда')" />
            <div class="gb-presets">
              <button v-for="(p, i) in presets" :key="i" type="button" class="gb-chip" :class="{ on: s.budget === p }" @click="s.budget = p">
                {{ PRESET_LABELS[i] }} · {{ p }}
              </button>
            </div>
            <div class="gb-inline gb-scale" :title="tr('На коэффициент умножаются готовые значения силы. Он запоминается: поставьте 1,5 для карты потруднее — и «Средний» везде будет в полтора раза сильнее.')">
              <span>{{ tr("Коэффициент") }} ×</span>
              <el-input-number v-model="s.scale" :min="GUARD_SCALE_MIN" :max="GUARD_SCALE_MAX" :step="0.1" :precision="2" size="small" controls-position="right" class="gb-short"
                :aria-label="tr('Коэффициент готовых значений силы')" />
              <button v-if="s.scale !== 1" type="button" class="gb-chip" @click="s.scale = 1">{{ tr("сбросить") }}</button>
            </div>
            <div class="gb-note">{{ tr("В готовых картах примерно половина отрядов слабее 450, девять из десяти — слабее 1500.") }}</div>
          </div>
        </div>
        <div class="gb-row">
          <label>{{ tr("Раса") }}</label>
          <div class="gb-field">
            <el-select v-model="s.subrace" size="small" class="gb-wide" :aria-label="tr('Раса отряда')">
              <el-option :label="tr('Одна раса на отряд, любая')" value="one" />
              <el-option :label="tr('Любые юниты вперемешку')" value="mixed" />
              <el-option v-for="o in subraceOptions" :key="o.id" :label="o.label" :value="o.id" />
            </el-select>
          </div>
        </div>
        <div class="gb-row">
          <label>{{ tr("Кого брать") }}</label>
          <div class="gb-field">
            <el-checkbox-group v-model="s.roles" size="small" :min="1">
              <el-checkbox v-for="role in GUARD_ROLES" :key="role" :value="role" :title="ROLE_HINTS[role]">{{ ROLE_LABELS[role] }}</el-checkbox>
            </el-checkbox-group>
            <div class="gb-note">{{ tr("Бойцы встают в передний ряд, остальные — сзади. Если юнитов двое и больше, в каждом ряду кто-то будет.") }}</div>
          </div>
        </div>
        <div class="gb-row">
          <label>{{ tr("Юнитов") }}</label>
          <div class="gb-field gb-inline">
            <span>{{ tr("не больше") }}</span>
            <el-input-number v-model="s.maxUnits" :min="1" :max="6" size="small" controls-position="right" class="gb-short" :aria-label="tr('Юнитов в отряде, не больше')" />
          </div>
        </div>
        <div class="gb-row">
          <label>{{ tr("Уровень") }}</label>
          <div class="gb-field gb-inline">
            <el-checkbox v-model="s.levelOn" size="small">{{ tr("поднять всех до") }}</el-checkbox>
            <el-input-number v-model="s.level" :min="1" :max="levelCap" :disabled="!s.levelOn" size="small" controls-position="right" class="gb-short" :aria-label="tr('Уровень юнитов')" />
          </div>
        </div>
        <div v-if="s.levelOn" class="gb-note gb-indent">{{ tr("Юнит выше этого уровня остаётся на своём. Здоровье и сила считаются уже для нового уровня.") }}</div>
        <div v-if="keptLeader" class="gb-row">
          <label>{{ tr("Лидер") }}</label>
          <div class="gb-field">
            <el-checkbox v-model="s.keepLeader" size="small">{{ tr("оставить нынешнего: {name}", { name: unitStore.nameOf(keptLeader) }) }}</el-checkbox>
          </div>
        </div>

        <template v-if="!isTemplate">
        <div class="gb-h gb-h2">{{ isRuin ? tr("Награда") : tr("Добыча") }}</div>
        <div class="gb-row">
          <label>{{ tr("Стоимость") }}</label>
          <div class="gb-field gb-inline">
            <el-checkbox v-model="s.lootOn" size="small">{{ isRuin ? tr("предмет и золото на") : tr("положить предметов на") }}</el-checkbox>
            <el-input-number v-model="s.lootBudget" :min="1" :max="999999" :step="100" :disabled="!s.lootOn" size="small" controls-position="right" :aria-label="tr('Стоимость добычи, золото')" />
            <span>{{ tr("золота") }}</span>
          </div>
        </div>
        <template v-if="s.lootOn">
          <div class="gb-row">
            <label>{{ tr("Что класть") }}</label>
            <div class="gb-field">
              <el-select v-model="s.lootCats" multiple collapse-tags collapse-tags-tooltip clearable size="small" class="gb-wide" :placeholder="specialNote" :aria-label="tr('Виды предметов')">
                <el-option v-for="o in lootCatOptions" :key="o.key" :label="o.label" :value="o.key" />
              </el-select>
            </div>
          </div>
          <div v-if="!isRuin" class="gb-row">
            <label>{{ tr("Предметов") }}</label>
            <div class="gb-field gb-inline">
              <span>{{ tr("не больше") }}</span>
              <el-input-number v-model="s.lootMax" :min="1" :max="12" size="small" controls-position="right" class="gb-short" :aria-label="tr('Предметов, не больше')" />
            </div>
          </div>
          <div v-if="carried" class="gb-note gb-indent gb-warn">
            <template v-if="isRuin">{{ tr("Нынешняя награда руины — предмет и золото — будет заменена; мана останется как есть.") }}</template>
            <template v-else-if="kind === 'garrison'">{{ trn("В городе уже лежит {n} предмет — он будет заменён.|В городе уже лежит {n} предмета — они будут заменены.|В городе уже лежит {n} предметов — они будут заменены.", carried) }}</template>
            <template v-else>{{ trn("Отряд уже несёт {n} предмет — он будет заменён.|Отряд уже несёт {n} предмета — они будут заменены.|Отряд уже несёт {n} предметов — они будут заменены.", carried) }}</template>
          </div>
        </template>
        </template>
      </div>

      <!-- the variant -->
      <div class="gb-result">
        <div class="gb-bar">
          <span class="gb-variant">{{ tr("Вариант {n}", { n: variant }) }}</span>
          <el-button size="small" :disabled="variant <= 1" :title="tr('Предыдущий вариант')" :aria-label="tr('Предыдущий вариант')" @click="variant--">◀</el-button>
          <el-button size="small" type="primary" @click="variant++">{{ tr("Другой вариант") }} ▶</el-button>
        </div>

        <template v-if="guard">
          <div class="gb-cols" aria-hidden="true"><span>{{ tr("Тыл") }}</span><span>{{ tr("Фронт") }}</span></div>
          <div class="gb-grid">
            <template v-for="(row, r) in rows" :key="r">
              <div v-for="slot in row" :key="slot.cell" class="gb-cell" :class="{ wide: slot.wide, filled: !!slot.member, leader: isLeader(slot) }">
                <template v-if="slot.member">
                  <span class="gb-portrait">
                    <UnitIcon :id="slot.member.unit" :level="slot.member.level" :subrace-id="unitStore.get(slot.member.unit)?.subraceId ?? -1" :size="36" />
                    <span v-if="isLeader(slot)" class="gb-star" :title="tr('Лидер')">★</span>
                  </span>
                  <span class="gb-text">
                    <span class="gb-name" :title="unitStore.nameOf(slot.member.unit)">{{ unitStore.nameOf(slot.member.unit) }}</span>
                    <span class="gb-stats">{{ tr("Ур. {level}", { level: slot.member.level }) }}<template v-if="!isTemplate"> · {{ tr("{hp} HP", { hp: slot.member.hp }) }}</template> · {{ tr("сила {xp}", { xp: slot.member.xp }) }}</span>
                    <span class="gb-tags">
                      <el-tag size="small" effect="plain" round :type="slot.member.role === 'fighter' ? 'danger' : slot.member.role === 'support' ? 'success' : slot.member.role === 'mage' ? 'primary' : 'warning'">{{ ROLE_ONE[slot.member.role] }}</el-tag>
                      <el-tag v-if="slot.wide" size="small" effect="plain" round type="info">{{ tr("2 клетки") }}</el-tag>
                    </span>
                  </span>
                  <el-button v-if="slot.member.unit !== keeping" class="gb-strike" text size="small" :icon="Close"
                    :title="tr('Не брать этого юнита')" :aria-label="tr('Не брать: {name}', { name: unitStore.nameOf(slot.member.unit) })" @click="strike(slot.member.unit)" />
                </template>
                <span v-else class="gb-empty">—</span>
              </div>
            </template>
          </div>
          <div class="gb-total" :class="{ over: guard.overBudget }">
            <b>{{ tr("Сила {strength} из {budget}", { strength: num(guard.strength), budget: num(s.budget) }) }}</b>
            <span v-if="!isTemplate"> · {{ tr("здоровье {hp}", { hp: num(guard.hp) }) }}</span>
            <span> · {{ trn("{n} юнит|{n} юнита|{n} юнитов", guard.count) }}</span>
            <template v-if="subraceNames"> · {{ subraceNames }}</template>
          </div>
          <div v-if="guard.overBudget" class="gb-note gb-warn">
            {{ leaderless
              ? tr("Дешевле не собрать: самый слабый подходящий солдат один стоит {min}.", { min: num(guard.strength) })
              : tr("Дешевле не собрать: самый слабый подходящий лидер один стоит {min}.", { min: num(guard.strength) }) }}
          </div>
          <div v-else-if="range && s.budget > range.max" class="gb-note">
            {{ tr("Больше {max} при таких условиях не набрать.", { max: num(range.max) }) }}
          </div>
        </template>
        <div v-else-if="unitStore.loaded" class="gb-none">
          {{ leaderless
            ? tr("Под такие условия в моде нет солдат: смените расу или верните кого-то в «Кого брать».")
            : tr("Под такие условия в моде нет лидера: смените расу или верните кого-то в «Кого брать».") }}
        </div>
        <div v-else class="gb-none">{{ tr("Загружаю каталог юнитов…") }}</div>

        <div v-if="figureless.length && !leaderless" class="gb-note" :title="figureless.map((id) => unitStore.nameOf(id)).join(', ')">
          {{ trn("{n} лидер мода не имеет фигуры на карте — он не берётся.|{n} лидера мода не имеют фигуры на карте — они не берутся.|{n} лидеров мода не имеют фигуры на карте — они не берутся.", figureless.length) }}
        </div>
        <div v-if="struck.length" class="gb-struck">
          <span class="gb-note">{{ tr("Не брать:") }}</span>
          <el-tag v-for="id in struck" :key="id" size="small" closable type="info" @close="unstrike(id)">{{ unitStore.nameOf(id) }}</el-tag>
        </div>

        <template v-if="s.lootOn && !isTemplate">
          <div class="gb-bar gb-bar2">
            <span class="gb-variant">{{ isRuin ? tr("Награда") : tr("Добыча") }}</span>
            <el-button size="small" :disabled="lootVariant <= 1" :title="isRuin ? tr('Предыдущая награда') : tr('Предыдущая добыча')" :aria-label="isRuin ? tr('Предыдущая награда') : tr('Предыдущая добыча')" @click="lootVariant--">◀</el-button>
            <el-button size="small" @click="lootVariant++">{{ isRuin ? tr("Другая награда") : tr("Другая добыча") }} ▶</el-button>
          </div>
          <template v-if="ruinReward">
            <div class="gb-loot">
              <div v-if="ruinReward.item" class="gb-item">
                <ItemIcon :id="ruinReward.item" :cat="itemStore.get(ruinReward.item)?.cat ?? -1" :size="24" />
                <span class="gb-item-name" :title="itemStore.nameOf(ruinReward.item)">{{ itemStore.nameOf(ruinReward.item) }}</span>
                <span class="gb-gold">{{ num(itemStore.get(ruinReward.item)?.gold ?? 0) }}</span>
              </div>
              <div v-else class="gb-note">{{ tr("Предмета за такую долю стоимости нет — вся награда золотом.") }}</div>
              <div class="gb-item">
                <span class="gb-coin" aria-hidden="true">●</span>
                <span class="gb-item-name">{{ tr("Золото") }}</span>
                <span class="gb-gold">{{ num(ruinReward.gold) }}</span>
              </div>
            </div>
            <div class="gb-total">
              <b>{{ tr("{value} из {budget} золота", { value: num(ruinReward.value), budget: num(s.lootBudget) }) }}</b>
            </div>
          </template>
          <template v-else-if="loot && loot.items.length">
            <div class="gb-loot">
              <div v-for="(id, i) in loot.items" :key="`${id}#${i}`" class="gb-item">
                <ItemIcon :id="id" :cat="itemStore.get(id)?.cat ?? -1" :size="24" />
                <span class="gb-item-name" :title="itemStore.nameOf(id)">{{ itemStore.nameOf(id) }}</span>
                <span class="gb-gold">{{ num(itemStore.get(id)?.gold ?? 0) }}</span>
              </div>
            </div>
            <div class="gb-total">
              <b>{{ tr("{value} из {budget} золота", { value: num(loot.value), budget: num(s.lootBudget) }) }}</b>
            </div>
          </template>
          <div v-else class="gb-none">{{ tr("Таких дешёвых предметов среди выбранных видов нет.") }}</div>
        </template>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">{{ tr("Отмена") }}</el-button>
      <el-button type="primary" :disabled="!guard" @click="apply">{{ WORDS.apply }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.gb-lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--el-text-color-regular);
}
.gb-body {
  display: grid;
  grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
  gap: 20px;
}
.gb-h {
  margin-bottom: 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
}
.gb-h2 {
  margin-top: 16px;
}
.gb-row {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  margin-bottom: 8px;
}
.gb-row > label {
  padding-top: 4px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.gb-field {
  min-width: 0;
  font-size: 13px;
}
.gb-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.gb-wide {
  width: 100%;
}
.gb-short {
  width: 92px;
}
.gb-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.gb-scale {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.gb-chip {
  padding: 2px 8px;
  font: inherit;
  font-size: 12px;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  cursor: pointer;
}
.gb-chip:hover,
.gb-chip:focus-visible {
  border-color: var(--el-color-primary);
  outline: none;
}
.gb-chip.on {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.gb-note {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
}
.gb-indent {
  margin: -4px 0 8px 100px;
}
.gb-warn {
  color: var(--el-color-warning);
}
.gb-result {
  min-width: 0;
}
.gb-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.gb-bar2 {
  margin-top: 16px;
}
.gb-variant {
  margin-right: auto;
  font-size: 13px;
  font-weight: 600;
}
.gb-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: center;
  color: var(--el-text-color-secondary);
}
.gb-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.gb-cell {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 62px;
  padding: 6px 8px;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
}
.gb-cell.filled {
  border-style: solid;
  background: var(--el-fill-color-extra-light);
}
.gb-cell.wide {
  grid-column: 1 / -1;
}
.gb-cell.leader {
  border-color: var(--el-color-warning);
}
.gb-portrait {
  position: relative;
  flex: none;
  line-height: 0;
}
.gb-star {
  position: absolute;
  top: -6px;
  right: -6px;
  font-size: 14px;
  line-height: 1;
  color: var(--el-color-warning);
  text-shadow: 0 0 2px #000;
}
.gb-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.gb-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.gb-stats {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.gb-tags {
  display: flex;
  gap: 4px;
}
.gb-strike {
  flex: none;
  align-self: flex-start;
  margin: -2px -4px 0 0;
  padding: 2px;
}
.gb-empty {
  margin: 0 auto;
  color: var(--el-text-color-placeholder);
}
.gb-total {
  margin-top: 8px;
  font-size: 13px;
}
.gb-total.over b {
  color: var(--el-color-warning);
}
.gb-none {
  padding: 18px 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.gb-struck {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
}
.gb-struck .gb-note {
  margin: 0 2px 0 0;
}
.gb-loot {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.gb-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
}
.gb-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.gb-coin {
  width: 24px;
  text-align: center;
  color: var(--el-color-warning);
}
.gb-gold {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--el-color-warning);
}
@media (max-width: 760px) {
  .gb-body {
    grid-template-columns: 1fr;
  }
}
</style>
