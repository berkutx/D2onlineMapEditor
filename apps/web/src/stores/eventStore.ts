/**
 * Event editing state: selection + filter over the live document's scenario events, and
 * CRUD that flows through editStore.commit (undoable + collab-broadcast) as upsertEvent /
 * deleteEvent ops. The editor works on the model; the .sg MidEvent blocks are (re)written on
 * export. See docs/reference-gaps-events.md.
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { MapEvent, EventCondition, EventEffect, ScenarioVariable, StackTemplate, DiplomacyEntry } from "@d2/map-schema";
import type { ScenarioInfoPatch } from "@d2/socket-contract";
import { CONDITION_BY_KIND, EFFECT_BY_KIND } from "@d2/map-schema";
import type { EditOp } from "@d2/map-edit";
import { useEditStore } from "./editStore";

/** A blank value for a spec field (so a freshly added condition/effect is schema-valid). */
function blankField(type: string): unknown {
  if (type === "bool") return false;
  if (type === "int" || type === "enum" || type === "var") return 0;
  return ""; // text / ref-* / template / item / spell
}

/** Build a default condition of `kind` with every field at its blank value. */
export function makeCondition(kind: string): EventCondition {
  const spec = CONDITION_BY_KIND[kind]!;
  const out: Record<string, unknown> = { kind };
  for (const f of spec.fields) out[f.key] = blankField(f.type);
  return out as EventCondition;
}
/** Build a default effect of `kind` (num assigned by the caller/order). */
export function makeEffect(kind: string): EventEffect {
  const spec = EFFECT_BY_KIND[kind]!;
  const out: Record<string, unknown> = { kind, num: 0 };
  for (const f of spec.fields) out[f.key] = blankField(f.type);
  if (kind === "changeFog") out.entries = [];
  return out as EventEffect;
}

