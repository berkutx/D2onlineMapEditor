<script setup lang="ts">
/**
 * Scenario WINDOW — a draggable, NON-modal el-dialog (not a docked rail: the scenario needs
 * width — list | star-topology graph | editor side by side — and the map must stay clickable
 * so selecting an event shows its zones/arrows on the map while you work).
 *
 * Tabs: События (3-zone layout) / Настройки / Дипломатия / Переменные / Шаблоны.
 * Edits commit through editStore (undoable + collab).
 */
import { computed, nextTick, ref, onMounted, onBeforeUnmount, watch } from "vue";
import {
  ElDialog, ElInput, ElButton, ElScrollbar, ElInputNumber, ElSwitch, ElCheckbox, ElSelect,
  ElOption, ElTag, ElTooltip, ElEmpty, ElTabs, ElTabPane, ElMessage,
} from "element-plus";
import type { MapEvent, EventCondition, EventEffect } from "@d2/map-schema";
import { CONDITION_SPECS, EFFECT_SPECS, CONDITION_BY_KIND, EFFECT_BY_KIND } from "@d2/map-schema";
import { useEventStore, makeCondition, makeEffect } from "../stores/eventStore";
import { useEditStore } from "../stores/editStore";
import { useViewStore } from "../stores/viewStore";
import { useUnitStore } from "../stores/unitStore";
import { eventBadges } from "../services/scenarioRoles";
import { tr, trn } from "../i18n";
import CommitInput from "./CommitInput.vue";
import EventFieldInput from "./EventFieldInput.vue";
import EventGraph from "./EventGraph.vue";
import EventSummaryCard from "./EventSummaryCard.vue";
import VariablesEditor from "./VariablesEditor.vue";
import TemplatesEditor from "./TemplatesEditor.vue";
import ScenarioSettingsEditor from "./ScenarioSettingsEditor.vue";
import MapRestrictionsEditor from "./MapRestrictionsEditor.vue";
import DiplomacyEditor from "./DiplomacyEditor.vue";
import PlayerEditor from "./PlayerEditor.vue";

const store = useEventStore();
const editStore = useEditStore();
const view = useViewStore();
// unit catalog powers every «имя вместо id» label in the window (template leaders, stack
// labels, unit refs) — kick the lazy load as soon as the window mounts, not on first picker
void useUnitStore().load();

const visible = computed({
  get: () => view.eventPanelVisible,
  set: (v: boolean) => { if (v !== view.eventPanelVisible) view.toggleEventPanel(); },
});

/** Список событий сворачивается в узкую полоску; граф связей опционален (по умолчанию скрыт),
 *  так что стандартная раскладка — просторные 2 колонки «список | редактор». */
const listCollapsed = ref(false);
const gridColumns = computed(() => {
  const list = listCollapsed.value ? "28px" : "minmax(240px, 320px)";
  return view.eventGraphVisible
    ? `${list} minmax(0, 1fr) minmax(300px, 340px)` // список | граф | редактор
    : `${list} minmax(360px, 1fr)`; //                список | редактор (граф скрыт)
});

/** Пришли к событию ПЕРЕХОДОМ (граф, кнопка ➜, инспектор, переменные) → сворачиваем список,
 *  чтобы фокус был на детали. Обычный клик по строке списка сюда не попадает (без fromLink),
 *  так что список под пользователем не схлопывается. Полоску «▸ события» всегда можно раскрыть. */
watch(() => store.linkNavSignal, () => { listCollapsed.value = true; });

/** Alt+← / Alt+→ = назад/вперёд по истории переходов (пока окно открыто). */
function onNavKey(e: KeyboardEvent): void {
  if (!view.eventPanelVisible) return;
  if (e.altKey && e.key === "ArrowLeft") {
    store.goBack();
    e.preventDefault();
  } else if (e.altKey && e.key === "ArrowRight") {
    store.goForward();
    e.preventDefault();
  }
}
onMounted(() => window.addEventListener("keydown", onNavKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onNavKey));

const sel = computed(() => store.selected);

