<script setup lang="ts">
/** Stack-template editor (MidStackTemplate): the reusable armies spawned by events
 *  (CREATE_NEW_STACK / MOVE_STACK). List + editor: name, order, 6 unit cells (global Gunit
 *  ids via UnitPicker + level). THE LEADER IS ONE OF THE 6 CELLS (★): on-disk LEADER/
 *  LEADER_LVL are a derived duplicate of the leader cell — the reference exports them from
 *  the flagged unit and re-finds the cell by type-id match on import; measured 2656/2656
 *  shipped templates. So an empty template asks for the leader FIRST (any cell click opens
 *  the leaders roster), and the leader cell keeps LEADER/LEADER_LVL in sync. Modifiers /
 *  facing are preserved on round-trip (equipment does not exist in the template format).
 *  Edits commit as upsertTemplate/deleteTemplate ops (undoable + collab). */
import { computed, nextTick, watch } from "vue";
import { ElButton, ElScrollbar, ElEmpty, ElSelect, ElOption } from "element-plus";
import type { StackTemplate, TemplateUnit } from "@d2/map-schema";
import { useEventStore } from "../stores/eventStore";
import { useEditStore } from "../stores/editStore";
import { useUnitStore } from "../stores/unitStore";
import CommitInput from "./CommitInput.vue";
import GarrisonEditor from "./GarrisonEditor.vue";

const store = useEventStore();
const edit = useEditStore();
const unitStore = useUnitStore();
// имена юнитов (лидер в списке, ячейки) должны быть готовы сразу, не после первого пикера
void unitStore.load();
const sel = computed(() => store.selectedTemplate);

/** Прыжок из поля «Шаблон отряда» / графа: доскроллить список к выбранному шаблону. */
watch(
  () => store.selectedTemplateId,
  () => {
    void nextTick(() =>
      document.querySelector(".tpl-row.active")?.scrollIntoView({ block: "center" }),
    );
  },
  { immediate: true },
);

/** Подпись строки списка: лидер по имени (id — только в title). */
const leaderName = (t: StackTemplate): string =>
  t.leader ? unitStore.nameOf(t.leader) : "";

const ORDERS = [
  { value: 1, label: "Обычный" }, { value: 2, label: "Стоять" }, { value: 3, label: "Охрана" },
  { value: 4, label: "Атака" }, { value: 7, label: "Бродить" }, { value: 9, label: "Оборона" },
];

function patch(partial: Partial<StackTemplate>): void {
  if (!sel.value) return;
  store.upsertTemplate({ ...sel.value, ...partial });
}

/** Ячейка лидера = та, чей юнит совпадает с LEADER (семантика импорта эталона). Для БОЛЬШОГО
 *  юнита findIndex вернёт НИЖНЮЮ (чётную) клетку пары — она же primary объединённого слота. */
const leaderCellIdx = computed(() => {
  const t = sel.value;
  if (!t?.leader) return -1;
  return t.units.findIndex((u) => u && u.unit === t.leader);
});
const hasLeader = computed(() => leaderCellIdx.value >= 0);
/** Заготовка старого образца: LEADER задан, но в ячейках его нет — чинится кликом. */
const orphanLeader = computed(() => !!sel.value?.leader && !hasLeader.value);

// ── БОЛЬШОЙ (2-клеточный) юнит в шаблоне занимает ОБЕ клетки линии формации (пара cell^1 =
// (0,1)/(2,3)/(4,5)), общий id + флаг `big`; на диске это один слот с POS_i==POS_j. Показываем
// его ОДНИМ широким слотом и правим ЦЕЛИКОМ — иначе клетки рассинхронятся (уровень) и экспорт
// схлопнет пару обратно (semantic-фейл) либо большой юнит распадётся надвое.
const partnerOf = (cell: number): number => cell ^ 1;
/** Пара клеток колонки = ОДИН большой юнит ТОЛЬКО если юнит КРУПНЫЙ (SIZE_SMALL=false). Парсер
 *  провизорно ставит `big` на любую пару с общим слотом (POS_i==POS_j) — а так эталон хранит и
 *  ДВА ОДИНАКОВЫХ мелких юнита (дедуп в один слот); это ДВЕ сущности, показываем/правим порознь.
 *  Пока каталог не загружен — верим ридер-флагу, чтобы не «разъединить» настоящего большого. */
