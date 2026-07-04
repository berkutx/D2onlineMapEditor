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

  /** Graph → editor column: "scroll to this condition/effect card". EventsPanel watches it,
   *  scrolls the card into view and flashes it. `tick` makes repeat clicks re-fire. */
  const cardReveal = ref<{ kind: "cond" | "eff"; index: number; tick: number } | null>(null);
  function revealCard(kind: "cond" | "eff", index: number): void {
    cardReveal.value = { kind, index, tick: (cardReveal.value?.tick ?? 0) + 1 };
  }

  /** Commit a full event (add or replace) as one undoable edit. If the event is the BASE
   *  of a zone clone group, the clones re-stamp from it in the SAME commit — clones are
   *  DERIVED (copy of the base with their own id/name/location), the user never maintains
   *  them by hand. */
  function upsert(ev: MapEvent): void {
    edit.commit([{ kind: "upsertEvent", event: ev } as EditOp, ...zoneCloneResyncOps(ev)]);
    selectedId.value = ev.id;
  }

  /** Re-derive every clone of `base` (same fields, own id/name/locId). A base that lost
   *  its zone condition unbinds the group: the clones are deleted with it. */
  function zoneCloneResyncOps(base: MapEvent): EditOp[] {
    const ops: EditOp[] = [];
    for (const z of Object.values(edit.zones)) {
      for (const g of z.eventGroups ?? []) {
        if (g[0] !== base.id) continue;
        const ci = zoneCondIndex(base);
        const clones = g.slice(1).filter((id) => events.value.some((e) => e.id === id));
        if (ci < 0) {
          for (const id of clones) ops.push({ kind: "deleteEvent", id } as EditOp);
          edit.dropZoneEventGroup(base.id);
          continue;
        }
        clones.forEach((cloneId, k) => {
          const cur = events.value.find((e) => e.id === cloneId)!;
          const curCi = zoneCondIndex(cur);
          const locId =
            curCi >= 0
              ? ((cur.conditions[curCi] as unknown as Record<string, unknown>).locId as string)
              : undefined;
          if (!locId) return; // clone lost its own zone condition — leave it alone
          ops.push({
            kind: "upsertEvent",
            event: {
              ...base,
              id: cloneId,
              name: `${base.name || "Событие"} · ${k + 2}`,
              conditions: base.conditions.map((c, i) =>
                i === ci ? ({ ...c, locId } as EventCondition) : c),
            },
          } as EditOp);
        });
      }
    }
    return ops;
  }

  function remove(id: string): void {
    const ops: EditOp[] = [{ kind: "deleteEvent", id } as EditOp];
    // deleting a zone-group BASE takes its derived clones along; deleting a clone by hand
    // only drops it from the group (the rest stay derived)
    let wasBase = false;
    for (const z of Object.values(edit.zones)) {
      for (const g of z.eventGroups ?? []) {
        if (g[0] === id) {
          wasBase = true;
          for (const cid of g.slice(1))
            if (events.value.some((e) => e.id === cid)) ops.push({ kind: "deleteEvent", id: cid } as EditOp);
        }
      }
    }
    edit.commit(ops);
    if (wasBase) edit.dropZoneEventGroup(id);
    else edit.removeCloneFromZoneGroups(id);
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

  /** «✨ Спавн отряда здесь»: one click builds a spawn trigger for a location — a new event
   *  with a createStack effect pre-wired to `locId` (день-1 периодичность как у типовых
   *  спавнов; шаблон отряда выбирается в редакторе). Navigates to it. */
  function createSpawnAt(locId: string, locName?: string): MapEvent {
    const ev: MapEvent = {
      ...blankEvent(),
      name: `Спавн: ${locName || locId}`,
      conditions: [{ ...makeCondition("frequency"), days: 1 } as EventCondition],
      effects: [{ ...makeEffect("createStack"), locId } as EventEffect],
    };
    upsert(ev);
    navigate({ tab: "events", eventId: ev.id });
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

  /** Batch id allocator — newId() reads only COMMITTED events, so builders that create
   *  several events in ONE commit must allocate the whole batch up front. */
  function allocEventIds(n: number): string[] {
    const version = edit.liveDoc?.header.version || "S143";
    let next = 0;
    for (const e of events.value) {
      const m = /EV([0-9a-fA-F]{4})$/.exec(e.id);
      if (m) next = Math.max(next, parseInt(m[1]!, 16) + 1);
    }
    return Array.from({ length: n }, (_, i) => `${version}EV${(next + i).toString(16).padStart(4, "0")}`);
  }

  /** Fresh auto-variable (id = max+1) with a slugged name; caller puts it in a setVariables op. */
  function makeAutoVar(prefix: string, seed: string): ScenarioVariable {
    const id = Math.max(0, ...variables.value.map((v) => v.id)) + 1;
    const slug = seed.replace(/[^0-9A-Za-zА-Яа-яЁё]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "x";
    return { id, name: `${prefix}_${slug}`, value: 0 };
  }
  const gateCondFor = (varId: number): EventCondition =>
    ({
      ...makeCondition("varInRange"),
      var1: varId, min1: 0, max1: 0, var2: 0, min2: 0, max2: 0, relation: 0,
    }) as EventCondition;
  const incEffFor = (varId: number, at: number): EventEffect => {
    const inc = { ...makeEffect("modifyVariable"), lookup: 0, val1: 1, val2: varId } as EventEffect;
    (inc as { num: number }).num = at;
    return inc;
  };

  /** «⊻ или-ветка»: альтернатива текущему событию — сработает ТОЛЬКО одна из веток.
   *  Общая гейт-переменная AUTO_или_*: условие «==0» + «+1»-эффект на каждой ветке;
   *  повторный вызов на любой ветке добавляет ещё одну ветку в ту же группу. */
  function createOrBranch(fromId: string): MapEvent | null {
    const from = events.value.find((e) => e.id === fromId);
    if (!from) return null;
    // reuse the group's gate if this event already carries one (an AUTO_или_* auto-var)
    const autoIds = new Set(edit.autoVars);
    let gateId: number | null = null;
    for (const c of from.conditions) {
      if (c.kind !== "varInRange") continue;
      const rc = c as unknown as Record<string, number>;
      const v = variables.value.find((x) => x.id === rc.var1);
      if (v && autoIds.has(v.id) && v.name.startsWith("AUTO_или_") && rc.min1 === 0 && rc.max1 === 0) {
        gateId = v.id;
        break;
      }
    }
    const ops: EditOp[] = [];
    let isNewVar = false;
    if (gateId === null) {
      const nv = makeAutoVar("AUTO_или", from.name || fromId);
      ops.push({ kind: "setVariables", variables: [...variables.value, nv] } as EditOp);
      gateId = nv.id;
      isNewVar = true;
      ops.push({
        kind: "upsertEvent",
        event: {
          ...from,
          conditions: [...from.conditions, gateCondFor(gateId)],
          effects: [...from.effects, incEffFor(gateId, from.effects.length)],
        },
      } as EditOp);
    }
    const branch: MapEvent = {
      ...blankEvent(),
      name: `${from.name || "Событие"} — или…`,
      conditions: [gateCondFor(gateId)],
      effects: [incEffFor(gateId, 0)],
    };
    ops.push({ kind: "upsertEvent", event: branch } as EditOp);
    edit.commit(ops);
    if (isNewVar) edit.markAutoVar(gateId);
    navigate({ tab: "events", eventId: branch.id });
    return branch;
  }

  // --- phases: ONE shared AUTO_фаза variable; events bind to a phase (условие ==K),
  // transitions are «присвоить K» effects. The builders keep the variable hidden.
  function phaseVarId(): number | null {
    const autoIds = new Set(edit.autoVars);
    const v = variables.value.find((x) => autoIds.has(x.id) && x.name === "AUTO_фаза");
    return v ? v.id : null;
  }
  /** Ensure the shared phase variable exists; returns [id, setup-op or null, isNew]. */
  function ensurePhaseVar(): { id: number; op: EditOp | null; isNew: boolean } {
    const existing = phaseVarId();
    if (existing !== null) return { id: existing, op: null, isNew: false };
    const nv: ScenarioVariable = { id: Math.max(0, ...variables.value.map((v) => v.id)) + 1, name: "AUTO_фаза", value: 0 };
    return { id: nv.id, op: { kind: "setVariables", variables: [...variables.value, nv] } as EditOp, isNew: true };
  }
  /** «⚑ фаза K»: событие срабатывает только в фазе K (условие ==K; повторный вызов меняет K). */
  function bindEventToPhase(eventId: string, phase: number): boolean {
    const from = events.value.find((e) => e.id === eventId);
    if (!from) return false;
    const { id: varId, op, isNew } = ensurePhaseVar();
    const ops: EditOp[] = op ? [op] : [];
    const existing = from.conditions.findIndex(
      (c) => c.kind === "varInRange" && (c as unknown as Record<string, number>).var1 === varId,
    );
    const cond = { ...gateCondFor(varId), min1: phase, max1: phase } as EventCondition;
    const conditions =
      existing >= 0
        ? from.conditions.map((c, i) => (i === existing ? cond : c))
        : [...from.conditions, cond];
    ops.push({ kind: "upsertEvent", event: { ...from, conditions } } as EditOp);
    edit.commit(ops);
    if (isNew) edit.markAutoVar(varId);
    return true;
  }
  /** «⚑➜ в фазу K»: эффект «присвоить фазе K» в конец списка эффектов события. */
  function addGotoPhaseEffect(eventId: string, phase: number): boolean {
    const from = events.value.find((e) => e.id === eventId);
    if (!from) return false;
    const { id: varId, op, isNew } = ensurePhaseVar();
    const ops: EditOp[] = op ? [op] : [];
    const set = { ...makeEffect("modifyVariable"), lookup: 4, val1: phase, val2: varId } as EventEffect;
    (set as { num: number }).num = from.effects.length;
    ops.push({ kind: "upsertEvent", event: { ...from, effects: [...from.effects, set] } } as EditOp);
    edit.commit(ops);
    if (isNew) edit.markAutoVar(varId);
    return true;
  }

  /** «⏲ через N дней после X»: X включает скрытый тикер (раз в день «+1» в AUTO_таймер_*),
   *  продолжение срабатывает при счётчике ≥N и выключает тикер. Один commit. */
  function createTimerAfter(fromId: string, days: number): MapEvent | null {
    const from = events.value.find((e) => e.id === fromId);
    if (!from || days < 1) return null;
    const counter = makeAutoVar("AUTO_таймер", from.name || fromId);
    const [tickerId, gateId] = allocEventIds(2) as [string, string];
    const ticker: MapEvent = {
      ...blankEvent(),
      id: tickerId,
      name: `${from.name || "Событие"} — счёт дней`,
      enabled: false, // X включает
      occurOnce: false, // тикает каждый день
      conditions: [{ ...makeCondition("frequency"), days: 1 } as EventCondition],
      effects: [incEffFor(counter.id, 0)],
    };
    const stopTicker = { ...makeEffect("enableEvent"), eventId: tickerId, enable: false } as EventEffect;
    (stopTicker as { num: number }).num = 0;
    const gate: MapEvent = {
      ...blankEvent(),
      id: gateId,
      name: `${from.name || "Событие"} — через ${days} дн.`,
      conditions: [
        { ...makeCondition("varInRange"), var1: counter.id, min1: days, max1: 9999, var2: 0, min2: 0, max2: 0, relation: 0 } as EventCondition,
      ],
      effects: [stopTicker],
    };
    const startTicker = { ...makeEffect("enableEvent"), eventId: tickerId, enable: true } as EventEffect;
    (startTicker as { num: number }).num = from.effects.length;
    edit.commit([
      { kind: "setVariables", variables: [...variables.value, counter] } as EditOp,
      { kind: "upsertEvent", event: ticker } as EditOp,
      { kind: "upsertEvent", event: gate } as EditOp,
      { kind: "upsertEvent", event: { ...from, effects: [...from.effects, startTicker] } } as EditOp,
    ]);
    edit.markAutoVar(counter.id);
    navigate({ tab: "events", eventId: gate.id });
    return gate;
  }

  /** Condition kinds that reference ONE location — the game allows a single zone condition
   *  per event (AND-only), so «событие на зону» = per-location clones of the event. */
  const ZONE_COND_KINDS = new Set(["enterZone", "stackInLocation", "itemToLocation"]);
  function zoneCondIndex(ev: MapEvent): number {
    return ev.conditions.findIndex((c) => ZONE_COND_KINDS.has(c.kind));
  }

  /** «⧉ на зону»: разложить событие с зонным условием (вход/отряд/предмет в зоне) на клоны —
   *  по одному на каждую локацию-примитив зоны. `oncePerZone` добавляет счётчик-гейт по
   *  паттерну createCounterGate: скрытая авто-переменная, условие «==0» и «+1»-эффект на
   *  каждом клоне — сработает только первый вошедший. ОДИН commit (undo одним шагом);
   *  группа [base, ...clones] пишется в project.zones для сворачивания в списке. */
  function cloneEventForZone(eventId: string, zoneId: string, oncePerZone: boolean): number {
    const from = events.value.find((e) => e.id === eventId);
    const zone = edit.zones[zoneId];
    if (!from || !zone || zone.locIds.length < 2) return 0;
    const ci = zoneCondIndex(from);
    if (ci < 0) return 0;
    const curLoc = (from.conditions[ci] as unknown as Record<string, unknown>).locId as string;

    // id allocator: newId() reads only COMMITTED events — allocate the batch by hand
    const version = edit.liveDoc?.header.version || "S143";
    let nextHex = 0;
    for (const e of events.value) {
      const m = /EV([0-9a-fA-F]{4})$/.exec(e.id);
      if (m) nextHex = Math.max(nextHex, parseInt(m[1]!, 16) + 1);
    }

    // one event per zone location: the base covers its own (or the first) location
    const locs = zone.locIds.filter((id) => edit.liveDoc?.objects.some((o) => o.id === id));
    if (locs.length < 2) return 0;
    const baseLoc = locs.includes(curLoc) ? curLoc : locs[0]!;
    const cloneLocs = locs.filter((id) => id !== baseLoc);

    const ops: EditOp[] = [];
    // re-binding: a previous clone group of this base (this OR another zone) is superseded —
    // its clones die in the same commit, the group record is replaced
    let hadGroup = false;
    for (const z of Object.values(edit.zones)) {
      for (const g of z.eventGroups ?? []) {
        if (g[0] !== from.id) continue;
        hadGroup = true;
        for (const cid of g.slice(1))
          if (events.value.some((e) => e.id === cid)) ops.push({ kind: "deleteEvent", id: cid } as EditOp);
      }
    }
    if (hadGroup) edit.dropZoneEventGroup(from.id);

    // «один раз на зону»: reuse the base's existing AUTO_зона gate if it already carries one
    // (clones are copies — the gate rides along); otherwise mint the variable + gate now
    const hasGate = from.conditions.some((c) => {
      if (c.kind !== "varInRange") return false;
      const v = variables.value.find((x) => x.id === (c as unknown as Record<string, number>).var1);
      return !!v && v.name.startsWith("AUTO_зона_") && edit.autoVars.includes(v.id);
    });
    let gateCond: EventCondition | null = null;
    let gateEff: ((ev: MapEvent) => EventEffect) | null = null;
    if (oncePerZone && !hasGate) {
      const newVarId = Math.max(0, ...variables.value.map((v) => v.id)) + 1;
      const slug = (zone.name || zoneId).replace(/[^0-9A-Za-zА-Яа-яЁё]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || zoneId;
      const newVar: ScenarioVariable = { id: newVarId, name: `AUTO_зона_${slug}`, value: 0 };
      ops.push({ kind: "setVariables", variables: [...variables.value, newVar] } as EditOp);
      gateCond = {
        ...makeCondition("varInRange"),
        var1: newVarId, min1: 0, max1: 0,
        var2: 0, min2: 0, max2: 0,
        relation: 0, // Игнор. 2-ю
      } as EventCondition;
      gateEff = (ev) => {
        const inc = { ...makeEffect("modifyVariable"), lookup: 0, val1: 1, val2: newVarId } as EventEffect;
        (inc as { num: number }).num = ev.effects.length;
        return inc;
      };
      edit.markAutoVar(newVarId);
    }

    const withGate = (ev: MapEvent): MapEvent =>
      gateCond && gateEff
        ? { ...ev, conditions: [...ev.conditions, gateCond], effects: [...ev.effects, gateEff(ev)] }
        : ev;

    const base: MapEvent = withGate({
      ...from,
      conditions: from.conditions.map((c, i) =>
        i === ci ? ({ ...c, locId: baseLoc } as EventCondition) : c),
    });
    ops.push({ kind: "upsertEvent", event: base } as EditOp);

    const cloneIds: string[] = [];
    cloneLocs.forEach((locId, k) => {
      const id = `${version}EV${(nextHex + k).toString(16).padStart(4, "0")}`;
      cloneIds.push(id);
      const clone: MapEvent = withGate({
        ...from,
        id,
        name: `${from.name || "Событие"} · ${k + 2}`,
        conditions: from.conditions.map((c, i) =>
          i === ci ? ({ ...c, locId } as EventCondition) : c),
      });
      ops.push({ kind: "upsertEvent", event: clone } as EditOp);
    });

    edit.commit(ops);
    edit.recordZoneEventGroup(zoneId, [from.id, ...cloneIds]);
    return cloneIds.length;
  }

  /** After a zone REGENERATION its primitives are new — every clone group re-derives:
   *  stale clones die, the base repoints at the first new primitive, fresh clones are
   *  minted (an existing «один раз» gate rides along in the copies). */
  function resyncZoneEventsAfterRegen(zid: string): number {
    const z = edit.zones[zid];
    if (!z) return 0;
    const groups = (z.eventGroups ?? []).slice();
    let total = 0;
    for (const g of groups) {
      const baseId = g[0]!;
      const base = events.value.find((e) => e.id === baseId);
      const ci = base ? zoneCondIndex(base) : -1;
      const locs = z.locIds.filter((id) => edit.liveDoc?.objects.some((o) => o.id === id));
      if (!base || ci < 0 || !locs.length) {
        // nothing to re-derive — purge stale clones + the record
        const ops: EditOp[] = g.slice(1)
          .filter((id) => events.value.some((e) => e.id === id))
          .map((id) => ({ kind: "deleteEvent", id }) as EditOp);
        if (ops.length) edit.commit(ops);
        edit.dropZoneEventGroup(baseId);
        continue;
      }
      // repoint the base at a live primitive (old ones are deleted); purge stale clones
      const ops: EditOp[] = g.slice(1)
        .filter((id) => events.value.some((e) => e.id === id))
        .map((id) => ({ kind: "deleteEvent", id }) as EditOp);
      ops.push({
        kind: "upsertEvent",
        event: {
          ...base,
          conditions: base.conditions.map((c, i) =>
            i === ci ? ({ ...c, locId: locs[0]! } as EventCondition) : c),
        },
      } as EditOp);
      edit.commit(ops);
      edit.dropZoneEventGroup(baseId);
      total += cloneEventForZone(baseId, zid, false); // существующий гейт едет в копиях
    }
    return total;
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
    breadcrumbs, canGoBack, navigate, goBack, goToCrumb, cardReveal, revealCard,
    createForObject, createChainedEvent, createCounterGate, createSpawnAt,
    cloneEventForZone, zoneCondIndex, resyncZoneEventsAfterRegen,
    createOrBranch, bindEventToPhase, addGotoPhaseEffect, createTimerAfter, phaseVarId,
    variables, setVariables, addVariable, patchVariable, removeVariable,
    templates, selectedTemplateId, selectedTemplate, selectTemplate,
    upsertTemplate, removeTemplate, createTemplate, cloneTemplate,
    header, setScenarioInfo, diplomacy, setDiplomacy, setDiplomacyRelation,
  };
});
