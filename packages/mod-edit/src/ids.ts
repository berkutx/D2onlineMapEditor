/**
 * Ids for new rows. A game id is "G000UU0019": a letter (G for the Globals tables, X for
 * Tglobal's texts), a 3-digit namespace index, a 2-letter type, a 4-digit counter. The four
 * mods use namespace indexes up to 221, so a derived mod takes one of its own from 230-254
 * (pickNamespace) and counts in decimal from 0001: "G230UU0001". Decimal, because the
 * editor's sprite builder only matches decimal unit counters and no shipped id has a hex
 * letter there; a namespace of its own, so two derived mods of one parent never give one id
 * to two different rows.
 *
 * Untested in the game and ScenEdit: run one unit with a G230 id in both before a derived mod
 * with new rows is published.
 */
import type { DbfTable } from "@d2/dbf";
import type { ModEdits } from "./editFile.js";

export interface IdType {
  /** The letter ids of this type start with. */
  letter: "G" | "X";
  /** The table that defines them, and its id column. */
  table: string;
  column: string;
}

/** The types an edit may mint ids for. */
export const ID_TYPES: Readonly<Record<string, IdType>> = {
  UU: { letter: "G", table: "Gunits", column: "UNIT_ID" },
  AA: { letter: "G", table: "Gattacks", column: "ATT_ID" },
  IG: { letter: "G", table: "GItem", column: "ITEM_ID" },
  SS: { letter: "G", table: "Gspells", column: "SPELL_ID" },
  MG: { letter: "G", table: "GLmark", column: "LMARK_ID" },
  UM: { letter: "G", table: "Gmodif", column: "MODIF_ID" },
  LR: { letter: "G", table: "Glord", column: "LORD_ID" },
  BB: { letter: "G", table: "Gbuild", column: "BUILD_ID" },
  DU: { letter: "G", table: "GDynUpgr", column: "UPGRADE_ID" },
  TG: { letter: "X", table: "Tglobal", column: "TXT_ID" },
};

export const NAMESPACE_FIRST = 230;
export const NAMESPACE_LAST = 254;

/** An id's shape (any case). */
export const ID_PATTERN = /^[A-Za-z][0-9A-Fa-f]{3}[A-Za-z]{2}[0-9A-Fa-f]{4}$/;
const ID_INSIDE = /[A-Za-z][0-9A-Fa-f]{3}[A-Za-z]{2}[0-9A-Fa-f]{4}/g;

/** Every id-shaped text in any cell of the tables, live or deleted rows, upper-cased. */
export function idsIn(tables: Iterable<DbfTable>): Set<string> {
  const out = new Set<string>();
  for (const t of tables) {
    const text = t.fields.filter((f) => f.type === "C");
    for (let r = 0; r < t.rowCount; r++) {
      for (const f of text) {
        const v = t.get(r, f.name);
        if (typeof v === "string" && v.length >= 10) for (const m of v.matchAll(ID_INSIDE)) out.add(m[0].toUpperCase());
      }
    }
  }
  return out;
}

/** Every id-shaped text in a text (a Lua script, a name list), upper-cased. */
export function idsInText(text: string, into: Set<string> = new Set()): Set<string> {
  for (const m of text.matchAll(ID_INSIDE)) into.add(m[0].toUpperCase());
  return into;
}

/** Every id-shaped string an edit file mentions (keys, values, names), upper-cased. */
export function idsInEdits(e: ModEdits): Set<string> {
  return idsInText(JSON.stringify(e.journal));
}

/** The namespace indexes the ids use. */
export function namespacesOf(ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) out.add(id.slice(1, 4));
  return out;
}

/** The lowest namespace of 230-254 no id uses. Throws when all are taken. */
export function pickNamespace(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = NAMESPACE_FIRST; n <= NAMESPACE_LAST; n++) if (!used.has(String(n))) return String(n);
  throw new Error(`every namespace ${NAMESPACE_FIRST}-${NAMESPACE_LAST} is taken`);
}

/**
 * The letter case a table writes its ids in ("g000uu0001" in Gunits, "G000IG0001" in
 * GItem), as a mask over the id's letters: the most common one among the live rows.
 */
export function idCaseOf(t: DbfTable, column: string): string | undefined {
  const counts = new Map<string, number>();
  for (let r = 0; r < t.rowCount; r++) {
    if (t.isDeleted(r)) continue;
    const v = t.get(r, column);
    if (typeof v !== "string" || !ID_PATTERN.test(v)) continue;
    const mask = [...v].map((c) => (/[a-z]/.test(c) ? "l" : /[A-Z]/.test(c) ? "U" : ".")).join("");
    counts.set(mask, (counts.get(mask) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [mask, n] of counts) if (best === undefined || n > counts.get(best)!) best = mask;
  return best;
}

function withCase(id: string, mask: string | undefined): string {
  if (!mask) return id;
  return [...id].map((c, i) => (mask[i] === "l" ? c.toLowerCase() : mask[i] === "U" ? c.toUpperCase() : c)).join("");
}

/**
 * The next free id of a type in a namespace: the lowest decimal counter from 0001 whose id
 * (ignoring case) is not taken, written in `mask`'s case.
 */
export function allocateId(type: string, namespace: string, taken: ReadonlySet<string>, mask?: string): string {
  const t = ID_TYPES[type.toUpperCase()];
  if (!t) throw new Error(`no id type ${type} (known: ${Object.keys(ID_TYPES).join(", ")})`);
  if (!/^\d{3}$/.test(namespace)) throw new Error(`namespace ${namespace} is not 3 digits`);
  const used = new Set([...taken].map((id) => id.toUpperCase()));
  for (let n = 1; n <= 9999; n++) {
    const id = `${t.letter}${namespace}${type.toUpperCase()}${String(n).padStart(4, "0")}`;
    if (!used.has(id)) return withCase(id, mask);
  }
  throw new Error(`namespace ${namespace} has no free ${type} id left`);
}