function isBigPrimary(cell: number): boolean {
  const u = sel.value?.units ?? [];
  const ua = u[cell], ub = u[partnerOf(cell)];
  if (!ua || !ub || ua.unit !== ub.unit) return false;
  if (!(ua.big || ub.big)) return false; // slot-shared pair (reader POS_i==POS_j) or a fresh big
  return unitStore.isLarge(ua.unit); // sized catalog is a hard requirement (unitStore.load fails loud otherwise)
}
/** Клетки, которые двигаются ВМЕСТЕ с `cell`: обе клетки большого юнита, иначе — только сама. */
const entityCells = (cell: number): number[] => (isBigPrimary(cell) ? [cell, partnerOf(cell)] : [cell]);
/** Привести `big`-флаги к ПРАВДЕ по размеру: колонка-пара = big ⇔ обе клетки — один КРУПНЫЙ юнит.
 *  Так правка снимает провизорный ридер-флаг с пары одинаковых мелких (эталон их не сливает) →
 *  packTemplateSlots не схлопнет их в один слот и не потеряет разные уровни. Работает лишь при
 *  загруженном каталоге — иначе неизвестный размер не должен сбрасывать флаг настоящего большого. */
function withSizedBig(units: (TemplateUnit | null)[]): (TemplateUnit | null)[] {
  if (!unitStore.loaded) return units; // catalog not fetched yet (async) — don't touch flags pre-load
  const out = units.map((u) => (u ? { ...u } : null));
  for (let r = 0; r < 3; r++) {
    const a = 2 * r, b = 2 * r + 1, ua = out[a], ub = out[b];
    const big = !!(ua && ub && ua.unit === ub.unit && unitStore.isLarge(ua.unit));
    if (ua) { if (big) ua.big = true; else delete ua.big; }
    if (ub) { if (big) ub.big = true; else delete ub.big; }
  }
  return out;
}
/** Число СУЩНОСТЕЙ (большой юнит = 1, а не 2 занятые клетки). */
function entityFill(units: readonly (TemplateUnit | null)[]): number {
  let n = 0;
  for (let r = 0; r < 3; r++) {
    const a = 2 * r, b = 2 * r + 1, ua = units[a], ub = units[b];
    if (ua && ub && ua.unit === ub.unit && (ua.big || ub.big)) n += 1;
    else { if (ua) n++; if (ub) n++; }
  }
  return n;
}
// ── Адаптер под GarrisonEditor: тот же презентационный компонент, что у гарнизона (2 колонки
// Тыл/Фронт, широкий слот большого юнита, ⇔-бейдж, ★-лидер, гард «не выселять лидера»). Шаблон
// поставляет данные в форме гарнизонного `GarrUnit[]`; размещение/эвикцию по-прежнему делают
// setCell/setCellLevel/setCellMods (родитель владеет моделью). Отличия шаблона: нет HP (hideHp —
// эталон HP не редактирует, у шаблона его в данных нет), модификаторы лежат в отдельном списке
// (cellMods), большой юнит — по флагу `big`, который здесь превращаем в ОБЩИЙ синтетический `key`
// пары → GarrisonEditor рисует широкий слот. Cap уровня и лидер-лок НЕ ставим: эталон (UnitView.qml)
// капает по личному `unitMaxLvl()` (в каталоге нет — берём гарнизонный дефолт 50) и удаляет ЛЮБУЮ
// клетку включая лидера (лидер деривится в setCell), так что оба параметра — гарнизонные дефолты.
type GView = { unit: string; level: number; hp: number; modifiers?: string[]; key?: string };
const garrisonView = computed<(GView | null)[]>(() => {
  const out: (GView | null)[] = [null, null, null, null, null, null];
  const units = sel.value?.units ?? [];
  for (let r = 0; r < 3; r++) {
    const a = 2 * r, b = 2 * r + 1;
    const key = isBigPrimary(a) ? `T${a}` : undefined; // общий key пары ⇒ один широкий слот
    const ua = units[a], ub = units[b];
    if (ua) out[a] = { unit: ua.unit, level: ua.level, hp: 0, modifiers: cellMods(a), key };
    if (ub) out[b] = { unit: ub.unit, level: ub.level, hp: 0, modifiers: cellMods(b), key };
  }
  return out;
});
/** ★ на ячейке = сделать её юнита лидером (только герой/вор; звезда у GarrisonEditor и так
 *  гейтит категорию). Лидер шаблона — производный LEADER/LEADER_LVL от юнита этой клетки. */
