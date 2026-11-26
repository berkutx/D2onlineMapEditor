/**
 * The edits that turn one table into another: a parent's and a child's version of the same
 * table (two mods, or a parent and a hand-edited copy of its Globals). Rows are paired by key
 * among live rows; columns by name (ignoring case) and type.
 *
 *   a row in both     dbf.set for every common column whose decoded value differs, `was`
 *                     the parent's (an L cell reads as the game reads it, so "?" vs "F" is
 *                     no change); a key cell that differs only in letter case is reported in
 *                     `skipped`, not changed. In a whole-row-keyed table two rows pair when
 *                     they differ at most in case and trailing spaces; when they do differ,
 *                     dbf.delete + dbf.add of the child's row
 *   only the parent   dbf.delete
 *   only the child    dbf.add with its common columns, in the child's row order
 *
 * Columns only the child has are reported in `schema` and not carried: a derived mod has its
 * parent's schema. A child value the parent's column cannot hold is reported in `skipped`.
 * Applying the result to the parent gives the child's live rows by key, over the common
 * columns; the row order matches too when the child kept the parent's rows in their order and
 * put new ones last.
 */
import { diffSchemas, encodeCell, DbfError, type DbfTable, type SchemaDiff } from "@d2/dbf";
import type { CellValue, DbfOp, KeyDecl, RowKey } from "./editFile.js";
import { duplicateKeys, indexLiveRows, keyColumns, keyString, missingKeyColumns, rowKeyOf } from "./keys.js";

export interface TableDiff {
  ops: DbfOp[];
  schema: SchemaDiff;
  skipped: { key: RowKey; field: string; reason: string }[];
}

export class DiffError extends Error {
  override name = "DiffError";
}

export function diffTable(table: string, parent: DbfTable, child: DbfTable, key: KeyDecl): TableDiff {
  for (const [side, t] of [["parent", parent], ["child", child]] as const) {
    const missing = missingKeyColumns(t, key);
    if (missing.length) throw new DiffError(`${table}: the ${side} has no key column ${missing.join(", ")}`);
    const twice = duplicateKeys(t, key);
    if (twice.length) throw new DiffError(`${table}: ${twice.length} keys name more than one live row of the ${side}, e.g. ${twice[0]}`);
  }
  if (key.kind === "row") {
    const p = parent.fields.map((f) => f.name.toLowerCase()).join();
    const c = child.fields.map((f) => f.name.toLowerCase()).join();
    if (p !== c) throw new DiffError(`${table} is keyed by the whole row and its columns differ between the two sides`);
  }
  const schema = diffSchemas(parent.fields, child.fields);
  // common columns of one type, by the parent's names
  const common = parent.fields
    .map((pf) => ({ pf, cf: child.field(pf.name) }))
    .filter((x): x is { pf: (typeof parent.fields)[number]; cf: NonNullable<ReturnType<DbfTable["field"]>> } => !!x.cf && x.cf.type === x.pf.type);
  const keyCols = new Set(keyColumns(parent, key).map((c) => c.toLowerCase()));

  const ops: DbfOp[] = [];
  const skipped: TableDiff["skipped"] = [];
  const pIndex = indexLiveRows(parent, key);
  const cIndex = indexLiveRows(child, key);
  const fits = (pf: (typeof common)[number]["pf"], v: CellValue): string | null => {
    try {
      encodeCell(pf, v);
      return null;
    } catch (e) {
      if (e instanceof DbfError) return e.message;
      throw e;
    }
  };

  for (const [k, prow] of pIndex) {
    const crow = cIndex.get(k);
    const rowKey = rowKeyOf(parent, prow, key);
    if (crow === undefined) {
      ops.push({ op: "dbf.delete", table, key: rowKey });
      continue;
    }
    if (key.kind === "row") {
      // the key sees no letter case or trailing spaces; the row may still differ in them
      if (common.some(({ pf, cf }) => parent.get(prow, pf.name) !== child.get(crow, cf.name))) {
        const values = childValues(crow, rowKey);
        if (values) ops.push({ op: "dbf.delete", table, key: rowKey }, { op: "dbf.add", table, key: rowKey, values });
      }
      continue;
    }
    for (const { pf, cf } of common) {
      if (keyCols.has(pf.name.toLowerCase())) {
        if (parent.get(prow, pf.name) !== child.get(crow, cf.name)) {
          skipped.push({ key: rowKey, field: pf.name, reason: `the child writes this key cell as ${JSON.stringify(child.get(crow, cf.name))}; a key cell keeps the parent's letter case` });
        }
        continue;
      }
      const was = parent.get(prow, pf.name);
      const value = child.get(crow, cf.name);
      if (was === value) continue;
      const why = fits(pf, value);
      if (why) skipped.push({ key: rowKey, field: pf.name, reason: why });
      else ops.push({ op: "dbf.set", table, key: rowKey, field: pf.name, value, was });
    }
  }
  for (let r = 0; r < child.rowCount; r++) {
    if (child.isDeleted(r)) continue;
    const rowKey = rowKeyOf(child, r, key);
    const k = keyString(rowKey);
    if (pIndex.has(k) || cIndex.get(k) !== r) continue;
    const values = childValues(r, rowKey);
    if (values) ops.push({ op: "dbf.add", table, key: rowKey, values });
  }
  return { ops, schema, skipped };

  /** A child row's cells over the common columns; undefined when a key cell does not fit. */
  function childValues(r: number, rowKey: RowKey): Record<string, CellValue> | undefined {
    const values: Record<string, CellValue> = {};
    let ok = true;
    for (const { pf, cf } of common) {
      const v = child.get(r, cf.name);
      const why = fits(pf, v);
      if (why) {
        skipped.push({ key: rowKey, field: pf.name, reason: why });
        if (keyCols.has(pf.name.toLowerCase()) || key.kind === "row") ok = false;
        continue;
      }
      values[pf.name] = v;
    }
    return ok ? values : undefined;
  }
}
