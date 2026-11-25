/**
 * Scenario variables a mod gives a meaning to.
 *
 * A map restricts or tunes the game through plain scenario variables (MidScenVariables):
 * the mss32 toolset reads some by name (`MULTIPLE_BUILD_CAPITAL`, `HIRE_UNIT_TIER_MAX`, …)
 * and each mod's Lua reads its own. Which names mean anything therefore depends on the mod,
 * so the catalog of known variables is part of the mod's data set. It drives the editor's
 * map-restrictions panel and the "this mod does not know variable X" warning.
 */
import { z } from "zod";
import { MOD_SCHEMA_VERSION } from "./manifest.js";

/** A ready-made choice for a variable: the value to store, or `null` = variable absent. */
export const ScenVariablePreset = z.object({
  value: z.number().int().nullable(),
  label: z.string().min(1),
});
export type ScenVariablePreset = z.infer<typeof ScenVariablePreset>;

export const ScenVariableDef = z.object({
  /** The variable name, or its leading part when `prefix` is true (`PERK_LVL_`). */
  name: z.string().min(1),
  /** The script builds the full name at run time; any variable starting with `name` matches. */
  prefix: z.boolean().default(false),
  /**
   * `perRace`: besides the plain name, `<racePrefix><name>` is read for the player's race
   * (`EMPIRE_MULTIPLE_BUILD_CAPITAL`); {@link raceMode} says how the two combine.
   */
  scope: z.enum(["global", "perRace"]).default("global"),
  /**
   * How a race-prefixed variable combines with the plain one:
   * `override` — when the race's variable exists it is used INSTEAD of the plain one, whatever
   * its value (so a race's 0 is an explicit "default rules for this race", not "no setting");
   * `add` — both are added up (a race's 0 changes nothing).
   */
  raceMode: z.enum(["override", "add"]).default("override"),
  /** `flag`: only present/absent or zero/non-zero matters; `number`: the value is used. */
  kind: z.enum(["flag", "number"]).default("number"),
  /**
   * The value the game assumes when the map has no such variable — writing it changes nothing.
   * `null`: absence means something no number says (e.g. "take the limit from the mod's tables").
   */
  absentValue: z.number().int().nullable().default(0),
  /** Who reads it: the mss32 toolset itself, or the mod's Lua scripts. */
  source: z.enum(["mss32", "lua"]),
  /** Where the read was found (a Lua path relative to Scripts/, or an mss32 source file). */
  origin: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  presets: z.array(ScenVariablePreset).optional(),
  /** Id of the {@link ScenVariableGroup} the variable is shown in (a table of numbers). */
  group: z.string().optional(),
  /**
   * Variables the game keeps its own state in for this rule and expects to exist while the
   * rule is on. The editor creates them (value 0) with the rule and removes them with it.
   */
  companions: z.array(z.string().min(1)).optional(),
});
export type ScenVariableDef = z.infer<typeof ScenVariableDef>;

/** Variables that are one rule seen along an axis (city income per city level, …). */
export const ScenVariableGroup = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
});
export type ScenVariableGroup = z.infer<typeof ScenVariableGroup>;

export const ScenVariableCatalog = z.object({
  schemaVersion: z.literal(MOD_SCHEMA_VERSION),
  /** Race key → name prefix used by `perRace` variables ({ empire: "EMPIRE_", … }). */
  racePrefixes: z.record(z.string(), z.string()).default({}),
  groups: z.array(ScenVariableGroup).default([]),
  variables: z.array(ScenVariableDef).default([]),
});
export type ScenVariableCatalog = z.infer<typeof ScenVariableCatalog>;

/** A scenario variable as a map stores it (MidScenVariables entry). */
export interface ScenVariableValue {
  id: number;
  name: string;
  value: number;
}

/** One concrete variable name a definition is read under, and the race it applies to. */
export interface ScenVariableForm {
  /** The full variable name (`MULTIPLE_BUILD_CAPITAL`, `EMPIRE_MULTIPLE_BUILD_CAPITAL`). */
  name: string;
  /** Race key the form applies to; null = every race. */
  race: string | null;
}

/**
 * The names a definition is read under: the plain name (all races) and, for a `perRace`
 * definition, one race-prefixed name per race of the catalog. A `prefix` definition has no
 * fixed names and yields none.
 */
export function variableForms(catalog: ScenVariableCatalog, def: ScenVariableDef): ScenVariableForm[] {
  if (def.prefix) return [];
  const forms: ScenVariableForm[] = [{ name: def.name, race: null }];
  if (def.scope === "perRace") {
    for (const [race, prefix] of Object.entries(catalog.racePrefixes)) forms.push({ name: prefix + def.name, race });
  }
  return forms;
}