function onSetLeader(c: number): void {
  const u = cell(c);
  if (u && unitStore.isLeaderCategory(u.unit)) patch({ leader: u.unit, leaderLevel: u.level });
}

function setCell(i: number, unit: string | null): void {
  if (!sel.value) return;
  const units = sel.value.units.slice();
  while (units.length < 6) units.push(null);
  const level = units[i]?.level ?? 1;
  const dropMods = new Set<number>();
  if (unit && unitStore.isLarge(unit)) {
    // БОЛЬШОЙ юнит занимает ОБЕ клетки своей колонки (чётная a + нечётная b), вытесняя прежних
    // жильцов обеих клеток; моды пары сбрасываются — это новая сущность
    const a = i & ~1, b = a + 1;
    for (const c of new Set<number>([...entityCells(i), a, b])) { dropMods.add(c); units[c] = null; }
    units[a] = { unit, level, big: true };
    units[b] = { unit, level, big: true };
  } else {
    // одиночный юнит или очистка; если правим primary большого юнита — разъединяем пару
    if (isBigPrimary(i)) { units[partnerOf(i)] = null; dropMods.add(partnerOf(i)); } // призрак-партнёр
    units[i] = unit ? { unit, level } : null;
    if (!unit) dropMods.add(i); // опустевшая клетка теряет свои модификаторы (unitPos в пустоту)
  }
  const modsPatch = dropMods.size
    ? { modifiers: (sel.value.modifiers ?? []).filter((m) => !dropMods.has(m.unitPos)) }
    : {};
  const uu = withSizedBig(units);
  // Reconcile the derived LEADER: it must be a unit id sitting in some cell. If THIS edit
  // displaced the leader — replaced/cleared its cell OR a big unit stomped the leader's column
  // partner cell (footprint {a,b}, not just the clicked i) — adopt the placed unit as leader when
  // it CAN lead, else drop the leader. (Keying only on the clicked cell orphaned LEADER: a large
  // unit placed at the leader-column partner evicted the hero but left LEADER dangling.)
  const leaderGone = !sel.value.leader || !uu.some((u) => u?.unit === sel.value!.leader);
  const leaderFields = (!hasLeader.value || leaderGone)
    ? { leader: unit && unitStore.isLeaderCategory(unit) ? unit : "", leaderLevel: unit && unitStore.isLeaderCategory(unit) ? level : 1 }
    : {};
  patch({ units: uu, ...leaderFields, ...modsPatch });
}
function setCellLevel(i: number, level: number): void {
  if (!sel.value) return;
  const units = sel.value.units.slice();
  for (const c of entityCells(i)) if (units[c]) units[c] = { ...(units[c] as TemplateUnit), level };
  const uu = withSizedBig(units);
  patch(i === leaderCellIdx.value ? { units: uu, leaderLevel: level } : { units: uu });
}
const cell = (i: number): TemplateUnit | null => sel.value?.units[i] ?? null;
const unitCount = (t: StackTemplate): number => entityFill(t.units);

/** Модификаторы ячейки: в шаблоне это плоский список {unitPos (индекс ЯЧЕЙКИ), modifId} —
 *  семантика эталона (mod.index = grid index). Большой юнит = одна сущность: показываем моды
 *  обеих его клеток и держим их на primary-клетке. Правка пересобирает список. */
const cellMods = (i: number): string[] => {
  const cells = entityCells(i);
  return (sel.value?.modifiers ?? []).filter((m) => cells.includes(m.unitPos)).map((m) => m.modifId);
};
function setCellMods(i: number, mods: string[]): void {
  if (!sel.value) return;
  const cells = entityCells(i); // большой юнит: обе клетки → моды консолидируются на primary (i)
  const others = (sel.value.modifiers ?? []).filter((m) => !cells.includes(m.unitPos));
  const next = [...others, ...mods.map((modifId) => ({ unitPos: i, modifId }))];
  // канонично: эталонный экспорт сортирует список по ячейке (внутри ячейки — порядок выбора)
  next.sort((a, b) => a.unitPos - b.unitPos);
  patch({ modifiers: next });
}
</script>

