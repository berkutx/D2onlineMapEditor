/**
 * How two versions of a table differ in their columns. The four mods do not share one
 * schema: a mod widens a field (Gmodif.SCRIPT C40 vs C64), adds one (GUnits.ATCK_COUNT in
 * Сёмга 2) or lacks one another mod has (GmodifL.IMMUNITYC). A mod editor shows the fields a
 * mod has, and a change made for one mod is carried to another only through the columns both
 * have.
 */
import type { DbfField } from "./table.js";

export interface FieldShape {
  name: string;
  type: string;
  length: number;
  decimals: number;
}

export interface SchemaDiff {
  /** Columns only `to` has. */
  added: FieldShape[];
  /** Columns only `from` has. */
  removed: FieldShape[];
  /** Columns both have, with another type, width or number of decimals. */
  changed: { name: string; from: FieldShape; to: FieldShape }[];
}

export function shapeOf(f: DbfField | FieldShape): FieldShape {
  return { name: f.name, type: f.type, length: f.length, decimals: f.decimals };
}

/** Column differences from `from` to `to`; names are compared ignoring case. */
export function diffSchemas(from: readonly (DbfField | FieldShape)[], to: readonly (DbfField | FieldShape)[]): SchemaDiff {
  const a = new Map(from.map((f) => [f.name.toLowerCase(), shapeOf(f)]));
  const b = new Map(to.map((f) => [f.name.toLowerCase(), shapeOf(f)]));
  const added = [...b.entries()].filter(([k]) => !a.has(k)).map(([, f]) => f);
  const removed = [...a.entries()].filter(([k]) => !b.has(k)).map(([, f]) => f);
  const changed: SchemaDiff["changed"] = [];
  for (const [k, fa] of a) {
    const fb = b.get(k);
    if (fb && (fa.type !== fb.type || fa.length !== fb.length || fa.decimals !== fb.decimals)) changed.push({ name: fb.name, from: fa, to: fb });
  }
  return { added, removed, changed };
}

export function sameSchema(from: readonly (DbfField | FieldShape)[], to: readonly (DbfField | FieldShape)[]): boolean {
  const d = diffSchemas(from, to);
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}
