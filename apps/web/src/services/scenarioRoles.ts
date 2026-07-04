/**
 * scenarioRoles — computes each map object's SCENARIO ROLE from the live events: which
 * events trigger off it (условия), what spawns/arrives there (эффекты), what environment
 * effects hit it (заклинание/туман/рельеф). One source of truth consumed by the on-map
 * «Роли локаций» overlay, the inspector's «Сценарий» section, and the event-list badges.
 *
 * Generic over the spec tables (CONDITION_SPECS/EFFECT_SPECS): any ref-* field counts, so
 * new event kinds are picked up automatically.
 */
import type { MapDocument, MapEvent } from "@d2/map-schema";
import { CONDITION_BY_KIND, EFFECT_BY_KIND, STACK_ORDER_OPTIONS } from "@d2/map-schema";

/** Role classes (drive overlay color/icon + inspector grouping). `target` = the event
 *  CHANGES this object (removes/re-owns/orders a stack, swaps a landmark) — distinct from
 *  `env`, which is area effects on zones (spell/fog/terrain). */
export type RoleClass = "trigger" | "target" | "spawn" | "destination" | "env";

export interface ObjectRole {
  cls: RoleClass;
  ev: MapEvent;
  /** Human label of the condition/effect that wires this object («Вход в зону»…). */
  what: string;
  /** The condition/effect KIND («enterZone»…) — drives the locations-mode sub-filters. */
  kind: string;
  /** Optional payload detail (e.g. the order name for «Приказ отряду»). */
  detail?: string;
}

/** Per-FIELD role class of effect refs. One effect can wire two objects differently:
 *  «Приказ отряду» changes the stack (target 🎯) and sends it AT the orderTarget (➜).
 *  Fields not listed default to `env` (area effects: заклинание/туман/рельеф/горы). */
const EFFECT_FIELD_CLS: Record<string, Record<string, RoleClass>> = {
  createStack: { locId: "spawn" },
  moveStackToLocation: { stackTmpId: "target", locId: "destination" },
  moveStackToTriggerer: { stackId: "target" },
  changeStackOrder: { stackId: "target", orderTarget: "destination" },
  changeStackOwner: { stackId: "target" },
  goIntoBattle: { stackId: "target" },
  removeStack: { stackId: "target" },
  removeLandmark: { lmarkId: "target" },
  changeLandmark: { lmarkId: "target" },
};
/** Spawn markers for event-list badges. */
const SPAWN_EFFECTS = new Set(["createStack"]);

const ORDER_LABEL = new Map<number, string>(STACK_ORDER_OPTIONS.map((o) => [o.value, o.label]));

/** Per-class display metadata (shared by overlay legend + inspector). */
export const ROLE_META: Record<RoleClass, { icon: string; label: string; color: number }> = {
  trigger: { icon: "⚡", label: "триггер", color: 0xe6a23c },
  target: { icon: "🎯", label: "событие меняет объект", color: 0xf56c6c },
  spawn: { icon: "✨", label: "спавн", color: 0x67c23a },
  destination: { icon: "➜", label: "цель движения", color: 0x409eff },
  env: { icon: "☁", label: "эффект среды", color: 0xb07dd8 },
};

/** All scenario roles of every referenced object id. */
export function computeObjectRoles(doc: MapDocument): Map<string, ObjectRole[]> {
  const roles = new Map<string, ObjectRole[]>();
  const add = (id: unknown, role: ObjectRole): void => {
    if (typeof id !== "string" || !id) return;
    const list = roles.get(id) ?? [];
    list.push(role);
    roles.set(id, list);
  };

  for (const ev of doc.events ?? []) {
    // any ref-* field in a CONDITION = this object triggers the event
    for (const c of ev.conditions) {
      const spec = CONDITION_BY_KIND[c.kind];
      for (const f of spec?.fields ?? []) {
        if (!f.type.startsWith("ref-") || f.type === "ref-player" || f.type === "ref-event") continue;
        add((c as Record<string, unknown>)[f.key], { cls: "trigger", ev, what: spec!.label, kind: c.kind });
      }
    }
    // effects: per-FIELD class (spawn / target / destination), defaulting to env
    for (const e of ev.effects) {
      const spec = EFFECT_BY_KIND[e.kind];
      // «Приказ отряду»: показываем СМЫСЛ (категорию приказа из LOrder), не код
      const detail =
        e.kind === "changeStackOrder"
          ? ORDER_LABEL.get(Number((e as Record<string, unknown>).order)) ?? `код ${(e as Record<string, unknown>).order}`
          : undefined;
      for (const f of spec?.fields ?? []) {
        if (!f.type.startsWith("ref-") || f.type === "ref-player" || f.type === "ref-event") continue;
        const cls: RoleClass = EFFECT_FIELD_CLS[e.kind]?.[f.key] ?? "env";
        add((e as Record<string, unknown>)[f.key], { cls, ev, what: spec!.label, kind: e.kind, ...(detail ? { detail } : {}) });
      }
    }
  }
  return roles;
}

/** Compact per-class counts for one object (what the pixi overlay renders). */
export interface RoleCounts { trigger: number; target: number; spawn: number; destination: number; env: number }

export function countsOf(list: ObjectRole[] | undefined): RoleCounts | null {
  if (!list?.length) return null;
  const c: RoleCounts = { trigger: 0, target: 0, spawn: 0, destination: 0, env: 0 };
  for (const r of list) c[r.cls]++;
  return c;
}

