/**
 * What the «Охрана по бюджету» window remembers between its openings (a mapmaker places many
 * guards with the same wishes), and what it hands to the inspector on «Применить».
 */
import { GUARD_ROLES, type GuardMember, type GuardRole } from "@d2/map-edit";

/**
 * What the window composes for:
 *  - "stack"    — a party on the map: a leader and his units; loot goes into its inventory;
 *  - "garrison" — the defense of a city: soldiers only, nobody leads; loot goes into the city;
 *  - "ruin"     — the guards of a ruin: soldiers only; the reward is ONE item and gold;
 *  - "template" — a party template of the scenario: a leader and his units, levels only
 *                 (a template stores neither hit points nor things to carry).
 */
export type GuardKind = "stack" | "garrison" | "ruin" | "template";

/** What the window hands back: the formation to put in, and the loot (null = leave what is
 *  there as it is). `gold` is set for a ruin only — the cash part of its reward. */
export interface GuardApply {
  cells: (GuardMember | null)[];
  /** −1 for a garrison and for a ruin */
  leaderCell: number;
  loot: string[] | null;
  gold: number | null;
}

export interface GuardSettings {
  /** wanted strength: the experience a victory over the stack gives */
  budget: number;
  /** the mapmaker's coefficient: the ready-made strengths (GUARD_PRESETS) are offered multiplied
   *  by it, so that every guard of a harder — or an easier — map is asked in the same scale */
  scale: number;
  /** "one" = one subrace per stack · "mixed" = any units · a number = that subrace */
  subrace: "one" | "mixed" | number;
  roles: GuardRole[];
  maxUnits: number;
  levelOn: boolean;
  level: number;
  keepLeader: boolean;
  lootOn: boolean;
  /** wanted loot value, gold */
  lootBudget: number;
  /** item categories to take from; empty = every category but the special items */
  lootCats: string[];
  lootMax: number;
}

/** Strengths of the stacks in the maps the mods ship with: a quarter are below ~200, half below
 *  ~450, three quarters below ~900, nine in ten below ~1500. The presets stand on those marks. */
export const GUARD_PRESETS: readonly number[] = [150, 450, 900, 1600];

/** The coefficient's range, and a ready-made strength with it applied (to a round five). */
export const GUARD_SCALE_MIN = 0.1;
export const GUARD_SCALE_MAX = 20;
export function scaledPreset(preset: number, scale: number): number {
  return Math.max(5, Math.round((preset * scale) / 5) * 5);
}

export function defaultGuardSettings(): GuardSettings {
  return {
    budget: 450,
    scale: 1,
    subrace: "one",
    roles: [...GUARD_ROLES],
    maxUnits: 6,
    levelOn: false,
    level: 3,
    keepLeader: false,
    lootOn: false,
    lootBudget: 500,
    lootCats: [],
    lootMax: 4,
  };
}

const KEY = "d2.guard";
const int = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** A coefficient made safe: a number in its range, to two decimals. */
function scaleOf(v: unknown, fallback: number): number {
  const n = Number(v);
  if (typeof v === "boolean" || v === null || v === "" || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(Math.min(GUARD_SCALE_MAX, Math.max(GUARD_SCALE_MIN, n)) * 100) / 100;
}

/** Stored settings made safe: anything missing or out of range falls back to the default. */
export function normalizeGuardSettings(raw: unknown): GuardSettings {
  const d = defaultGuardSettings();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const roles = Array.isArray(r.roles) ? GUARD_ROLES.filter((role) => (r.roles as unknown[]).includes(role)) : d.roles;
  return {
    budget: int(r.budget, 1, 99999, d.budget),
    scale: scaleOf(r.scale, d.scale),
    subrace: r.subrace === "mixed" ? "mixed" : typeof r.subrace === "number" && Number.isInteger(r.subrace) ? r.subrace : "one",
    roles: roles.length ? roles : d.roles,
    maxUnits: int(r.maxUnits, 1, 6, d.maxUnits),
    levelOn: r.levelOn === true,
    level: int(r.level, 1, 999, d.level),
    keepLeader: r.keepLeader === true,
    lootOn: r.lootOn === true,
    lootBudget: int(r.lootBudget, 1, 999999, d.lootBudget),
    lootCats: Array.isArray(r.lootCats) ? (r.lootCats as unknown[]).filter((c): c is string => typeof c === "string") : [],
    lootMax: int(r.lootMax, 1, 12, d.lootMax),
  };
}

export function loadGuardSettings(): GuardSettings {
  try {
    const text = window.localStorage.getItem(KEY);
    return normalizeGuardSettings(text ? JSON.parse(text) : null);
  } catch {
    return defaultGuardSettings(); // storage blocked or the entry is broken
  }
}

export function saveGuardSettings(s: GuardSettings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: the settings last for this page */
  }
}
