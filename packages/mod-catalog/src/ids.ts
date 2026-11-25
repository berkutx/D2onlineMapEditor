/**
 * The ids a mod's Globals tables define — the reference a map's id references are checked
 * against (see compat.ts).
 */
import { z } from "zod";
import { MOD_SCHEMA_VERSION } from "./manifest.js";

/** A global game-data id, UPPERCASE: `G` + 3-digit data-set prefix + 2-letter table code + 4 chars. */
export const GlobalId = z.string().regex(/^G\d{3}[A-Z]{2}[0-9A-Z]{4}$/, "expected an uppercase global id like G000UU0001");
export type GlobalId = z.infer<typeof GlobalId>;

/** The 2-letter table code inside a global id (`UU` units, `IG` items, …). */
export const TableCode = z.string().regex(/^[A-Z]{2}$/);

/**
 * Table codes the pipeline indexes, with the Globals table each comes from. A map may
 * reference other codes; only codes present in a mod's {@link IdSets} are checked.
 */
export const ID_TABLES = {
  UU: "GUnits",
  IG: "GItem",
  SS: "GSpells",
  MG: "GLmark",
  UM: "Gmodif",
  LR: "GLord",
  RR: "Grace",
  BB: "Gbuild",
} as const;
export type KnownTableCode = keyof typeof ID_TABLES;

/** Table code → the ids that table defines in this mod (UPPERCASE, sorted, no duplicates). */
export const IdSets = z.object({
  schemaVersion: z.literal(MOD_SCHEMA_VERSION),
  tables: z.record(TableCode, z.array(GlobalId)),
});
export type IdSets = z.infer<typeof IdSets>;

/** Global ids grouped by table code — what a map references (`collectGlobalIds` of sg-parser). */
export type GlobalIdRefs = Record<string, readonly string[]>;

/** The table code of a global id. */
export const tableOf = (id: string): string => id.slice(4, 6).toUpperCase();
