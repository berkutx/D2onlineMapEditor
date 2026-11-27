/**
 * Row-level table diff: @d2/mod-edit's diffTable over every table both mods have, with the
 * rows behind each op kept ("was" rows of deletes, full rows of adds) for the entity view.
 *
 * Speed: before diffTable runs, the live rows that read the same in both mods (same key, same
 * values in every column diffTable compares) are left out of both tables. diffTable gives such
 * a pair no op and no skip, so the result is the same; only far fewer rows are compared.
 * A table whose file is the same in both mods is not compared at all (its rows are decoded
 * once), unless diffTable would refuse its key.
 *
 * Fallbacks when diffTable refuses a table: a whole-row table whose columns differ (Nazar's
 * GUmodif has MODIF_7) is compared over the columns both have; a table whose key names two
 * rows is compared by the whole row. A table still refused keeps the error and no ops.
 */
import { DbfTable, diffSchemas, type DbfFieldSpec, type DbfTable as DbfTableType } from "@d2/dbf";
import { declareKey, diffTable, DiffError, keyColumns, keyString, missingKeyColumns, registeredKey, type KeyDecl, type TableDiff } from "@d2/mod-edit";
import { coveredTable } from "./model.js";
import { decodeRow, type ModSide, type TableText } from "./side.js";
import type { Row, TableChange, TableOp } from "./types.js";

export interface TableWork {
  lower: string;
  change: TableChange;
  /** A's / B's live row by key text (over the compared columns). */
  rowA(keyText: string): Row | undefined;
  rowB(keyText: string): Row | undefined;
}

/** One side of a table: the table, its decoded rows (by row number) and its file text. */
interface Sheet {
  t: DbfTableType;
  rows: (Row | null)[];
  tt?: TableText;
  /** liveIndex results by key. */
  indexes?: Map<string, { index: Map<string, number>; twice: boolean }>;
}

/** A copy of a table with only the given columns (widths of both sides), live rows only. */
function project(t: DbfTableType, specs: DbfFieldSpec[]): DbfTableType {
  const out = DbfTable.create(t.name, specs);
  for (let r = 0; r < t.rowCount; r++) {
    if (t.isDeleted(r)) continue;
    const row = decodeRow(t, r);
    const values: Record<string, Row[string]> = {};
    for (const s of specs) values[s.name] = row[s.name.toUpperCase()] ?? null;
    out.appendRow(values);
  }
  return out;
}

const sheetOf = (t: DbfTableType): Sheet => ({ t, rows: Array.from({ length: t.rowCount }, (_, r) => (t.isDeleted(r) ? null : decodeRow(t, r))) });

/** The columns both tables have with one type, at the wider width. */
function commonSpecs(a: DbfTableType, b: DbfTableType): DbfFieldSpec[] {
  const out: DbfFieldSpec[] = [];
  for (const fa of a.fields) {
    const fb = b.field(fa.name);
    if (!fb || fb.type !== fa.type || !["C", "N", "L"].includes(fa.type)) continue;
    const type = fa.type as DbfFieldSpec["type"];
    out.push({ name: fa.name.toUpperCase(), type, length: type === "L" ? 1 : Math.max(fa.length, fb.length), decimals: Math.max(fa.decimals, fb.decimals) });
  }
  return out;
}

const upperKeyColumns = (t: DbfTableType, key: KeyDecl) => keyColumns(t, key).map((c) => c.toUpperCase());

/** Live row number by key text (as keyString of rowKeyOf), and whether a key names two rows. */
function liveIndex(s: Sheet, key: KeyDecl): { index: Map<string, number>; twice: boolean } {
  const cols = upperKeyColumns(s.t, key);
  const k = JSON.stringify(cols);
  s.indexes ??= new Map();
  let hit = s.indexes.get(k);
  if (hit) return hit;
  const index = new Map<string, number>();
  let twice = false;
  s.rows.forEach((row, r) => {
    if (!row) return;
    const kt = keyString(cols.map((c) => row[c] ?? null));
    if (index.has(kt)) twice = true;
    index.set(kt, r);
  });
  s.indexes.set(k, (hit = { index, twice }));
  return hit;
}

