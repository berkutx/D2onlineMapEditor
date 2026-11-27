/**
 * What an id names, read from its two-letter type code ("G000UU0019" is a unit). The code
 * is consistent over every table of the four mods, so ids found in Lua, scenarios or
 * capital.dat are classified without a table lookup.
 */
import { ID_PATTERN } from "@d2/mod-edit";
import type { SectionId } from "./types.js";

export interface IdKind {
  code: string;
  section: SectionId;
  /** The table that defines ids of this kind. */
  table: string;
  column: string;
}

export const ID_KINDS: Readonly<Record<string, IdKind>> = {
  UU: { code: "UU", section: "units", table: "Gunits", column: "UNIT_ID" },
  AA: { code: "AA", section: "attacks", table: "Gattacks", column: "ATT_ID" },
  IG: { code: "IG", section: "items", table: "GItem", column: "ITEM_ID" },
  SS: { code: "SS", section: "spells", table: "Gspells", column: "SPELL_ID" },
  BB: { code: "BB", section: "buildings", table: "Gbuild", column: "BUILD_ID" },
  MG: { code: "MG", section: "landmarks", table: "GLmark", column: "LMARK_ID" },
  UM: { code: "UM", section: "modifiers", table: "Gmodif", column: "MODIF_ID" },
  LR: { code: "LR", section: "lords", table: "Glord", column: "LORD_ID" },
  RR: { code: "RR", section: "races", table: "Grace", column: "RACE_ID" },
  BR: { code: "BR", section: "races", table: "GSubRace", column: "RACE_ID" },
  DU: { code: "DU", section: "dynamicUpgrades", table: "GDynUpgr", column: "UPGRADE_ID" },
  NA: { code: "NA", section: "rules", table: "Gaction", column: "ACTION_ID" },
  TG: { code: "TG", section: "texts", table: "Tglobal", column: "TXT_ID" },
  TA: { code: "TA", section: "texts", table: "TApp", column: "TXT_ID" },
};

/** The kind of an id by its type code; undefined for anything not id-shaped or of another code. */
export function classifyId(id: string | null | undefined): IdKind | undefined {
  if (typeof id !== "string") return undefined;
  const v = id.trim();
  if (!ID_PATTERN.test(v)) return undefined;
  return ID_KINDS[v.slice(4, 6).toUpperCase()];
}

/** An id as the game compares it: trimmed, upper case. */
export function normId(v: unknown): string {
  return typeof v === "string" ? v.trim().toUpperCase() : v === null || v === undefined ? "" : String(v);
}

/** True for a cell that names nothing: blank, "", "G000000000". */
export function isNoId(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return false;
  const s = v.trim();
  return s === "" || /^g0+$/i.test(s) || s.toLowerCase() === "none";
}

/** A Tglobal text without its leading style tag ("\fNormal;"), trimmed, as the catalogs show it. */
export function stripStyle(text: string): string {
  return text.replace(/^\\f\w+;/, "").trim();
}
