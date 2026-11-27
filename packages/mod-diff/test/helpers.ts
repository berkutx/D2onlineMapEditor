/** Small mods built here, so the rules hold without a game install. */
import { DbfTable, type DbfFieldSpec, type DbfValue } from "@d2/dbf";
import type { ModData } from "../src/index";

export type Rows = Record<string, DbfValue>[];
export type ModRows = Record<string, Rows>;

const c = (name: string, length = 10): DbfFieldSpec => ({ name, type: "C", length });
const n = (name: string, length = 4): DbfFieldSpec => ({ name, type: "N", length });

export const SPECS: Record<string, DbfFieldSpec[]> = {
  Tglobal: [c("TXT_ID"), c("TEXT", 60)],
  Lrace: [n("ID", 2), c("TEXT")],
  Lterrain: [n("ID", 2), c("TEXT")],
  LAttR: [n("ID", 2), c("TEXT", 20)],
  Grace: [c("RACE_ID"), c("NAME_TXT"), n("RACE_TYPE", 2), c("GUARDIAN"), c("LEADER_1"), c("SOLDIER_1")],
  Gunits: [c("UNIT_ID"), c("RACE_ID"), c("NAME_TXT"), n("LEVEL", 2), n("HIT_POINT"), c("ATTACK_ID"), c("ATTACK2_ID")],
  Gattacks: [c("ATT_ID"), c("NAME_TXT"), n("POWER", 3)],
  Gimmu: [c("UNIT_ID"), n("IMMUNITY", 2), n("IMMUNECAT", 2)],
  GUmodif: [c("UNIT_ID"), c("MODIF_1")],
  Gbuild: [c("BUILD_ID"), c("NAME_TXT")],
  Gmodif: [c("MODIF_ID"), n("SOURCE", 2), c("DESC_TXT"), c("SCRIPT", 40)],
  GmodifL: [c("BELONGS_TO"), n("TYPE", 2), n("PERCENT", 3), c("DESC")],
};

/** A table as read from a file. */
export function table(name: string, specs: readonly DbfFieldSpec[], rows: Rows): DbfTable {
  const t = DbfTable.create(name, specs);
  for (const values of rows) t.appendRow(values);
  return DbfTable.read(t.toBytes(), name);
}

export const U1 = "G000UU0001";
export const U2 = "G000UU0002";
export const U3 = "G000UU0003";
export const A1 = "G000AA0001";
export const A2 = "G000AA0002";
export const RACE = "G000RR0000";
export const TEMPLE = "G000BB0001";
export const M1 = "G000UM0001";
export const M2 = "G000UM0002";

/**
 * One race (Empire) with two units, both using attack A1; Gimmu rows of both units; U2 has
 * modifier M1 (GUmodif); M1 has two effects, M2 one. Text ids are stored in lower case, as
 * the game's Tglobal does.
 */
export function baseRows(): ModRows {
  return {
    Tglobal: [
      { TXT_ID: "x000tg0001", TEXT: "Squire" },
      { TXT_ID: "x000tg0002", TEXT: "Archer" },
      { TXT_ID: "x000tg0003", TEXT: "Strike" },
      { TXT_ID: "x000tg0004", TEXT: "Shot" },
      { TXT_ID: "x000tg0005", TEXT: "Empire" },
      { TXT_ID: "x000tg0006", TEXT: "Temple" },
      { TXT_ID: "x000tg0007", TEXT: "Mod one" },
      { TXT_ID: "x000tg0008", TEXT: "Mod two" },
    ],
    Lrace: [{ ID: 0, TEXT: "L_HUMAN" }],
    Lterrain: [{ ID: 1, TEXT: "L_HU" }],
    LAttR: [
      { ID: 1, TEXT: "Melee" },
      { ID: 2, TEXT: "Any" },
    ],
    Grace: [{ RACE_ID: RACE, NAME_TXT: "X000TG0005", RACE_TYPE: 0, GUARDIAN: U1, LEADER_1: U2, SOLDIER_1: U1 }],
    Gunits: [
      { UNIT_ID: U1, RACE_ID: RACE, NAME_TXT: "X000TG0001", LEVEL: 1, HIT_POINT: 100, ATTACK_ID: A1, ATTACK2_ID: "G000000000" },
      { UNIT_ID: U2, RACE_ID: RACE, NAME_TXT: "X000TG0002", LEVEL: 1, HIT_POINT: 80, ATTACK_ID: A1, ATTACK2_ID: "G000000000" },
    ],
    Gattacks: [
      { ATT_ID: A1, NAME_TXT: "X000TG0003", POWER: 25 },
      { ATT_ID: A2, NAME_TXT: "X000TG0004", POWER: 30 },
    ],
    Gimmu: [
      { UNIT_ID: U1, IMMUNITY: 1, IMMUNECAT: 2 },
      { UNIT_ID: U1, IMMUNITY: 3, IMMUNECAT: 1 },
      { UNIT_ID: U2, IMMUNITY: 1, IMMUNECAT: 1 },
    ],
    GUmodif: [{ UNIT_ID: U2, MODIF_1: M1 }],
    Gbuild: [{ BUILD_ID: TEMPLE, NAME_TXT: "X000TG0006" }],
    Gmodif: [
      { MODIF_ID: M1, SOURCE: 0, DESC_TXT: "X000TG0007", SCRIPT: "" },
      { MODIF_ID: M2, SOURCE: 0, DESC_TXT: "X000TG0008", SCRIPT: "drawing\\x.lua" },
    ],
    GmodifL: [
      { BELONGS_TO: M1, TYPE: 1, PERCENT: 10, DESC: "X000TG0007" },
      { BELONGS_TO: M1, TYPE: 2, PERCENT: 5, DESC: "" },
      { BELONGS_TO: M2, TYPE: 1, PERCENT: 20, DESC: "X000TG0008" },
    ],
  };
}

export function mod(id: string, rows: ModRows, extra: Partial<ModData> = {}): ModData {
  const tables = new Map<string, DbfTable>();
  for (const [name, list] of Object.entries(rows)) tables.set(name, table(name, SPECS[name]!, list));
  return { id, name: id, tables, ...extra };
}

/** The row of a list whose column has the value. */
export function rowOf(rows: Rows, column: string, value: DbfValue): Record<string, DbfValue> {
  const r = rows.find((x) => x[column] === value);
  if (!r) throw new Error(`no row with ${column} = ${String(value)}`);
  return r;
}

/** A sha256-shaped hash made of one digit. */
export const hash = (digit: string) => digit.repeat(64);
export const blob = (digit: string, ext = "png") => `blobs/${digit}${digit}/${hash(digit)}.${ext}`;
