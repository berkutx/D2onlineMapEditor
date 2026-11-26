/**
 * Row identity: which cells name a row of a table, so an edit finds its row in the parent
 * (and in a rebuilt parent) without a row number.
 *
 * TABLE_KEYS_V1 was measured on the live rows of all four mods (semga, semga-2, smns3,
 * nazar-legacy): each key is unique in every mod that has the table, the natural one where
 * there is one (an *_ID column, or the pair of a link table). Four tables are lists with no
 * such key and are named by the whole row; GVars has one row. Deleted rows are never keyed:
 * the game skips them, and many of them repeat a live row's key (GLabi has 359 deleted rows
 * for 63 live ones).
 *
 * Key cells are compared the way the game compares ids: C text with the padding dropped and
 * a-z upper-cased (Tglobal stores "x000tg2001", a map says "X000TG2001"); N as a number or
 * null; L as a boolean.
 */
import type { DbfTable, DbfValue } from "@d2/dbf";
import type { KeyDecl, RowKey } from "./editFile.js";

const columns = (...c: string[]): KeyDecl => ({ kind: "columns", columns: c });

/** Version 1 of the key registry, by table name in lower case. Frozen with the format. */
export const TABLE_KEYS_V1: Readonly<Record<string, KeyDecl>> = {
  gunits: columns("UNIT_ID"),
  gattacks: columns("ATT_ID"),
  gbuild: columns("BUILD_ID"),
  gdynupgr: columns("UPGRADE_ID"),
  gitem: columns("ITEM_ID"), // its first column is ITEM_CAT
  glmark: columns("LMARK_ID"),
  glord: columns("LORD_ID"),
  gmodif: columns("MODIF_ID"),
  grace: columns("RACE_ID"),
  gspells: columns("SPELL_ID"),
  gsubrace: columns("RACE_ID"),
  gaction: columns("ACTION_ID"),
  gai: columns("CATEGORY"),
  "gai_exp+": columns("CATEGORY"),
  gai_extreme: columns("CATEGORY"),
  gai_normal: columns("CATEGORY"),
  gai_vanilla: columns("CATEGORY"),
  gai_vanila: columns("CATEGORY"),
  tglobal: columns("TXT_ID"),
  tplayer: columns("RACE_ID"),
  tapp: columns("TXT_ID"),
  tappedit: columns("TXT_ID"),
  gbuilist: columns("LORD_ID", "BUILD_ID"),
  gcityinf: columns("RACE_ID", "SIZE"),
  gimmu: columns("UNIT_ID", "IMMUNITY"),
  gimmuc: columns("UNIT_ID", "IMMUNITY"),
  glabi: columns("UNIT_ID", "L_ABILITY"),
  gleaupg: columns("BELONGS_TO", "MODIF_ID"),
  gmabi: columns("UNIT_ID", "M_ABILITY"),
  gspellr: columns("LORD_ID", "SPELL_ID"),
  gtiledbi: columns("TERRAIN", "GROUND", "NDX"),
  gtransf: columns("ATTACK_ID", "TRANSF_ID"),
  // lists: a modifier's effects, a unit's modifiers (MSS appends every row's MODIF_n to the
  // unit's list in file order), AI messages, leader names
  gmodifl: { kind: "row" },
  gumodif: { kind: "row" },
  taimsg: { kind: "row" },
  tleader: { kind: "row" },
  gvars: { kind: "only" },
};

/** The key of a table: the registry's, else ID for an L* lookup table, else none. */
export function registeredKey(table: string): KeyDecl | undefined {
  return TABLE_KEYS_V1[table.toLowerCase()];
}

/**
 * The key to declare for a table not edited before: the registry's; for another table the
 * ID column of an L* lookup table, else its first column when that is unique over the live
 * rows, else the whole row.
 */
export function declareKey(table: string, parent: DbfTable): KeyDecl {
  const known = registeredKey(table);
  if (known) return known;
  if (/^l/i.test(table) && parent.hasField("ID")) return columns("ID");
  const first = parent.fields[0];
  if (first) {
    const decl = columns(first.name);
    if (duplicateKeys(parent, decl).length === 0) return decl;
  }
  return { kind: "row" };
}

/** The columns a key reads, in key order. */
export function keyColumns(t: DbfTable, decl: KeyDecl): string[] {
  if (decl.kind === "columns") return decl.columns;
  if (decl.kind === "row") return t.fields.map((f) => f.name);
  return [];
}

/** A key cell as the game compares it. */
export function normalizeCell(v: DbfValue): DbfValue {
  return typeof v === "string" ? v.replace(/ +$/, "").replace(/[a-z]+/g, (s) => s.toUpperCase()) : v;
}

/** The text a key is compared by. */
export function keyString(key: RowKey): string {
  return JSON.stringify(key.map(normalizeCell));
}

/** The key cells of a row (normalized). */
export function rowKeyOf(t: DbfTable, row: number, decl: KeyDecl): RowKey {
  return keyColumns(t, decl).map((c) => normalizeCell(t.get(row, c)));
}

/** True when the row's key is `key`. */
export function sameKey(a: RowKey, b: RowKey): boolean {
  return keyString(a) === keyString(b);
}

/** Live row by key. Keys that name two live rows are left out; see duplicateKeys. */
export function indexLiveRows(t: DbfTable, decl: KeyDecl): Map<string, number> {
  const out = new Map<string, number>();
  const twice = new Set<string>();
  for (let r = 0; r < t.rowCount; r++) {
    if (t.isDeleted(r)) continue;
    const k = keyString(rowKeyOf(t, r, decl));
    if (out.has(k)) twice.add(k);
    out.set(k, r);
  }
  for (const k of twice) out.delete(k);
  return out;
}

/** Keys that name more than one live row. */
export function duplicateKeys(t: DbfTable, decl: KeyDecl): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (let r = 0; r < t.rowCount; r++) {
    if (t.isDeleted(r)) continue;
    const k = keyString(rowKeyOf(t, r, decl));
    if (seen.has(k)) twice.add(k);
    seen.add(k);
  }
  return [...twice];
}

/** Every key column must be a field of the table. */
export function missingKeyColumns(t: DbfTable, decl: KeyDecl): string[] {
  return decl.kind === "columns" ? decl.columns.filter((c) => !t.hasField(c)) : [];
}
