/**
 * Folding a journal into the canonical delta of each table: what to delete, which cells to
 * set, which rows to add — the same delta whatever path of edits led to it. Needs no parent:
 * whether a key exists there is checked when the delta is applied (applyTable.ts).
 *
 * Per key, in journal order:
 *   set     on a row added earlier: merges into the add's values; on a row deleted earlier:
 *           an error; otherwise the last value wins and the first `was` is kept, and a set to
 *           that `was` (back again, or a first set that changes nothing) drops the set.
 *   add     after an add of the key: an error; after a delete of it: the delete stays and a
 *           new row is added (the game's own tables have deleted rows repeating live keys).
 *   delete  after an add: the two cancel; otherwise the key's sets are dropped.
 * A set may not change a key column, and a whole-row-keyed table has no sets: its rows are
 * changed by delete + add.
 *
 * Archive ops are not folded: they replay in journal order (applyArchive.ts).
 */
import type { CellValue, DbfOp, FfOp, KeyDecl, ModEditOp, RowKey } from "./editFile.js";
import { tableKey } from "./editFile.js";
import { keyString, normalizeCell } from "./keys.js";

export class FoldError extends Error {
  override name = "FoldError";
}

export interface FoldedSet {
  key: RowKey;
  field: string;
  value: CellValue;
  was?: CellValue;
}

export interface FoldedAdd {
  key: RowKey;
  values: Record<string, CellValue>;
}

export interface FoldedTable {
  /** The table name as the journal first gave it. */
  table: string;
  key: KeyDecl;
  deletes: RowKey[];
  sets: FoldedSet[];
  adds: FoldedAdd[];
}

export interface FoldedEdits {
  /** By table name in lower case. */
  tables: Record<string, FoldedTable>;
  /** By archive file name in lower case, ops in journal order. */
  archives: Record<string, FfOp[]>;
}

type KeyState =
  | { kind: "parent"; key: RowKey; sets: Map<string, { field: string; value: CellValue; was?: CellValue }> }
  | { kind: "deleted"; key: RowKey }
  | { kind: "added"; key: RowKey; values: Record<string, CellValue>; afterDelete: boolean };

const sameValue = (a: CellValue | undefined, b: CellValue | undefined) => a === b;

function fieldIn(values: Record<string, CellValue>, field: string): string | undefined {
  return Object.keys(values).find((f) => f.toLowerCase() === field.toLowerCase());
}

export function foldEdits(ops: readonly ModEditOp[], decls: { tables: Record<string, KeyDecl> }): FoldedEdits {
  const states = new Map<string, { table: string; key: KeyDecl; byKey: Map<string, KeyState> }>();
  const archives: Record<string, FfOp[]> = {};

  ops.forEach((op, at) => {
    const where = `op ${at} (${op.op})`;
    if ("archive" in op) {
      (archives[op.archive.toLowerCase()] ??= []).push(op);
      return;
    }
    const dop = op as DbfOp;
    const lower = dop.table.toLowerCase();
    let table = states.get(lower);
    if (!table) {
      const key = tableKey(decls, dop.table);
      if (!key) throw new FoldError(`${where}: no key declared for table ${dop.table}`);
      table = { table: dop.table, key, byKey: new Map() };
      states.set(lower, table);
    }
    const decl = table.key;
    const width = decl.kind === "columns" ? decl.columns.length : decl.kind === "only" ? 0 : -1;
    if (width >= 0 && dop.key.length !== width) throw new FoldError(`${where}: ${dop.table} keys have ${width} cells, not ${dop.key.length}`);
    if (decl.kind === "row" && dop.key.length === 0) throw new FoldError(`${where}: ${dop.table} is keyed by the whole row`);
    const k = keyString(dop.key);
    const state = table.byKey.get(k);

    switch (dop.op) {
      case "dbf.set": {
        if (decl.kind === "row") throw new FoldError(`${where}: ${dop.table} is keyed by the whole row; change a row by delete + add`);
        if (decl.kind === "columns" && decl.columns.some((c) => c.toLowerCase() === dop.field.toLowerCase())) {
          throw new FoldError(`${where}: ${dop.field} is part of ${dop.table}'s key; delete the row and add it under the new key`);
        }
        if (state?.kind === "deleted") throw new FoldError(`${where}: the row ${k} of ${dop.table} was deleted`);
        if (state?.kind === "added") {
          state.values[fieldIn(state.values, dop.field) ?? dop.field] = dop.value;
          return;
        }
        const s = state ?? { kind: "parent" as const, key: dop.key, sets: new Map() };
        const fk = dop.field.toLowerCase();
        const prev = s.sets.get(fk);
        const was = prev ? prev.was : dop.was;
        // a cell set to the value it had (first time or back again) is no edit at all
        if (was !== undefined && sameValue(was, dop.value)) s.sets.delete(fk);
        else s.sets.set(fk, { field: prev?.field ?? dop.field, value: dop.value, ...(was === undefined ? {} : { was }) });
        if (s.sets.size === 0) table.byKey.delete(k);
        else if (!state) table.byKey.set(k, s);
        return;
      }
      case "dbf.add": {
        if (state?.kind === "added") throw new FoldError(`${where}: the row ${k} of ${dop.table} was added already`);
        if (state?.kind === "parent") throw new FoldError(`${where}: the row ${k} of ${dop.table} was edited as a row of the parent; delete it first`);
        if (decl.kind === "columns") {
          decl.columns.forEach((c, i) => {
            const f = fieldIn(dop.values, c);
            if (!f || keyString([dop.values[f]!]) !== keyString([dop.key[i]!])) {
              throw new FoldError(`${where}: the values of the new ${dop.table} row do not hold its key cell ${c}`);
            }
          });
        }
        // to the end: new rows are appended in the order they were added
        table.byKey.delete(k);
        table.byKey.set(k, { kind: "added", key: dop.key, values: { ...dop.values }, afterDelete: state?.kind === "deleted" });
        return;
      }
      case "dbf.delete": {
        if (state?.kind === "deleted") throw new FoldError(`${where}: the row ${k} of ${dop.table} was deleted already`);
        if (state?.kind === "added") {
          if (state.afterDelete) table.byKey.set(k, { kind: "deleted", key: state.key });
          else table.byKey.delete(k);
          return;
        }
        table.byKey.set(k, { kind: "deleted", key: dop.key });
        return;
      }
    }
  });

  const tables: Record<string, FoldedTable> = {};
  for (const [lower, t] of states) {
    const out: FoldedTable = { table: t.table, key: t.key, deletes: [], sets: [], adds: [] };
    for (const s of t.byKey.values()) {
      if (s.kind === "deleted") out.deletes.push(s.key);
      else if (s.kind === "added") {
        if (s.afterDelete) out.deletes.push(s.key);
        out.adds.push({ key: s.key, values: s.values });
      } else {
        for (const c of s.sets.values()) out.sets.push({ key: s.key, field: c.field, value: c.value, ...(c.was === undefined ? {} : { was: c.was }) });
      }
    }
    if (out.deletes.length || out.sets.length || out.adds.length) tables[lower] = out;
  }
  return { tables, archives };
}

/** Normalized key cells, for callers that compare keys themselves. */
export function normalizedKey(key: RowKey): RowKey {
  return key.map(normalizeCell);
}
