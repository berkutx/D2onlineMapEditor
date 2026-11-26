/**
 * Applying a folded table delta to the parent's table, in place, through DbfTable's own
 * edits only — so every byte no edit touches stays the parent's: header, deleted rows, the
 * row order, the cells of untouched rows, a "?" in an L cell nobody set.
 *
 * Order: deletes, then sets, then adds. A delete marks the live row deleted ("*") — or, when
 * the row is gone, counts as done, except in a table keyed by the whole row, where a row that
 * is not found is one the parent changed: a conflict. A set
 * writes one cell; an add appends a row at the end with the cells it gives (the rest blank).
 * Every op is checked against the parent, and what does not fit is a conflict, not a guess:
 * a key naming two live rows, a missing row, a cell whose parent value is no longer the one
 * the edit replaced, a value the column cannot hold, an add over a live key. When the result
 * has conflicts the table is half-applied: discard it.
 */
import { DbfError, type DbfTable } from "@d2/dbf";
import type { CellValue, RowKey } from "./editFile.js";
import type { FoldedTable } from "./fold.js";
import { duplicateKeys, indexLiveRows, keyString, missingKeyColumns, rowKeyOf } from "./keys.js";

export type ConflictReason =
  | "key-not-unique"
  | "no-key-column"
  | "missing-row"
  | "key-exists"
  | "key-mismatch"
  | "no-field"
  | "cannot-hold"
  | "parent-changed"
  | "no-table"
  | "no-archive"
  | "no-record"
  | "no-index"
  | "unknown-frame"
  | "name-is-picture"
  | "record-in-use"
  | "reserved-record"
  | "name-taken"
  | "name-case"
  | "duplicate-name"
  | "picture-in-use"
  | "payload-missing"
  | "payload-mismatch";

export interface Conflict {
  /** Table or archive name. */
  file: string;
  reason: ConflictReason;
  key?: RowKey;
  field?: string;
  name?: string;
  detail: string;
}

export interface ApplyResult {
  conflicts: Conflict[];
  /** True when the table or archive was changed. */
  changed: boolean;
  counts: { deleted: number; set: number; added: number; unchanged: number };
}

export function emptyResult(): ApplyResult {
  return { conflicts: [], changed: false, counts: { deleted: 0, set: 0, added: 0, unchanged: 0 } };
}

const show = (v: CellValue | undefined) => JSON.stringify(v);

export function applyTableEdits(t: DbfTable, f: FoldedTable): ApplyResult {
  const res = emptyResult();
  const file = f.table;
  const conflict = (c: Omit<Conflict, "file">) => res.conflicts.push({ file, ...c });

  const missing = missingKeyColumns(t, f.key);
  if (missing.length) {
    conflict({ reason: "no-key-column", detail: `${file} has no column ${missing.join(", ")} of its key` });
    return res;
  }
  const twice = duplicateKeys(t, f.key);
  if (twice.length) {
    conflict({ reason: "key-not-unique", detail: `${twice.length} keys of ${file} name more than one live row, e.g. ${twice[0]}` });
    return res;
  }
  const index = indexLiveRows(t, f.key);
  const fieldOf = (name: string) => t.field(name)?.name;

  for (const key of f.deletes) {
    const k = keyString(key);
    const row = index.get(k);
    if (row === undefined) {
      // a row named by its columns that is gone is deleted already; a whole-row key that
      // finds nothing means the parent changed that row (or its columns), which the delete
      // did not see
      if (f.key.kind === "row") conflict({ reason: "missing-row", key, detail: `${file} has no live row ${k}: the parent changed it` });
      else res.counts.unchanged++;
      continue;
    }
    t.setDeleted(row, true);
    index.delete(k);
    res.counts.deleted++;
  }

  for (const s of f.sets) {
    const row = index.get(keyString(s.key));
    if (row === undefined) {
      conflict({ reason: "missing-row", key: s.key, field: s.field, detail: `${file} has no live row ${keyString(s.key)}` });
      continue;
    }
    const field = fieldOf(s.field);
    if (!field) {
      conflict({ reason: "no-field", key: s.key, field: s.field, detail: `${file} has no column ${s.field}` });
      continue;
    }
    let current: CellValue;
    try {
      current = t.get(row, field);
    } catch {
      current = undefined as unknown as CellValue; // a cell that does not decode differs from everything
    }
    if (current === s.value) {
      res.counts.unchanged++;
      continue;
    }
    if (s.was !== undefined && current !== s.was) {
      conflict({ reason: "parent-changed", key: s.key, field, detail: `${file}.${field} of ${keyString(s.key)} is ${show(current)} in the parent, the edit replaced ${show(s.was)}` });
      continue;
    }
    try {
      t.set(row, field, s.value);
      res.counts.set++;
    } catch (e) {
      if (!(e instanceof DbfError)) throw e;
      conflict({ reason: "cannot-hold", key: s.key, field, detail: e.message });
    }
  }

  for (const a of f.adds) {
    const k = keyString(a.key);
    const values: Record<string, CellValue> = {};
    let bad = false;
    for (const [name, v] of Object.entries(a.values)) {
      const field = fieldOf(name);
      if (!field) {
        conflict({ reason: "no-field", key: a.key, field: name, detail: `${file} has no column ${name}` });
        bad = true;
        continue;
      }
      values[field] = v;
    }
    if (bad) continue;
    const live = index.get(k);
    if (live !== undefined) {
      const same = Object.entries(values).every(([field, v]) => t.get(live, field) === v);
      if (same) res.counts.unchanged++;
      else conflict({ reason: "key-exists", key: a.key, detail: `${file} already has a live row ${k}` });
      continue;
    }
    try {
      const row = t.appendRow(values);
      const got = keyString(rowKeyOf(t, row, f.key));
      if (got !== k) {
        conflict({ reason: "key-mismatch", key: a.key, detail: `the new ${file} row reads as ${got}, its key says ${k}` });
        continue;
      }
      index.set(k, row);
      res.counts.added++;
    } catch (e) {
      if (!(e instanceof DbfError)) throw e;
      conflict({ reason: "cannot-hold", key: a.key, detail: e.message });
    }
  }

  res.changed = t.modified;
  return res;
}