/** Graph node click → scroll the editor column to the matching cond/eff card + flash it. */
const editorCol = ref<HTMLElement | null>(null);
const flashCard = ref<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => store.cardReveal, (r) => {
  if (!r) return;
  const key = (r.kind === "cond" ? "c" : "e") + r.index;
  void nextTick(() => {
    editorCol.value
      ?.querySelector(`[data-card="${key}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    flashCard.value = key;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flashCard.value = null), 1300);
  });
});

const RACES = [
  { key: "human", label: tr("Имп") }, { key: "dwarf", label: tr("Кланы") }, { key: "undead", label: tr("Нежить") },
  { key: "heretic", label: tr("Легионы") }, { key: "neutral", label: tr("Нейтр") }, { key: "elf", label: tr("Эльфы") },
] as const;

function patch(partial: Partial<MapEvent>): void {
  if (!sel.value) return;
  store.upsert({ ...sel.value, ...partial });
}
function patchRace(set: "appliesTo" | "canTrigger", key: string, v: boolean): void {
  if (!sel.value) return;
  patch({ [set]: { ...sel.value[set], [key]: v } } as Partial<MapEvent>);
}

// --- conditions ---
function addCondition(kind: string): void {
  if (!sel.value) return;
  patch({ conditions: [...sel.value.conditions, makeCondition(kind)] });
}
function setCondField(i: number, key: string, v: unknown): void {
  if (!sel.value) return;
  const conditions = sel.value.conditions.map((c, j) =>
    j === i ? ({ ...c, [key]: v } as EventCondition) : c);
  patch({ conditions });
}
function removeCondition(i: number): void {
  if (!sel.value) return;
  patch({ conditions: sel.value.conditions.filter((_, j) => j !== i) });
}

// --- effects ---
function addEffect(kind: string): void {
  if (!sel.value) return;
  const eff = makeEffect(kind);
  (eff as { num: number }).num = sel.value.effects.length;
  patch({ effects: [...sel.value.effects, eff] });
}
function setEffField(i: number, key: string, v: unknown): void {
  if (!sel.value) return;
  const effects = sel.value.effects.map((e, j) =>
    j === i ? ({ ...e, [key]: v } as EventEffect) : e);
  patch({ effects });
}
function removeEffect(i: number): void {
  if (!sel.value) return;
  patch({ effects: sel.value.effects.filter((_, j) => j !== i) });
}
function moveEffect(i: number, dir: -1 | 1): void {
  if (!sel.value) return;
  const j = i + dir;
  if (j < 0 || j >= sel.value.effects.length) return;
  const effects = sel.value.effects.slice();
  [effects[i], effects[j]] = [effects[j]!, effects[i]!];
  effects.forEach((e, k) => ((e as { num: number }).num = k)); // renumber sequence
  patch({ effects });
}

// --- zone-event clone groups (project.zones[].eventGroups) --------------------------------
// The game allows ONE zone condition per event → «событие на зону» = per-location clones.
// The list COLLAPSES clones behind their base row (⧉N badge toggles them); the editor column
// offers «⧉ на зону» for events with a zone condition.
const zoneGroups = computed(() => {
  const live = new Set(store.events.map((e) => e.id));
  const cloneOf = new Map<string, string>(); // cloneId -> baseId
  const groupOf = new Map<string, { zoneName: string; cloneIds: string[] }>(); // baseId -> group
  for (const [, z] of Object.entries(editStore.zones)) {
    for (const g of z.eventGroups ?? []) {
      const [base, ...clones] = g;
      if (!base || !live.has(base)) continue;
      const alive = clones.filter((id) => live.has(id));
      if (!alive.length) continue;
      for (const id of alive) cloneOf.set(id, base);
      const prev = groupOf.get(base);
      groupOf.set(base, { zoneName: z.name, cloneIds: [...(prev?.cloneIds ?? []), ...alive] });
    }
  }
  return { cloneOf, groupOf };
});
const expandedGroups = ref<Set<string>>(new Set());
function toggleGroup(baseId: string): void {
  const s = new Set(expandedGroups.value);
  s.has(baseId) ? s.delete(baseId) : s.add(baseId);
  expandedGroups.value = s;
}
/** Tooltip of a base row's ⧉N badge. */
function zoneBadgeTip(baseId: string): string {
  const g = zoneGroups.value.groupOf.get(baseId)!;
  return trn(
    "Размножено на зону «{zone}»: +{n} клон (клик — раскрыть). Правки базы в клоны не тянутся.|Размножено на зону «{zone}»: +{n} клона (клик — раскрыть). Правки базы в клоны не тянутся.|Размножено на зону «{zone}»: +{n} клонов (клик — раскрыть). Правки базы в клоны не тянутся.",
    g.cloneIds.length,
    { zone: g.zoneName },
  );
}
/** Filtered rows with zone clones folded behind their base (expanded groups inline). */
const listRows = computed<MapEvent[]>(() => {
  const { cloneOf, groupOf } = zoneGroups.value;
  if (!cloneOf.size) return store.filtered;
  const byId = new Map(store.filtered.map((e) => [e.id, e]));
  const out: MapEvent[] = [];
  for (const e of store.filtered) {
    if (cloneOf.has(e.id)) continue; // rides with its base
    out.push(e);
    const g = groupOf.get(e.id);
    if (g && expandedGroups.value.has(e.id)) {
      for (const cid of g.cloneIds) {
        const c = byId.get(cid) ?? store.events.find((x) => x.id === cid);
        if (c) out.push(c);
      }
    }
  }
  return out;
});

// «⧉ на зону»: clone the selected event across a zone's locations (editor column control)
const cloneZoneId = ref<string>("");
const cloneOnce = ref(true);
const zoneCloneTargets = computed(() => {
  const doc = editStore.liveDoc;
  return Object.entries(editStore.zones)
    .map(([id, z]) => ({ id, name: z.name, n: z.locIds.filter((l) => doc?.objects.some((o) => o.id === l)).length }))
    .filter((z) => z.n >= 2);
});
const canCloneToZone = computed(() => !!sel.value && store.zoneCondIndex(sel.value) >= 0 && zoneCloneTargets.value.length > 0);
function doCloneZone(): void {
  if (!sel.value || !cloneZoneId.value) return;
  const n = store.cloneEventForZone(sel.value.id, cloneZoneId.value, cloneOnce.value);
  if (n > 0) {
    const cloned = trn("Клонировано на зону: +{n} событие|Клонировано на зону: +{n} события|Клонировано на зону: +{n} событий", n);
    ElMessage.success(cloneOnce.value ? `${cloned} · ${tr("сработает один раз")}` : cloned);
  } else {
    ElMessage.warning(tr("Не вышло: у зоны меньше двух живых локаций или в событии нет зонного условия"));
  }
}

/** «▦ Вся зона» chosen in a condition's location picker: the field already points at the
 *  first primitive (committed by setCondField just before this handler) — expand into
 *  derived clones. «Один раз на зону» rides the event's own occurOnce. */
function onZonePick(zid: string): void {
  const ev = sel.value;
  if (!ev) return;
  void nextTick(() => {
    const n = store.cloneEventForZone(ev.id, zid, ev.occurOnce);
    if (n > 0) {
      ElMessage.success(
        ev.occurOnce
          ? trn("Событие развёрнуто на зону: +{n} скрытый клон · сработает один раз на зону. Правки этого события тянутся в клоны автоматически.|Событие развёрнуто на зону: +{n} скрытых клона · сработает один раз на зону. Правки этого события тянутся в клоны автоматически.|Событие развёрнуто на зону: +{n} скрытых клонов · сработает один раз на зону. Правки этого события тянутся в клоны автоматически.", n)
          : trn("Событие развёрнуто на зону: +{n} скрытый клон. Правки этого события тянутся в клоны автоматически.|Событие развёрнуто на зону: +{n} скрытых клона. Правки этого события тянутся в клоны автоматически.|Событие развёрнуто на зону: +{n} скрытых клонов. Правки этого события тянутся в клоны автоматически.", n),
      );
    }
  });
}

/** showWhen: поле видно, пока управляющее значение ≠ not (данные живут и сериализуются —
 *  прячем только мёртвые инпуты за выключенной опцией, напр. вторую переменную varInRange). */
const fieldVisible = (f: { hidden?: boolean; showWhen?: { key: string; not: number } }, holder: Record<string, unknown>): boolean =>
  !f.hidden && (!f.showWhen || holder[f.showWhen.key] !== f.showWhen.not);
const condFields = (c: EventCondition) =>
  (CONDITION_BY_KIND[c.kind]?.fields ?? []).filter((f) => fieldVisible(f, c as Record<string, unknown>));
const effFields = (e: EventEffect) =>
  (EFFECT_BY_KIND[e.kind]?.fields ?? []).filter((f) => fieldVisible(f, e as Record<string, unknown>));
const condLabel = (c: EventCondition) => {
  const spec = CONDITION_BY_KIND[c.kind];
  return spec ? tr(spec.label) : c.kind;
};
const effLabel = (e: EventEffect) => {
  const spec = EFFECT_BY_KIND[e.kind];
  return spec ? tr(spec.label) : e.kind;
};
/** Role-class icons for a list row (shared scenarioRoles model), capped at 4. */
const badgeIcons = (e: MapEvent): string => eventBadges(e).slice(0, 4).join("");
</script>

<template>
  <el-dialog
    v-model="visible"
    class="scenario-dialog"
    :modal="false"
    draggable
    :close-on-click-modal="false"
    :lock-scroll="false"
    width="min(1220px, 96vw)"
    top="4vh"
    append-to-body
  >
    <template #header>
      <span class="sc-title">{{ tr("Сценарий") }}</span>
    </template>

    <el-tabs v-model="store.panelTab" class="ev-tabs">
      <el-tab-pane :label="tr('События')" name="events" />
      <el-tab-pane :label="tr('Настройки')" name="settings" />
      <el-tab-pane :label="tr('Ограничения')" name="restrictions" />
      <el-tab-pane :label="tr('Игроки')" name="players" />
      <el-tab-pane :label="tr('Дипломатия')" name="diplomacy" />
      <el-tab-pane :label="tr('Переменные')" name="vars" />
      <el-tab-pane :label="tr('Шаблоны')" name="templates" />
    </el-tabs>

    <!-- navigation bar: ALWAYS visible (disabled buttons teach that history exists) —
         back/forward + «+ событие» + breadcrumbs. Critical in deep event webs. -->
    <div class="sc-nav">
      <el-tooltip :content="tr('Назад (Alt+←)')" :show-after="300">
        <el-button class="sc-navbtn" :disabled="!store.canGoBack" @click="store.goBack()">{{ tr("← Назад") }}</el-button>
      </el-tooltip>
      <el-tooltip :content="tr('Вперёд (Alt+→)')" :show-after="300">
        <el-button class="sc-navbtn" :disabled="!store.canGoForward" @click="store.goForward()">{{ tr("Вперёд →") }}</el-button>
      </el-tooltip>
      <el-button
        v-if="store.panelTab === 'events'"
        class="sc-navbtn"
        type="primary"
        @click="store.create()"
      >{{ tr("＋ Событие") }}</el-button>
      <span
        v-for="(c, i) in store.breadcrumbs"
        :key="i"
        class="sc-crumb"
        :class="{ current: c.current }"
        @click="!c.current && store.goToCrumb(i)"
      >
        {{ c.label }}<span v-if="!c.current" class="sc-sep">›</span>
      </span>
    </div>

    <div class="sc-body">
      <ScenarioSettingsEditor v-if="store.panelTab === 'settings'" class="ev-sub" />
      <MapRestrictionsEditor v-else-if="store.panelTab === 'restrictions'" class="ev-sub" />
      <PlayerEditor v-else-if="store.panelTab === 'players'" class="ev-sub" />
      <DiplomacyEditor v-else-if="store.panelTab === 'diplomacy'" class="ev-sub" />
      <VariablesEditor v-else-if="store.panelTab === 'vars'" class="ev-sub" />
      <TemplatesEditor v-else-if="store.panelTab === 'templates'" class="ev-sub" />

      <!-- События: list | (опц.) star graph | editor -->
      <div v-else class="ev-events">
        <div class="ev-toolbar">
          <el-tooltip :content="view.eventGraphVisible ? tr('Скрыть граф связей') : tr('Показать граф связей события')" :show-after="300">
            <el-button
              size="small"
              :type="view.eventGraphVisible ? 'primary' : 'default'"
              text
              class="ev-graph-toggle"
              @click="view.toggleEventGraph()"
            >{{ tr("🕸 Граф связей") }}</el-button>
          </el-tooltip>
        </div>
        <div class="ev-grid" :style="{ gridTemplateColumns: gridColumns }">
        <button
          v-if="listCollapsed"
          class="ev-list-expand"
          :title="tr('Показать список событий')"
          @click="listCollapsed = false"
        >▸<span class="ev-list-expand-lbl">{{ tr("события") }}</span></button>
        <div v-else class="ev-col ev-col-list d2-rail--left">
          <div class="ev-subhead">
            <el-tooltip :content="tr('Свернуть список (больше места редактору/графу)')" :show-after="300">
              <el-button size="small" text class="icon-btn" @click="listCollapsed = true">◂</el-button>
            </el-tooltip>
            <span class="ev-count">{{ trn("{n} событие|{n} события|{n} событий", store.events.length) }}</span>
          </div>
          <el-input
            v-model="store.filter"
            size="small"
            clearable
            :placeholder="tr('Поиск по имени / id…')"
            class="ev-search"
          />
          <div v-if="store.objectFilter" class="ev-objfilter">
            {{ tr("только для объекта") }} <code>{{ store.objectFilter }}</code>
            <el-button size="small" text @click="store.objectFilter = null">{{ tr("показать все") }}</el-button>
          </div>
          <el-scrollbar class="ev-list">
            <!-- hover-задержка = шпаргалка события (условия/эффекты именами + заметка автора) -->
            <el-tooltip
              v-for="e in listRows"
              :key="e.id"
              placement="right"
              :show-after="500"
              :persistent="false"
              popper-class="ev-sum-pop"
            >
              <template #content>
                <EventSummaryCard :event="e" />
              </template>
            <div
              class="ev-row d2-row"
              :class="{
                active: e.id === store.selectedId,
                'is-clone': zoneGroups.cloneOf.has(e.id),
                'map-hover': e.id === store.mapHoverId,
              }"
              @click="store.navigate({ tab: 'events', eventId: e.id })"
              @mouseenter="store.listHoverId = e.id"
              @mouseleave="store.listHoverId = null"
            >
              <div class="ev-row-main">
                <span class="ev-name">{{ e.name || tr("(без имени)") }}</span>
                <span class="ev-id">{{ e.id }}</span>
              </div>
              <div class="ev-badges">
                <el-tooltip
                  v-if="zoneGroups.groupOf.has(e.id)"
                  :content="zoneBadgeTip(e.id)"
                >
                  <el-tag size="small" type="success" disable-transitions class="ev-zone-badge"
                    @click.stop="toggleGroup(e.id)">⧉{{ zoneGroups.groupOf.get(e.id)!.cloneIds.length }}</el-tag>
                </el-tooltip>
                <el-tag v-if="!e.enabled" size="small" type="info" disable-transitions>{{ tr("выкл") }}</el-tag>
                <el-tag v-if="!e.occurOnce" size="small" type="warning" disable-transitions>∞</el-tag>
                <el-tag v-if="e.chance < 100" size="small" disable-transitions>{{ e.chance }}%</el-tag>
                <span class="ev-icons">{{ badgeIcons(e) }}</span>
                <span class="ev-ce" :class="{ 'ev-ce-inert': !e.effects.length }"
                  :title="!e.effects.length ? tr('у события нет эффектов — оно ничего не делает') : undefined"
                >{{ e.conditions.length }}⚡ {{ e.effects.length }}★</span>
                <el-tooltip :content="tr('Клонировать')"><el-button size="small" text class="icon-btn" @click.stop="store.clone(e)">⧉</el-button></el-tooltip>
                <el-tooltip :content="tr('Удалить')"><el-button size="small" text class="icon-btn" @click.stop="store.remove(e.id)">🗑</el-button></el-tooltip>
              </div>
            </div>
            </el-tooltip>
            <el-empty v-if="!listRows.length" :description="tr('Нет событий')" :image-size="60" />
          </el-scrollbar>
        </div>

        <!-- star topology: what triggers it (left), what it does (right), everything by name -->
        <EventGraph v-if="view.eventGraphVisible" class="ev-col ev-col-graph" />

        <div ref="editorCol" class="ev-col ev-col-editor d2-rail--left">
          <el-scrollbar v-if="sel" class="ev-editor">
            <CommitInput :model-value="sel.name" size="small" :placeholder="tr('Название события (игровое)')"
              @update:model-value="patch({ name: $event })" />
            <!-- editor-only note: подробное описание рядом с игровым именем; в .sg НЕ пишется -->
            <CommitInput type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" size="small" class="ev-desc"
              :model-value="editStore.eventDescs[sel.id] || ''" :placeholder="tr('Описание (только в редакторе)')"
              @update:model-value="editStore.setEventDesc(sel.id, $event)" />

            <div class="ev-props">
              <label><el-switch :model-value="sel.enabled" @update:model-value="patch({ enabled: $event as boolean })" /> {{ tr("активно с начала") }}</label>
              <label><el-switch :model-value="!sel.occurOnce" @update:model-value="patch({ occurOnce: !($event as boolean) })" /> {{ tr("повторяемое") }}</label>
              <label>{{ tr("шанс") }}
                <el-input-number :model-value="sel.chance" :min="0" :max="100" size="small" controls-position="right"
                  style="width: 96px" @update:model-value="patch({ chance: ($event as number) ?? 100 })" /> %</label>
              <label>{{ tr("порядок") }}
                <el-input-number :model-value="sel.order" size="small" controls-position="right"
                  style="width: 96px" @update:model-value="patch({ order: ($event as number) ?? 0 })" /></label>
            </div>

            <div class="ev-races">
              <div class="ev-races-row">
                <span class="ev-races-lbl">{{ tr("Действует на:") }}</span>
                <el-checkbox v-for="r in RACES" :key="'a' + r.key" :model-value="sel.appliesTo[r.key]"
                  @update:model-value="patchRace('appliesTo', r.key, $event as boolean)">{{ r.label }}</el-checkbox>
              </div>
              <div class="ev-races-row">
                <span class="ev-races-lbl">{{ tr("Может запускать:") }}</span>
                <el-checkbox v-for="r in RACES" :key="'t' + r.key" :model-value="sel.canTrigger[r.key]"
                  @update:model-value="patchRace('canTrigger', r.key, $event as boolean)">{{ r.label }}</el-checkbox>
              </div>
            </div>

            <!-- conditions -->
            <div class="ev-sec-head">
              <span class="d2-sec">{{ tr("Условия ({n})", { n: sel.conditions.length }) }}</span>
              <el-select :placeholder="tr('+ условие')" size="small" style="width: 190px" :model-value="''"
                @update:model-value="addCondition($event)">
                <el-option v-for="s in CONDITION_SPECS" :key="s.kind" :value="s.kind" :label="tr(s.label)" />
              </el-select>
            </div>
            <div v-for="(c, i) in sel.conditions" :key="'c' + i" class="ev-item d2-card"
              :data-card="'c' + i" :class="{ flash: flashCard === 'c' + i }">
              <div class="ev-item-head">
                <span>{{ condLabel(c) }}</span>
                <el-button size="small" text class="icon-btn" @click="removeCondition(i)">🗑</el-button>
              </div>
              <div v-for="f in condFields(c)" :key="f.key" class="ev-field">
                <label>{{ tr(f.label) }}</label>
                <EventFieldInput :field="f" :model-value="(c as Record<string, unknown>)[f.key]"
                  allow-zone
                  @update:model-value="setCondField(i, f.key, $event)"
                  @zone-pick="onZonePick($event)" />
              </div>
            </div>

            <!-- zone clone: expand a zone-condition event into per-location clones -->
            <div v-if="canCloneToZone" class="ev-zone-clone">
              <el-tooltip :content="tr('Игра допускает одно зонное условие на событие — событие «на зону» = клоны по локациям-примитивам зоны. «Один раз» = скрытая переменная-гейт: сработает только первый вход.')" :show-after="300">
                <span class="ev-zone-lbl">{{ tr("⧉ на зону") }}</span>
              </el-tooltip>
              <el-select v-model="cloneZoneId" size="small" :placeholder="tr('зона')" style="width: 130px">
                <el-option v-for="z in zoneCloneTargets" :key="z.id" :value="z.id" :label="tr('{name} ({n} лок.)', { name: z.name, n: z.n })" />
              </el-select>
              <el-checkbox v-model="cloneOnce" size="small">{{ tr("один раз") }}</el-checkbox>
              <el-button size="small" plain :disabled="!cloneZoneId" @click="doCloneZone()">{{ tr("Клонировать") }}</el-button>
            </div>

            <!-- effects -->
            <div class="ev-sec-head">
              <span class="d2-sec">{{ tr("Эффекты ({n})", { n: sel.effects.length }) }}</span>
              <el-select :placeholder="tr('+ эффект')" size="small" style="width: 190px" :model-value="''"
                @update:model-value="addEffect($event)">
                <el-option v-for="s in EFFECT_SPECS" :key="s.kind" :value="s.kind" :label="tr(s.label)" />
              </el-select>
            </div>
            <div v-for="(e, i) in sel.effects" :key="'e' + i" class="ev-item d2-card"
              :data-card="'e' + i" :class="{ flash: flashCard === 'e' + i }">
              <div class="ev-item-head">
                <span>{{ i + 1 }}. {{ effLabel(e) }}</span>
                <span class="ev-item-actions">
                  <el-button size="small" text class="icon-btn" :disabled="i === 0" @click="moveEffect(i, -1)">↑</el-button>
                  <el-button size="small" text class="icon-btn" :disabled="i === sel.effects.length - 1" @click="moveEffect(i, 1)">↓</el-button>
                  <el-button size="small" text class="icon-btn" @click="removeEffect(i)">🗑</el-button>
                </span>
              </div>
              <div v-for="f in effFields(e)" :key="f.key" class="ev-field">
                <label>{{ tr(f.label) }}</label>
                <EventFieldInput :field="f" :model-value="(e as Record<string, unknown>)[f.key]"
                  @update:model-value="setEffField(i, f.key, $event)" />
              </div>
            </div>
          </el-scrollbar>
          <el-empty v-else :description="tr('Выберите или создайте событие')" :image-size="60" />
        </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.sc-title { font-weight: 600; font-size: 14px; }
.ev-tabs { --el-tabs-header-height: 34px; font-size: 12px; }
.ev-tabs :deep(.el-tabs__header) { margin: 0 0 8px; }
/* navigation trail (back + crumbs) */
.sc-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 0 8px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  white-space: nowrap;
}
.sc-navbtn { font-size: 12px; padding: 5px 12px; }
.sc-navbtn + .sc-crumb { margin-left: 8px; }
.sc-crumb { cursor: pointer; }
.sc-crumb:hover:not(.current) { color: var(--el-color-primary); text-decoration: underline; }
.sc-crumb.current { color: var(--el-text-color-primary); font-weight: 600; cursor: default; }
.sc-sep { margin: 0 5px; color: var(--el-border-color); }
.sc-body { height: min(66vh, 640px); min-height: 380px; font-size: 12px; }
.ev-sub { height: 100%; }

/* События tab = a compact toolbar (graph toggle) над сеткой list|(graph)|editor. */
.ev-events { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.ev-toolbar { display: flex; align-items: center; gap: 8px; padding: 0 0 8px; }
.ev-graph-toggle { font-size: 12px; }

/* columns come from the gridColumns computed: the list is collapsible and the graph is
   OPTIONAL (off by default), so the default is a roomy list | editor 2-column layout. */
.ev-grid {
  display: grid;
  gap: 0;
  flex: 1;
  min-height: 0;
}
.ev-list-expand {
  border: none;
  background: var(--el-fill-color-lighter);
  border-radius: var(--d2-radius);
  cursor: pointer;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  padding: 8px 2px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.ev-list-expand:hover { color: var(--el-text-color-primary); background: var(--el-fill-color-light); }
.ev-list-expand-lbl { writing-mode: vertical-rl; letter-spacing: 0.08em; font-size: 10px; text-transform: uppercase; }
.ev-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.ev-col-list { padding-right: 8px; }
.ev-col-graph { padding: 0 8px; }
.ev-col-editor { padding-left: 8px; }
.d2-rail--left + .ev-col-graph { border-left: none; }

.ev-subhead { display: flex; align-items: center; gap: 8px; padding: 2px 0 6px; }
.ev-count { color: var(--el-text-color-secondary); margin-right: auto; }
.ev-search { padding: 0 0 6px; }
.ev-objfilter { padding: 0 0 6px; color: var(--el-text-color-secondary); }
.ev-list { flex: 1; min-height: 0; }
.ev-row { padding: 5px 10px; cursor: pointer; }
.ev-row-main { display: flex; justify-content: space-between; gap: 8px; }
.ev-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev-id { color: var(--el-text-color-secondary); font-family: monospace; font-size: 11px; }
.ev-badges { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
/* role icons before the counts; the auto margin moved here (span always renders) so
   icons + counts sit together on the right edge */
.ev-icons { margin-left: auto; font-size: 11px; line-height: 1; letter-spacing: 1px; }
.ev-ce { color: var(--el-text-color-secondary); }
/* событие без эффектов инертно (обычно недоделанная заготовка) — мягкий варнинг */
.ev-ce-inert { color: var(--el-color-warning); }
/* курсор на бейдже этого события на КАРТЕ — зеркальная подсветка строки списка */
.ev-row.map-hover { box-shadow: inset 0 0 0 1px var(--el-color-warning); background: var(--el-fill-color-light); }
.ev-editor { flex: 1; min-height: 0; }
.ev-props { display: flex; flex-wrap: wrap; gap: 10px 14px; margin: 12px 0; align-items: center; }
.ev-props label { display: inline-flex; align-items: center; gap: 5px; color: var(--el-text-color-regular); }
/* races: a tight 3-column grid (was a wrapping flex that stacked into a 230px block) */
.ev-races { margin-bottom: 10px; }
.ev-races-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 8px; margin: 4px 0; }
.ev-races-lbl { grid-column: 1 / -1; color: var(--el-text-color-secondary); font-size: 11px; }
.ev-races :deep(.el-checkbox) { height: 22px; margin-right: 0; }
.ev-races :deep(.el-checkbox__label) { font-size: 12px; padding-left: 5px; }
.ev-sec-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: var(--d2-sp-4) 0 6px;
}
/* zone-event group: badge toggles the folded clones; clone rows indent under the base */
.ev-zone-badge { cursor: pointer; }
.ev-row.is-clone { padding-left: 22px; opacity: 0.85; }
.ev-zone-clone {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 8px 8px 0 0; padding: 6px 8px;
  background: var(--el-fill-color-lighter); border-radius: var(--d2-radius);
  font-size: 12px;
}
.ev-zone-lbl { color: var(--el-text-color-secondary); cursor: help; }
.ev-sec-head .d2-sec { margin: 0; }
.ev-item { margin-bottom: 8px; margin-right: 8px; }
/* graph-click reveal: a fading ring pulls the eye to the card just scrolled to */
.ev-item.flash { animation: card-flash 1.25s ease-out; }
@keyframes card-flash {
  0% { box-shadow: 0 0 0 2px var(--el-color-primary); }
  100% { box-shadow: 0 0 0 6px transparent; }
}
.ev-item-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 4px; }
.ev-item-actions { display: inline-flex; }
.ev-field { display: grid; grid-template-columns: 96px 1fr; gap: 6px; align-items: center; margin: 6px 0; }
.ev-field > label { color: var(--el-text-color-secondary); }
.icon-btn { opacity: 0.6; transition: opacity 0.12s; }
.icon-btn:hover { opacity: 1; }
</style>

<!-- the dialog itself teleports to <body>: style it unscoped -->
<style>
.scenario-dialog {
  --el-dialog-padding-primary: 12px;
  border-radius: 12px;
  box-shadow: var(--el-box-shadow);
}
.scenario-dialog .el-dialog__header { padding-bottom: 4px; }
.scenario-dialog .el-dialog__body { padding-top: 0; }
</style>
