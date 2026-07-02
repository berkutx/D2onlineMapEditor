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
import { CONDITION_BY_KIND, EFFECT_BY_KIND } from "@d2/map-schema";

/** Role classes (drive overlay color/icon + inspector grouping). */
export type RoleClass = "trigger" | "spawn" | "destination" | "env";

export interface ObjectRole {
  cls: RoleClass;
  ev: MapEvent;
  /** Human label of the condition/effect that wires this object («Вход в зону»…). */
  what: string;
}

/** Effect kinds that mean «здесь что-то ПОЯВИТСЯ» vs «сюда кто-то ПРИДЁТ»; every other
 *  ref-loc/ref-city/... effect is an environment effect (заклинание/туман/рельеф/горы). */
const SPAWN_EFFECTS = new Set(["createStack"]);
const DEST_EFFECTS = new Set(["moveStackToLocation", "moveStackToTriggerer"]);

/** Per-class display metadata (shared by overlay legend + inspector). */
export const ROLE_META: Record<RoleClass, { icon: string; label: string; color: number }> = {
  trigger: { icon: "⚡", label: "триггер", color: 0xe6a23c },
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
        add((c as Record<string, unknown>)[f.key], { cls: "trigger", ev, what: spec!.label });
      }
    }
    // effects: spawn / destination / environment by kind class
    for (const e of ev.effects) {
      const spec = EFFECT_BY_KIND[e.kind];
      const cls: RoleClass = SPAWN_EFFECTS.has(e.kind)
        ? "spawn"
        : DEST_EFFECTS.has(e.kind)
          ? "destination"
          : "env";
      for (const f of spec?.fields ?? []) {
        if (!f.type.startsWith("ref-") || f.type === "ref-player" || f.type === "ref-event") continue;
        add((e as Record<string, unknown>)[f.key], { cls, ev, what: spec!.label });
      }
    }
  }
  return roles;
}

/** Compact per-class counts for one object (what the pixi overlay renders). */
export interface RoleCounts { trigger: number; spawn: number; destination: number; env: number }

export function countsOf(list: ObjectRole[] | undefined): RoleCounts | null {
  if (!list?.length) return null;
  const c: RoleCounts = { trigger: 0, spawn: 0, destination: 0, env: 0 };
  for (const r of list) c[r.cls]++;
  return c;
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