/** Both tables without the live pairs that read the same (see the header); undefined when nothing is left out. */
function withoutSame(a: Sheet, b: Sheet, key: KeyDecl): [DbfTableType, DbfTableType] | undefined {
  if (!a.tt || !b.tt) return undefined;
  if (missingKeyColumns(a.t, key).length || missingKeyColumns(b.t, key).length) return undefined;
  if (key.kind === "row" && a.t.fields.map((f) => f.name.toLowerCase()).join() !== b.t.fields.map((f) => f.name.toLowerCase()).join()) return undefined;
  const ka = upperKeyColumns(a.t, key);
  const kb = upperKeyColumns(b.t, key);
  // a refusal for keys that name two rows must come from the full tables
  if (liveIndex(a, key).twice || liveIndex(b, key).twice) return undefined;
  const common = a.t.fields.filter((fa) => b.t.field(fa.name)?.type === fa.type).map((f) => f.name.toUpperCase());
  // equal common cells mean equal keys when every key column is a common one
  const keysCommon = ka.every((c) => common.includes(c)) && kb.every((c) => common.includes(c));
  const sig = (row: Row, kc: string[]) => {
    const cells = JSON.stringify(common.map((c) => row[c] ?? null));
    return keysCommon ? cells : `${keyString(kc.map((c) => row[c] ?? null))}\u0000${cells}`;
  };
  const sa = a.rows.map((row) => (row ? sig(row, ka) : null));
  const sb = b.rows.map((row) => (row ? sig(row, kb) : null));
  const count = (list: (string | null)[]) => {
    const m = new Map<string, number>();
    for (const s of list) if (s !== null) m.set(s, (m.get(s) ?? 0) + 1);
    return m;
  };
  const ca = count(sa);
  const cb = count(sb);
  const same = (s: string) => ca.get(s) === 1 && cb.get(s) === 1;
  const keep = (list: (string | null)[]) => list.map((s, r) => (s !== null && !same(s) ? r : -1)).filter((r) => r >= 0);
  const keepA = keep(sa);
  const keepB = keep(sb);
  const live = (list: (string | null)[]) => list.filter((s) => s !== null).length;
  if (keepA.length === live(sa) && keepB.length === live(sb)) return undefined;
  const rebuild = (s: Sheet, rows: number[]) => {
    const tt = s.tt!;
    const out = new Uint8Array(tt.headerLength + rows.length * tt.recordLength + 1);
    out.set(tt.bytes.subarray(0, tt.headerLength), 0);
    new DataView(out.buffer).setUint32(4, rows.length, true);
    rows.forEach((r, i) => {
      const at = tt.headerLength + r * tt.recordLength;
      out.set(tt.bytes.subarray(at, at + tt.recordLength), tt.headerLength + i * tt.recordLength);
    });
    out[out.length - 1] = 0x1a;
    return DbfTable.read(out, s.t.name);
  };
  return [rebuild(a, keepA), rebuild(b, keepB)];
}

/** diffTable over the rows that can differ. */
function quickDiff(name: string, a: Sheet, b: Sheet, key: KeyDecl): TableDiff {
  const reduced = withoutSame(a, b, key);
  return reduced ? diffTable(name, reduced[0], reduced[1], key) : diffTable(name, a.t, b.t, key);
}

interface Attempt {
  key: KeyDecl;
  d?: TableDiff;
  /** The tables the ops' keys name rows of (the originals, or the projections). */
  a: Sheet;
  b: Sheet;
  projected?: string[];
  error?: string;
  note?: string;
}