<template>
  <div class="tpl-editor">
    <!-- the tab is the title; head keeps the count + action only -->
    <div class="tpl-head">
      <span class="tpl-count">{{ store.templates.length }} шаблонов</span>
      <el-button size="small" type="primary" @click="store.createTemplate()">+ Шаблон</el-button>
    </div>

    <el-scrollbar class="tpl-list">
      <div
        v-for="t in store.templates"
        :key="t.id"
        class="tpl-row d2-row"
        :class="{ active: t.id === store.selectedTemplateId }"
        @click="store.selectTemplate(t.id)"
      >
        <span class="tpl-name">{{ t.name || "(без имени)" }}</span>
        <span class="tpl-meta" :title="t.id">{{ unitCount(t) }}⚔ {{ leaderName(t) || "—" }}</span>
        <span class="tpl-actions">
          <el-tooltip content="Клонировать"><el-button size="small" text class="icon-btn" @click.stop="store.cloneTemplate(t)">⧉</el-button></el-tooltip>
          <el-tooltip content="Удалить"><el-button size="small" text class="icon-btn" @click.stop="store.removeTemplate(t.id)">🗑</el-button></el-tooltip>
        </span>
      </div>
      <el-empty v-if="!store.templates.length" description="Нет шаблонов" :image-size="60" />
    </el-scrollbar>

    <el-scrollbar v-if="sel" class="tpl-form">
      <CommitInput :model-value="sel.name" size="small" placeholder="Название шаблона"
        @update:model-value="patch({ name: $event })" />
      <div class="tpl-props">
        <label>приказ
          <el-select :model-value="sel.order" size="small" style="width: 130px"
            @update:model-value="patch({ order: $event })">
            <el-option v-for="o in ORDERS" :key="o.value" :value="o.value" :label="o.label" />
          </el-select>
        </label>
      </div>
      <div class="tpl-units">
        <div class="tpl-units-lbl d2-sec">Состав (6 ячеек, лидер ★ — одна из них):</div>
        <p v-if="!hasLeader" class="tpl-need-leader">
          {{ orphanLeader
            ? "Лидер выбран, но не размещён в отряде — кликните ячейку, чтобы поставить его ★"
            : "Отряд начинается с лидера: кликните любую ячейку — сперва выбирается герой или вор ★" }}
        </p>
        <GarrisonEditor
          :garrison="garrisonView"
          :count="sel ? entityFill(sel.units) : 0"
          :leader-cell="leaderCellIdx"
          roster="soldiers"
          hide-hp
          @set-unit="(c, u) => setCell(c, u)"
          @clear="(c) => setCell(c, null)"
          @set-stat="(c, k, v) => { if (k === 'level') setCellLevel(c, v); }"
          @set-leader="onSetLeader"
          @set-mods="(c, m) => setCellMods(c, m)"
        />
      </div>
      <p class="tpl-hint">Шаблон — «рецепт» отряда: событие «Создать отряд» ставит его в выбранную локацию. Лидер (★) — часть отряда и занимает одну из 6 ячеек; модификаторы юнита — под ⚙ у ячейки. Снаряжения у шаблона не бывает — формат .sg его не хранит.</p>
    </el-scrollbar>
  </div>
</template>

<style scoped>
/* the WIDE dialog gets two columns (list | form) instead of the old narrow-rail stack */
.tpl-editor {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  column-gap: 16px;
  height: 100%;
  font-size: 12px;
}
.tpl-head { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px; }
.tpl-count { color: var(--el-text-color-secondary); margin-right: auto; }
.tpl-list { min-height: 0; padding: 0 4px 8px; }
.tpl-row { display: flex; align-items: center; gap: 6px; padding: 5px 10px; cursor: pointer; }
.tpl-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tpl-meta { color: var(--el-text-color-secondary); margin-left: auto; font-size: 11px; }
.tpl-form { min-height: 0; padding: 8px 12px; max-width: 560px; }
.tpl-props { margin: 8px 0; }
.tpl-props label { color: var(--el-text-color-secondary); margin-right: 6px; }
.tpl-need-leader { color: var(--el-color-warning); font-size: 11px; margin: 4px 0 8px; }
.tpl-hint { color: var(--el-text-color-secondary); font-size: 11px; margin-top: 12px; }
.icon-btn { opacity: 0.6; transition: opacity 0.12s; }
.icon-btn:hover { opacity: 1; }
</style>