export const useEventStore = defineStore("events", () => {
  const edit = useEditStore();

  const selectedId = ref<string | null>(null);
  const filter = ref("");
  /** When set, the panel shows only events referencing this object id (per-object view). */
  const objectFilter = ref<string | null>(null);
  /** Active tab of the scenario window — in the store so «где используется» jumps
   *  (variables → event, graph var-node → variables tab) can switch it from outside. */
  const panelTab = ref<"events" | "vars" | "templates" | "settings" | "diplomacy">("events");

  const events = computed<MapEvent[]>(() => edit.liveDoc?.events ?? []);

  const selected = computed<MapEvent | null>(
    () => events.value.find((e) => e.id === selectedId.value) ?? null,
  );

  /** Does an event reference `objId` in any condition/effect ref field? */
  function referencesObject(ev: MapEvent, objId: string): boolean {
    const refKeys = ["locId", "cityId", "stackId", "siteId", "ruinId", "lmarkId", "templateId", "stackTmpId", "orderTarget", "eventId", "player", "player1", "player2"];
    for (const part of [...ev.conditions, ...ev.effects] as Record<string, unknown>[]) {
      for (const k of refKeys) if (part[k] === objId) return true;
    }
    return false;
  }

  const filtered = computed<MapEvent[]>(() => {
    const q = filter.value.trim().toLowerCase();
    let list = events.value;
    if (objectFilter.value) list = list.filter((e) => referencesObject(e, objectFilter.value!));
    if (q) list = list.filter((e) => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q));
    // keep authoring order (event ORDER then id) so the list matches the game's evaluation order
    return [...list].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  });

  function select(id: string | null): void {
    selectedId.value = id;
  }

  // --- navigation history («хлебные крошки» + назад) ------------------------------------
  // Every jump inside the scenario window (graph satellite, variable chip, list click,
  // map context menu) goes through navigate(); goBack() restores the previous stop.
  type PanelTab = "events" | "vars" | "templates" | "settings" | "diplomacy";
  interface NavEntry { tab: PanelTab; eventId: string | null }
  const navStack = ref<NavEntry[]>([]);
  const TAB_LABELS: Record<PanelTab, string> = {
    events: "События", vars: "Переменные", templates: "Шаблоны",
    settings: "Настройки", diplomacy: "Дипломатия",
  };
  function navLabel(e: NavEntry): string {
    if (e.tab === "events" && e.eventId) {
      const ev = events.value.find((x) => x.id === e.eventId);
      return ev?.name || e.eventId;
    }
    return TAB_LABELS[e.tab];
  }
  /** Breadcrumb trail: the last few stops + the current one (labels resolved live). */
  const breadcrumbs = computed(() => {
    const cur: NavEntry = { tab: panelTab.value, eventId: selectedId.value };
    const trail = [...navStack.value.slice(-4), cur];
    return trail.map((e, i) => ({ ...e, label: navLabel(e), current: i === trail.length - 1 }));
  });
  const canGoBack = computed(() => navStack.value.length > 0);
  /** Jump somewhere, remembering where we were (skips no-op jumps). */
  function navigate(to: { tab?: PanelTab; eventId?: string | null }): void {
    const tab = to.tab ?? panelTab.value;
    const eventId = to.eventId !== undefined ? to.eventId : selectedId.value;
    if (tab === panelTab.value && eventId === selectedId.value) return;
    navStack.value = [...navStack.value.slice(-29), { tab: panelTab.value, eventId: selectedId.value }];
    panelTab.value = tab;
    if (to.eventId !== undefined) selectedId.value = to.eventId;
  }
  function goBack(): void {
    const prev = navStack.value[navStack.value.length - 1];
    if (!prev) return;
    navStack.value = navStack.value.slice(0, -1);
    panelTab.value = prev.tab;
    selectedId.value = prev.eventId;
  }
  /** Breadcrumb click: index into breadcrumbs (last = current, no-op). */
  function goToCrumb(i: number): void {
    const trailStart = Math.max(0, navStack.value.length - 4);
    const target = navStack.value[trailStart + i];
    if (!target) return; // clicked the current crumb
    navStack.value = navStack.value.slice(0, trailStart + i);
    panelTab.value = target.tab;
    selectedId.value = target.eventId;
  }

  /** Commit a full event (add or replace) as one undoable edit. */
  function upsert(ev: MapEvent): void {
    edit.commit([{ kind: "upsertEvent", event: ev } as EditOp]);
    selectedId.value = ev.id;
  }

  function remove(id: string): void {
    edit.commit([{ kind: "deleteEvent", id } as EditOp]);
    if (selectedId.value === id) selectedId.value = null;
  }

  /** A fresh, VALID on-disk event id (<version>EV<hex4>, max existing + 1) so the model and the
   *  exported .sg agree — the writer keeps a valid non-colliding id as-is. */
  function newId(): string {
    const version = edit.liveDoc?.header.version || "S143";
    let next = 0;
    for (const e of events.value) {
      const m = new RegExp(`EV([0-9a-fA-F]{4})$`).exec(e.id);
      if (m) next = Math.max(next, parseInt(m[1]!, 16) + 1);
    }
    return `${version}EV${next.toString(16).padStart(4, "0")}`;
  }

  function create(): MapEvent {
    const ev = blankEvent();
    upsert(ev);
    return ev;
  }

  function clone(src: MapEvent): MapEvent {
    const copy: MapEvent = JSON.parse(JSON.stringify(src));
    copy.id = newId();
    copy.name = `${src.name || "Событие"} (копия)`;
    upsert(copy);
    return copy;
  }

  /** Which condition kind (and its ref field) fits an object type — for one-click
   *  «+ Событие с этим объектом» from the map context menu. */
  const OBJ_CONDITION: Record<string, { kind: string; key: string }> = {
    location: { kind: "enterZone", key: "locId" },
    stack: { kind: "destroyStack", key: "stackId" },
    village: { kind: "enterCity", key: "cityId" },
    capital: { kind: "enterCity", key: "cityId" },
    ruin: { kind: "lootingRuin", key: "ruinId" },
    merchant: { kind: "visitingSite", key: "siteId" },
    mage: { kind: "visitingSite", key: "siteId" },
    trainer: { kind: "visitingSite", key: "siteId" },
    mercenary: { kind: "visitingSite", key: "siteId" },
  };

  /** A blank event object (NOT committed) — shared by create/createForObject/chained. */
  function blankEvent(): MapEvent {
    return {
      id: newId(),
      name: "Новое событие",
      enabled: true,
      occurOnce: true,
      chance: 100,
      order: (events.value.reduce((m, e) => Math.max(m, e.order), 0) || 0) + 1,
      appliesTo: { human: true, dwarf: true, undead: true, heretic: true, neutral: true, elf: true },
      canTrigger: { human: true, dwarf: true, undead: true, heretic: true, neutral: true, elf: true },
      conditions: [],
      effects: [],
    };
  }

  /** Create an event PRE-WIRED to a map object (condition prefilled by its type) —
   *  one commit, one undo step. */
  function createForObject(objId: string, objType: string, objName?: string): MapEvent {
    const map = OBJ_CONDITION[objType];
    const ev: MapEvent = {
      ...blankEvent(),
      ...(objName ? { name: `Событие: ${objName}` } : {}),
      ...(map
        ? { conditions: [{ ...makeCondition(map.kind), [map.key]: objId } as EventCondition] }
        : {}),
    };
    upsert(ev);
    return ev;
  }

  /** «➜ следующее в цепочке»: creates a DISABLED follow-up event and auto-adds an
   *  enableEvent effect on `fromId` pointing at it — the chain wires itself.
   *  Both ops land in ONE commit (one undo step). */
  function createChainedEvent(fromId: string): MapEvent | null {
    const from = events.value.find((e) => e.id === fromId);
    if (!from) return null;
    const next: MapEvent = {
      ...blankEvent(),
      name: `${from.name || "Событие"} — продолжение`,
      enabled: false, // starts OFF; the chain switches it on
    };
    const eff = { ...makeEffect("enableEvent"), eventId: next.id, enable: true } as EventEffect;
    (eff as { num: number }).num = from.effects.length;
    edit.commit([
      { kind: "upsertEvent", event: next } as EditOp,
      { kind: "upsertEvent", event: { ...from, effects: [...from.effects, eff] } } as EditOp,
    ]);
    navigate({ tab: "events", eventId: next.id });
    return next;
  }

  /** «⏱ после N раз…»: builds a COUNTER GATE off `fromId` with an AUTO-generated (hidden)
   *  variable — the E5 answer to «скрыть переменные, если генерим их риалтайм при связях»:
   *  (a) a new variable (value 0), (b) a «+1» modifyVariable effect appended to the source
   *  event, (c) a NEW enabled event firing once the counter reaches `threshold`
   *  («переменная в диапазоне»). All THREE ops in ONE commit = one undo step. The auto mark
   *  is editor-only metadata OUTSIDE the journal (an orphaned mark is harmless — the
   *  variables tab filters marks against the live variable list). */
  function createCounterGate(fromId: string, threshold: number): MapEvent | null {
    const from = events.value.find((e) => e.id === fromId);
    if (!from) return null;
    const newVarId = Math.max(0, ...variables.value.map((v) => v.id)) + 1;
    const slug =
      (from.name || fromId)
        .replace(/[^0-9A-Za-zА-Яа-яЁё]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || fromId;
    const newVar: ScenarioVariable = { id: newVarId, name: `AUTO_${slug}_${threshold}`, value: 0 };
    const inc = { ...makeEffect("modifyVariable"), lookup: 0, val1: 1, val2: newVarId } as EventEffect;
    (inc as { num: number }).num = from.effects.length;
    const gate: MapEvent = {
      ...blankEvent(),
      name: `${from.name || "Событие"} — после ${threshold} раз`,
      enabled: true,
      conditions: [
        {
          ...makeCondition("varInRange"),
          var1: newVarId, min1: threshold, max1: 9999,
          var2: 0, min2: 0, max2: 0,
          relation: 0, // Игнор. 2-ю
        } as EventCondition,
      ],
    };
    edit.commit([
      { kind: "setVariables", variables: [...variables.value, newVar] } as EditOp,
      { kind: "upsertEvent", event: { ...from, effects: [...from.effects, inc] } } as EditOp,
      { kind: "upsertEvent", event: gate } as EditOp,
    ]);
    edit.markAutoVar(newVarId);
    navigate({ tab: "events", eventId: gate.id });
    return gate;
  }

  // --- scenario variables (one MidScenVariables block; edited as a whole list) ---
  const variables = computed<ScenarioVariable[]>(() => edit.liveDoc?.variables ?? []);
  function setVariables(vars: ScenarioVariable[]): void {
    edit.commit([{ kind: "setVariables", variables: vars } as EditOp]);
  }
  function addVariable(): void {
    const nextId = Math.max(0, ...variables.value.map((v) => v.id)) + 1;
    setVariables([...variables.value, { id: nextId, name: `VAR_${nextId}`, value: 0 }]);
  }
  function patchVariable(id: number, partial: Partial<ScenarioVariable>): void {
    setVariables(variables.value.map((v) => (v.id === id ? { ...v, ...partial } : v)));
  }
  function removeVariable(id: number): void {
    setVariables(variables.value.filter((v) => v.id !== id));
  }

  // --- stack templates ---
  const templates = computed<StackTemplate[]>(() => edit.liveDoc?.templates ?? []);
  const selectedTemplateId = ref<string | null>(null);
  const selectedTemplate = computed<StackTemplate | null>(
    () => templates.value.find((t) => t.id === selectedTemplateId.value) ?? null,
  );
  function selectTemplate(id: string | null): void {
    selectedTemplateId.value = id;
  }
  function newTemplateId(): string {
    const version = edit.liveDoc?.header.version || "S143";
    let next = 0;
    for (const t of templates.value) {
      const m = /TM([0-9a-fA-F]{4})$/.exec(t.id);
      if (m) next = Math.max(next, parseInt(m[1]!, 16) + 1);
    }
    return `${version}TM${next.toString(16).padStart(4, "0")}`;
  }
  function upsertTemplate(t: StackTemplate): void {
    edit.commit([{ kind: "upsertTemplate", template: t } as EditOp]);
    selectedTemplateId.value = t.id;
  }
  function removeTemplate(id: string): void {
    edit.commit([{ kind: "deleteTemplate", id } as EditOp]);
    if (selectedTemplateId.value === id) selectedTemplateId.value = null;
  }
  function createTemplate(): StackTemplate {
    const t: StackTemplate = {
      id: newTemplateId(), name: "Новый шаблон", owner: "", leader: "", leaderLevel: 1,
      orderTarget: "", subRace: "", order: 1,
      units: [null, null, null, null, null, null],
      useFacing: false, facing: 0, aiPriority: 0, modifiers: [],
    };
    upsertTemplate(t);
    return t;
  }
  function cloneTemplate(src: StackTemplate): StackTemplate {
    const copy: StackTemplate = JSON.parse(JSON.stringify(src));
    copy.id = newTemplateId();
    copy.name = `${src.name || "Шаблон"} (копия)`;
    upsertTemplate(copy);
    return copy;
  }

  // --- scenario settings (ScenarioInfo) + diplomacy ---
  const header = computed(() => edit.liveDoc?.header ?? null);
  function setScenarioInfo(fields: ScenarioInfoPatch): void {
    edit.commit([{ kind: "setScenarioInfo", fields } as EditOp]);
  }
  const diplomacy = computed<DiplomacyEntry[]>(() => edit.liveDoc?.diplomacy ?? []);
  function setDiplomacy(entries: DiplomacyEntry[]): void {
    edit.commit([{ kind: "setDiplomacy", diplomacy: entries } as EditOp]);
  }
  function setDiplomacyRelation(race1: number, race2: number, relation: number): void {
    const norm = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a]);
    const [x, y] = norm(race1, race2);
    const list = diplomacy.value.slice();
    const i = list.findIndex((d) => {
      const [a, b] = norm(d.race1, d.race2);
      return a === x && b === y;
    });
    if (i >= 0) list[i] = { ...list[i]!, relation };
    else list.push({ race1: x, race2: y, relation });
    setDiplomacy(list);
  }

  return {
    selectedId, filter, objectFilter, panelTab, events, selected, filtered,
    select, upsert, remove, create, clone, referencesObject,
    breadcrumbs, canGoBack, navigate, goBack, goToCrumb,
    createForObject, createChainedEvent, createCounterGate,
    variables, setVariables, addVariable, patchVariable, removeVariable,
    templates, selectedTemplateId, selectedTemplate, selectTemplate,
    upsertTemplate, removeTemplate, createTemplate, cloneTemplate,
    header, setScenarioInfo, diplomacy, setDiplomacy, setDiplomacyRelation,
  };
});