/** The value a map gives a variable name, or null when the map has no such variable. */
export function readVariable(variables: readonly ScenVariableValue[], name: string): number | null {
  const v = variables.find((x) => x.name === name);
  return v ? v.value : null;
}

/**
 * A variable list with `name` set to `value` — or, with null, without any variable of that
 * name. An existing variable keeps its id (events refer to variables by id); a new one gets
 * the next free id. The input is not modified; the same array is returned when nothing changes.
 */
export function writeVariable<T extends ScenVariableValue>(
  variables: readonly T[],
  name: string,
  value: number | null,
): readonly (T | ScenVariableValue)[] {
  const i = variables.findIndex((x) => x.name === name);
  if (value === null) return i < 0 ? variables : variables.filter((x) => x.name !== name);
  if (i >= 0) {
    if (variables[i]!.value === value) return variables;
    return variables.map((x, k) => (k === i ? { ...x, value } : x));
  }
  const id = Math.max(0, ...variables.map((x) => x.id)) + 1;
  return [...variables, { id, name, value }];
}

/** Outcome of {@link setRule}. */
export interface RuleChange<T extends ScenVariableValue> {
  /** The new variable list (the input array itself when nothing changed). */
  variables: readonly (T | ScenVariableValue)[];
  /**
   * True when "no variable" was asked for but could not be given: an event refers to the
   * variable, and no value means the same as its absence. The list is then unchanged.
   */
  blocked: boolean;
}

/**
 * Set one form of a rule (`name` is the plain name or a race-prefixed one), or with `null`
 * return it to "no variable".
 *
 * Events refer to variables by id (`keep` = the ids in use), so a variable an event reads or
 * writes is never deleted from under it. It is given the value that means the same as its
 * absence instead — the definition's `absentValue` for the plain form and for a race form
 * that is added to the plain one. A race form that OVERRIDES the plain one has no such value
 * (any number, 0 included, replaces the common rule), and neither has a definition whose
 * `absentValue` is null: those are reported as `blocked`.
 *
 * The rule's `companions` follow it: created (value 0) while any form of the rule is set to
 * something other than its absent value, removed again — unless an event uses them — when
 * none is.
 */
export function setRule<T extends ScenVariableValue>(
  catalog: ScenVariableCatalog,
  variables: readonly T[],
  def: ScenVariableDef,
  name: string,
  value: number | null,
  keep: ReadonlySet<number> = new Set(),
): RuleChange<T> {
  let out: readonly (T | ScenVariableValue)[] = variables;
  if (value === null) {
    const existing = variables.find((x) => x.name === name);
    if (existing && keep.has(existing.id)) {
      const raceOverride = name !== def.name && def.raceMode === "override";
      if (def.absentValue === null || raceOverride) return { variables, blocked: true };
      out = writeVariable(out, name, def.absentValue);
    } else {
      out = writeVariable(out, name, null);
    }
  } else {
    out = writeVariable(out, name, value);
  }

  if (def.companions?.length) {
    const active = variableForms(catalog, def).some((f) => {
      const v = readVariable(out, f.name);
      return v !== null && v !== def.absentValue;
    });
    for (const companion of def.companions) {
      const existing = out.find((x) => x.name === companion);
      if (active && !existing) out = writeVariable(out, companion, 0);
      else if (!active && existing && !keep.has(existing.id)) out = writeVariable(out, companion, null);
    }
  }
  return { variables: out, blocked: false };
}

/**
 * The definition a variable name falls under, or undefined when the mod gives the name no
 * meaning. Exact names win over prefixes; a `perRace` definition also matches its
 * race-prefixed forms. Names are compared case-sensitively, as the game does.
 */
export function findScenVariable(catalog: ScenVariableCatalog, name: string): ScenVariableDef | undefined {
  const racePrefixes = Object.values(catalog.racePrefixes);
  const forms = (def: ScenVariableDef): string[] =>
    def.scope === "perRace" ? [def.name, ...racePrefixes.map((p) => p + def.name)] : [def.name];
  let byPrefix: ScenVariableDef | undefined;
  for (const def of catalog.variables) {
    for (const form of forms(def)) {
      if (!def.prefix && form === name) return def;
      if (def.prefix && name.startsWith(form) && name.length > form.length) byPrefix ??= def;
    }
  }
  return byPrefix;
}
