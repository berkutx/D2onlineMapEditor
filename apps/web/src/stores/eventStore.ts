/**
 * Event editing state: selection + filter over the live document's scenario events, and
 * CRUD that flows through editStore.commit (undoable + collab-broadcast) as upsertEvent /
 * deleteEvent ops. The editor works on the model; the .sg MidEvent blocks are (re)written on
 * export. See docs/reference-gaps-events.md.
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { MapEvent, EventCondition, EventEffect } from "@d2/map-schema";
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
    const ev: MapEvent = {
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

  return {
    selectedId, filter, objectFilter, events, selected, filtered,
    select, upsert, remove, create, clone, referencesObject,
  };
});