/** The same file but for the version byte and the date (bytes 0-3 of the header). */
function sameFile(x: Uint8Array, y: Uint8Array): boolean {
  if (x.length !== y.length) return false;
  for (let i = 4; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function attempt(name: string, a: Sheet, b: Sheet, identical: boolean): Attempt {
  const key = registeredKey(name) ?? declareKey(name, a.t);
  // diffTable gives a table and its copy no op; only its refusals are left to find out
  if (identical && !missingKeyColumns(a.t, key).length && !liveIndex(a, key).twice) return { key, d: { ops: [], schema: diffSchemas(a.t.fields, b.t.fields), skipped: [] }, a, b };
  try {
    return { key, d: quickDiff(name, a, b, key), a, b };
  } catch (e) {
    if (!(e instanceof DiffError)) throw e;
    const first = e.message;
    const row: KeyDecl = { kind: "row" };
    const specs = commonSpecs(a.t, b.t);
    const sameColumns = specs.length === a.t.fields.length && specs.length === b.t.fields.length;
    try {
      if (key.kind === "row" && !sameColumns) {
        const pa = sheetOf(project(a.t, specs));
        const pb = sheetOf(project(b.t, specs));
        return { key, d: diffTable(name, pa.t, pb.t, key), a: pa, b: pb, projected: specs.map((s) => s.name), note: "compared over the columns both mods have" };
      }
      if (key.kind !== "row") {
        if (sameColumns) return { key: row, d: quickDiff(name, a, b, row), a, b, note: `compared by the whole row: ${first}` };
        const pa = sheetOf(project(a.t, specs));
        const pb = sheetOf(project(b.t, specs));
        return { key: row, d: diffTable(name, pa.t, pb.t, row), a: pa, b: pb, projected: specs.map((s) => s.name), note: `compared by the whole row over the columns both mods have: ${first}` };
      }
    } catch (e2) {
      if (!(e2 instanceof DiffError)) throw e2;
      return { key, a, b, error: `${first}; ${e2.message}` };
    }
    return { key, a, b, error: first };
  }
}

function rowLookup(s: Sheet, key: KeyDecl): (keyText: string) => Row | undefined {
  let index: Map<string, number> | undefined;
  return (keyText) => {
    index ??= liveIndex(s, key).index;
    const r = index.get(keyText);
    return r === undefined ? undefined : (s.rows[r] ?? undefined);
  };
}

const upperRow = (values: Record<string, Row[string]>): Row => {
  const out: Row = {};
  for (const [k, v] of Object.entries(values)) out[k.toUpperCase()] = v;
  return out;
};

export function diffTables(sa: ModSide, sb: ModSide): TableWork[] {
  const names = new Set([...sa.tableNames(), ...sb.tableNames()]);
  const out: TableWork[] = [];
  for (const lower of names) {
    const ta = sa.table(lower);
    const tb = sb.table(lower);
    const name = sa.displayName(lower) ?? sb.displayName(lower) ?? lower;
    const coverage: TableChange["coverage"] = coveredTable(lower) ? "entities" : "table";
    const base: TableChange = {
      name,
      presence: ta && tb ? "both" : ta ? "onlyA" : "onlyB",
      coverage,
      rowsA: sa.liveCount(lower),
      rowsB: sb.liveCount(lower),
      key: null,
      keyColumns: [],
      counts: { set: 0, add: 0, delete: 0 },
      schema: diffSchemas(ta?.fields ?? [], tb?.fields ?? []),
      ops: [],
      skipped: [],
      unassigned: 0,
    };
    if (lower === "gunits_2") base.note = "a copy of Gunits that only some mods have; whether the game reads it is not known";
    if (!ta || !tb) {
      out.push({ lower, change: base, rowA: () => undefined, rowB: () => undefined });
      continue;
    }
    const tta = sa.text866(lower)!;
    const ttb = sb.text866(lower)!;
    const identical = sameFile(tta.bytes, ttb.bytes);
    if (identical) sb.shareRows(lower, sa.rows(lower));
    const at = attempt(name, { t: ta, rows: sa.rows(lower), tt: tta }, { t: tb, rows: sb.rows(lower), tt: ttb }, identical);
    base.key = at.key;
    base.keyColumns = upperKeyColumns(at.a.t, at.key);
    if (at.projected) base.projected = at.projected;
    if (at.note) base.note = at.note;
    if (at.error) base.error = at.error;
    const rowA = rowLookup(at.a, at.key);
    const rowB = rowLookup(at.b, at.key);
    if (at.d) {
      const ops: TableOp[] = [];
      for (const op of at.d.ops) {
        const keyText = keyString(op.key);
        if (op.op === "dbf.set") {
          const field = op.field.toUpperCase();
          const was = op.was ?? null;
          const t: TableOp = { op: "dbf.set", key: op.key, keyText, field, was, value: op.value, owners: [] };
          const wt = sa.display(lower, field, was);
          const vt = sb.display(lower, field, op.value);
          if (wt !== undefined) t.wasText = wt;
          if (vt !== undefined) t.valueText = vt;
          ops.push(t);
          base.counts.set++;
        } else if (op.op === "dbf.add") {
          ops.push({ op: "dbf.add", key: op.key, keyText, values: rowB(keyText) ?? upperRow(op.values), owners: [] });
          base.counts.add++;
        } else {
          ops.push({ op: "dbf.delete", key: op.key, keyText, was: rowA(keyText) ?? {}, owners: [] });
          base.counts.delete++;
        }
      }
      base.ops = ops;
      base.skipped = at.d.skipped.map((s) => {
        const keyText = keyString(s.key);
        const field = s.field.toUpperCase();
        const ra = rowA(keyText);
        const rb = rowB(keyText);
        return {
          key: s.key,
          keyText,
          field,
          reason: s.reason,
          ...(ra && field in ra ? { a: ra[field] } : {}),
          ...(rb && field in rb ? { b: rb[field] } : {}),
        };
      });
    }
    out.push({ lower, change: base, rowA, rowB });
  }
  out.sort((x, y) => x.change.name.localeCompare(y.change.name, "en", { sensitivity: "base" }));
  return out;
}