/** «⚡3 ✨» — compact role-badge line (dominance order, count when >1). */
export function formatRoleBadges(c: RoleCounts | null | undefined): string {
  if (!c) return "";
  return (["trigger", "target", "spawn", "destination", "env"] as RoleClass[])
    .filter((k) => c[k] > 0)
    .map((k) => ROLE_META[k].icon + (c[k] > 1 ? c[k] : ""))
    .join(" ");
}

/** Plain-data role counts for every LOCATION (feeds Scene.updateScenarioRoles). */
export function locationRoleCounts(doc: MapDocument): Record<string, RoleCounts> {
  const roles = computeObjectRoles(doc);
  const out: Record<string, RoleCounts> = {};
  for (const o of doc.objects) {
    if (o.type !== "location") continue;
    const c = countsOf(roles.get(o.id));
    if (c) out[o.id] = c;
  }
  return out;
}

/** Role counts for every NON-location object (feeds the on-map object badges). Pass the
 *  already-computed roles map when you have one cached (avoids a second doc walk). */
export function objectRoleCounts(
  doc: MapDocument,
  roles?: Map<string, ObjectRole[]>,
): Record<string, RoleCounts> {
  const map = roles ?? computeObjectRoles(doc);
  const out: Record<string, RoleCounts> = {};
  for (const o of doc.objects) {
    if (o.type === "location") continue;
    const c = countsOf(map.get(o.id));
    if (c) out[o.id] = c;
  }
  return out;
}

/** «Локации»-tool sub-filter values: the 3 location-bound TRIGGER kinds get their own
 *  entries (вход / отряд в зоне / предмет), the rest filter by role class. */
export type LocFilter =
  | "all" | "free"
  | "enter" | "stackIn" | "itemTo"
  | "spawn" | "destination" | "env";

export const LOC_FILTERS: { value: LocFilter; icon: string; hint: string }[] = [
  { value: "all", icon: "Все", hint: "показать все локации" },
  { value: "free", icon: "∅", hint: "свободные — не используются ни одним событием" },
  { value: "enter", icon: "⚡", hint: "вход в зону (триггер)" },
  { value: "stackIn", icon: "👣", hint: "отряд в зоне (триггер)" },
  { value: "itemTo", icon: "🎒", hint: "предмет в зону (триггер)" },
  { value: "spawn", icon: "✨", hint: "спавны (создать отряд)" },
  { value: "destination", icon: "➜", hint: "цели движения и приказов" },
  { value: "env", icon: "☁", hint: "эффекты среды (заклинание / туман / рельеф)" },
];

/** Does a role list pass the sub-filter? (`free` handled by the caller: no roles at all) */
export function rolesMatchFilter(list: ObjectRole[] | undefined, f: LocFilter): boolean {
  if (f === "all") return true;
  if (f === "free") return !list?.length;
  if (!list?.length) return false;
  if (f === "enter") return list.some((r) => r.kind === "enterZone");
  if (f === "stackIn") return list.some((r) => r.kind === "stackInLocation");
  if (f === "itemTo") return list.some((r) => r.kind === "itemToLocation");
  return list.some((r) => r.cls === f);
}

/** Compact on-map SUMMARY lines per location — the «что здесь происходит» text shown in
 *  the «Локации» mode (max 2 lines + «+N»). Meaning over mechanics: trigger kinds are
 *  spelled out, «Приказ отряду» shows the ORDER CATEGORY (LOrder), not a code. */
export function locationSummaries(doc: MapDocument): Record<string, string[]> {
  const roles = computeObjectRoles(doc);
  const out: Record<string, string[]> = {};
  for (const o of doc.objects) {
    if (o.type !== "location") continue;
    const list = roles.get(o.id);
    if (!list?.length) continue;
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const r of list) {
      const evName = r.ev.name || r.ev.id;
      let line: string;
      if (r.kind === "enterZone") line = `⚡ вход → «${evName}»`;
      else if (r.kind === "stackInLocation") line = `⚡ отряд в зоне → «${evName}»`;
      else if (r.kind === "itemToLocation") line = `⚡ предмет → «${evName}»`;
      else if (r.cls === "trigger") line = `⚡ ${r.what} → «${evName}»`;
      else if (r.cls === "spawn") line = `✨ спавн — «${evName}»`;
      else if (r.kind === "changeStackOrder") line = `➜ приказ: ${r.detail ?? r.what}`;
      else if (r.cls === "destination") line = `➜ сюда придёт отряд («${evName}»)`;
      else line = `☁ ${r.what}`;
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
    out[o.id] = lines.length > 2 ? [...lines.slice(0, 2), `… ещё ${lines.length - 2}`] : lines;
  }
  return out;
}

/** Event-list badges: which role-classes an event carries (for row icons). */
export function eventBadges(ev: MapEvent): string[] {
  const out = new Set<string>();
  for (const c of ev.conditions) {
    if (c.kind === "frequency") out.add("📅");
    else if (c.kind === "destroyStack") out.add("💀");
    else if (CONDITION_BY_KIND[c.kind]?.fields.some((f) => f.type.startsWith("ref-"))) out.add("⚡");
  }
  for (const e of ev.effects) {
    if (SPAWN_EFFECTS.has(e.kind)) out.add("✨");
    else if (e.kind === "enableEvent") out.add("⚑");
    else if (e.kind === "popup") out.add("💬");
    else if (e.kind === "winLose") out.add("🏆");
  }
  return [...out];
}
