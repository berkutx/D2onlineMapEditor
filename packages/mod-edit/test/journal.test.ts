/** The edit file and the folding of its journal into one delta per table. */
import { describe, it, expect } from "vitest";
import {
  activeOps,
  canRedo,
  canUndo,
  foldEdits,
  FoldError,
  newModEdits,
  parseModEdits,
  pushCommit,
  redo,
  undo,
  type KeyDecl,
  type ModEditOp,
} from "../src/index";

const UNIT: KeyDecl = { kind: "columns", columns: ["UNIT_ID"] };
const LIST: KeyDecl = { kind: "row" };
const decls = { tables: { Gunits: UNIT, GmodifL: LIST, Gimmu: { kind: "columns", columns: ["UNIT_ID", "IMMUNITY"] } as KeyDecl } };

const set = (key: string, field: string, value: string | number | null, was?: string | number | null): ModEditOp => ({
  op: "dbf.set",
  table: "Gunits",
  key: [key],
  field,
  value,
  ...(was === undefined ? {} : { was }),
});
const add = (key: string, values: Record<string, string | number | null> = {}): ModEditOp => ({ op: "dbf.add", table: "Gunits", key: [key], values: { UNIT_ID: key, ...values } });
const del = (key: string): ModEditOp => ({ op: "dbf.delete", table: "Gunits", key: [key] });
const fold = (...ops: ModEditOp[]) => foldEdits(ops, decls).tables.gunits;

describe("the edit file", () => {
  const fresh = () => newModEdits({ modId: "semga-test", name: "Test", parent: { modId: "semga" }, namespace: "230" });

  it("parses what it writes and refuses other files", () => {
    const e = pushCommit(fresh(), [set("G000UU0001", "LEVEL", 2, 1)], { keys: decls.tables, note: "level" });
    expect(parseModEdits(JSON.parse(JSON.stringify(e)))).toEqual(e);
    expect(() => parseModEdits({ ...e, kind: "other" })).toThrow(/not a d2-mod-edits v1 file/);
    expect(() => parseModEdits({ ...e, version: 2 })).toThrow(/not a d2-mod-edits v1 file/);
    expect(() => parseModEdits({ ...e, cursor: 5 })).toThrow(/cursor/);
    expect(() => parseModEdits({ ...e, ids: { namespace: "221" } })).toThrow(/230-254/);
    expect(() => parseModEdits({ ...e, journal: [{ ops: [{ op: "dbf.rename", table: "Gunits" }] }] })).toThrow();
  });

  it("needs a key for a table it has not seen, and keeps the one it has", () => {
    expect(() => pushCommit(fresh(), [set("G000UU0001", "LEVEL", 2)])).toThrow(/no key for table Gunits/);
    const e = pushCommit(fresh(), [set("G000UU0001", "LEVEL", 2)], { keys: { gunits: UNIT } });
    expect(Object.keys(e.tables)).toEqual(["Gunits"]);
    const again = pushCommit(e, [set("G000UU0001", "LEVEL", 3)], { keys: { GUNITS: LIST } });
    expect(again.tables).toEqual({ Gunits: UNIT });
  });

  it("undoes and redoes by moving the cursor, and a new commit drops the redo tail", () => {
    let e = fresh();
    e = pushCommit(e, [set("G000UU0001", "LEVEL", 2)], { keys: decls.tables });
    e = pushCommit(e, [set("G000UU0001", "LEVEL", 3)]);
    expect(activeOps(e)).toHaveLength(2);
    e = undo(e);
    expect(activeOps(e)).toHaveLength(1);
    expect(canRedo(e)).toBe(true);
    expect(redo(e).cursor).toBe(2);
    e = pushCommit(e, [set("G000UU0001", "LEVEL", 4)]);
    expect(e.journal).toHaveLength(2);
    expect(canRedo(e)).toBe(false);
    expect((activeOps(e)[1] as { value: number }).value).toBe(4);
    expect(canUndo(undo(undo(e)))).toBe(false);
    expect(undo(undo(undo(e))).cursor).toBe(0);
  });
});

