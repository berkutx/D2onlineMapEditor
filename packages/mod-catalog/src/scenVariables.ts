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
   * and wins over the plain one (`EMPIRE_MULTIPLE_BUILD_CAPITAL`).
   */
  scope: z.enum(["global", "perRace"]).default("global"),
  /** `flag`: only present/absent or zero/non-zero matters; `number`: the value is used. */
  kind: z.enum(["flag", "number"]).default("number"),
  /** Who reads it: the mss32 toolset itself, or the mod's Lua scripts. */
  source: z.enum(["mss32", "lua"]),
  /** Where the read was found (a Lua path relative to Scripts/, or an mss32 source file). */
  origin: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  presets: z.array(ScenVariablePreset).optional(),
});
export type ScenVariableDef = z.infer<typeof ScenVariableDef>;

export const ScenVariableCatalog = z.object({
  schemaVersion: z.literal(MOD_SCHEMA_VERSION),
  /** Race key → name prefix used by `perRace` variables ({ empire: "EMPIRE_", … }). */
  racePrefixes: z.record(z.string(), z.string()).default({}),
  variables: z.array(ScenVariableDef).default([]),
});
export type ScenVariableCatalog = z.infer<typeof ScenVariableCatalog>;

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