describe("folding", () => {
  it("keeps the last value and the first was, and drops a cell set back", () => {
    expect(fold(set("G000UU0001", "LEVEL", 2, 1), set("g000uu0001", "level", 5, 2)).sets).toEqual([{ key: ["G000UU0001"], field: "LEVEL", value: 5, was: 1 }]);
    expect(foldEdits([set("G000UU0001", "LEVEL", 2, 1), set("G000UU0001", "LEVEL", 1, 2)], decls).tables).toEqual({});
  });

  it("refuses a set of a key column, of a whole-row table, and of a deleted row", () => {
    expect(() => fold(set("G000UU0001", "UNIT_ID", "G000UU0009"))).toThrow(/part of Gunits's key/);
    expect(() => foldEdits([{ op: "dbf.set", table: "GmodifL", key: ["a", 1], field: "TYPE", value: 2 }], decls)).toThrow(/whole row/);
    expect(() => fold(del("G000UU0001"), set("G000UU0001", "LEVEL", 2))).toThrow(/was deleted/);
  });

  it("merges sets into an added row; an add and its delete cancel", () => {
    expect(fold(add("G230UU0001", { LEVEL: 1 }), set("G230UU0001", "level", 4)).adds).toEqual([{ key: ["G230UU0001"], values: { UNIT_ID: "G230UU0001", LEVEL: 4 } }]);
    expect(foldEdits([add("G230UU0001"), del("G230UU0001")], decls).tables).toEqual({});
  });

  it("replaces a parent row by delete + add, and deleting the new row again leaves the delete", () => {
    const t = fold(del("G000UU0001"), add("G000UU0001", { LEVEL: 9 }));
    expect(t.deletes).toEqual([["G000UU0001"]]);
    expect(t.adds).toEqual([{ key: ["G000UU0001"], values: { UNIT_ID: "G000UU0001", LEVEL: 9 } }]);
    const back = fold(del("G000UU0001"), add("G000UU0001"), del("G000UU0001"));
    expect(back).toEqual({ table: "Gunits", key: UNIT, deletes: [["G000UU0001"]], sets: [], adds: [] });
  });

  it("refuses what cannot follow", () => {
    expect(() => fold(add("G230UU0001"), add("G230UU0001"))).toThrow(/added already/);
    expect(() => fold(set("G000UU0001", "LEVEL", 2), add("G000UU0001"))).toThrow(/delete it first/);
    expect(() => fold(del("G000UU0001"), del("G000UU0001"))).toThrow(/deleted already/);
    expect(() => fold({ op: "dbf.add", table: "Gunits", key: ["G230UU0001"], values: { UNIT_ID: "G230UU0002" } })).toThrow(/key cell UNIT_ID/);
    expect(() => fold({ op: "dbf.delete", table: "Gunits", key: ["a", "b"] })).toThrow(/1 cells, not 2/);
    expect(() => foldEdits([{ op: "dbf.delete", table: "Gbuild", key: ["a"] }], decls)).toThrow(FoldError);
  });

  it("gives the same delta whichever way the edits went", () => {
    const a = fold(set("G000UU0001", "LEVEL", 3, 1), set("G000UU0003", "NAME_TXT", "x"), del("G000UU0002"));
    const b = fold(del("G000UU0002"), set("G000UU0003", "NAME_TXT", "y"), set("G000UU0001", "LEVEL", 2, 1), set("G000UU0003", "NAME_TXT", "x"), set("G000UU0001", "LEVEL", 3));
    const sorted = (t: typeof a) => ({ ...t, sets: [...t.sets].sort((x, y) => String(x.key).localeCompare(String(y.key))) });
    expect(sorted(b)).toEqual(sorted(a));
  });

  it("drops a set that changes nothing", () => {
    expect(foldEdits([set("G000UU0001", "LEVEL", 1, 1)], decls).tables).toEqual({});
    expect(fold(set("G000UU0001", "LEVEL", 1, 1), set("G000UU0001", "NAME_TXT", "b", "a")).sets).toEqual([{ key: ["G000UU0001"], field: "NAME_TXT", value: "b", was: "a" }]);
  });

  it("appends new rows in the order they were added", () => {
    const t = fold(del("G000UU0001"), add("G230UU0001"), add("G000UU0001"));
    expect(t.adds.map((a) => a.key[0])).toEqual(["G230UU0001", "G000UU0001"]);
  });

  it("keeps archive ops in journal order", () => {
    const ops: ModEditOp[] = [
      { op: "ff.deleteRecord", archive: "IsoUnit.ff", name: "A" },
      { op: "ff.putRecord", archive: "isounit.ff", name: "A", payload: { copyOf: "B" } },
    ];
    expect(foldEdits(ops, decls).archives).toEqual({ "isounit.ff": ops });
  });
});
