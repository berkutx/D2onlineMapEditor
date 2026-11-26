/** Applying a table delta to a parent table, and the delta between two tables. */
import { describe, it, expect } from "vitest";
import { DbfTable } from "@d2/dbf";
import { applyTableEdits, declareKey, diffTable, DiffError, foldEdits, type FoldedTable, type KeyDecl, type ModEditOp } from "../src/index";
import { liveRows, table, units, UNIT_FIELDS, UNITS } from "./helpers";

const UNIT: KeyDecl = { kind: "columns", columns: ["UNIT_ID"] };
const delta = (ops: ModEditOp[], key: KeyDecl = UNIT, name = "Gunits"): FoldedTable => {
  const t = foldEdits(ops, { tables: { [name]: key } }).tables[name.toLowerCase()];
  if (!t) throw new Error("no delta");
  return t;
};

/** The bytes of a table's records other than `rows`. */
function otherRecords(t: DbfTable, rows: number[]): Uint8Array[] {
  const b = t.toBytes();
  const view = new DataView(b.buffer, b.byteOffset);
  const header = view.getUint16(8, true);
  const size = view.getUint16(10, true);
  const out: Uint8Array[] = [];
  for (let r = 0; r < t.rowCount; r++) if (!rows.includes(r)) out.push(b.slice(header + r * size, header + (r + 1) * size));
  return out;
}

describe("applying a delta", () => {
  it("sets one cell and leaves every other byte, deleted rows included", () => {
    const t = units();
    const before = otherRecords(t, [0]);
    const res = applyTableEdits(t, delta([{ op: "dbf.set", table: "Gunits", key: ["G000UU0001"], field: "level", value: 7, was: 1 }]));
    expect(res.conflicts).toEqual([]);
    expect(res.counts).toEqual({ deleted: 0, set: 1, added: 0, unchanged: 0 });
    expect(t.get(0, "LEVEL")).toBe(7);
    expect(otherRecords(t, [0])).toEqual(before);
    expect(t.get(1, "NAME_TXT")).toBe("Gone"); // the deleted row of the same key is not touched
    expect(t.get(3, "LEVEL")).toBe(3);
  });

  it("finds the live row of a key a deleted row repeats", () => {
    const t = units();
    applyTableEdits(t, delta([{ op: "dbf.set", table: "Gunits", key: ["G000UU0002"], field: "LEVEL", value: 4 }]));
    expect(t.get(3, "LEVEL")).toBe(4);
    expect(t.get(1, "LEVEL")).toBe(2);
  });

  it("deletes, then sets, then adds at the end", () => {
    const t = units();
    const res = applyTableEdits(
      t,
      delta([
        { op: "dbf.delete", table: "Gunits", key: ["G000UU0003"] },
        { op: "dbf.add", table: "Gunits", key: ["G230UU0001"], values: { UNIT_ID: "G230UU0001", NAME_TXT: "New", LEVEL: 5 } },
        { op: "dbf.set", table: "Gunits", key: ["G000UU0001"], field: "WATER_ONLY", value: true },
      ]),
    );
    expect(res.counts).toEqual({ deleted: 1, set: 1, added: 1, unchanged: 0 });
    expect(t.isDeleted(2)).toBe(true);
    expect(t.rowCount).toBe(5);
    expect(t.row(4)).toEqual({ UNIT_ID: "G230UU0001", NAME_TXT: "New", LEVEL: 5, WATER_ONLY: false });
    expect(Object.keys(liveRows(DbfTable.read(t.toBytes())))).toEqual(["G000UU0001", "G000UU0002", "G230UU0001"]);
  });

  it("counts what the parent already has as unchanged", () => {
    const t = units();
    const res = applyTableEdits(
      t,
      delta([
        { op: "dbf.set", table: "Gunits", key: ["G000UU0001"], field: "LEVEL", value: 1 },
        { op: "dbf.delete", table: "Gunits", key: ["G000UU0077"] },
        { op: "dbf.add", table: "Gunits", key: ["g000uu0003"], values: { UNIT_ID: "g000uu0003", NAME_TXT: "Archer", LEVEL: null, WATER_ONLY: true } },
      ]),
    );
    expect(res).toEqual({ conflicts: [], changed: false, counts: { deleted: 0, set: 0, added: 0, unchanged: 3 } });
  });

  it("reports what does not fit the parent, by reason", () => {
    const reasons = (ops: ModEditOp[]) => applyTableEdits(units(), delta(ops)).conflicts.map((c) => c.reason);
    expect(reasons([{ op: "dbf.set", table: "Gunits", key: ["G000UU0001"], field: "LEVEL", value: 7, was: 2 }])).toEqual(["parent-changed"]);
    expect(reasons([{ op: "dbf.set", table: "Gunits", key: ["G000UU0099"], field: "LEVEL", value: 7 }])).toEqual(["missing-row"]);
    expect(reasons([{ op: "dbf.set", table: "Gunits", key: ["G000UU0001"], field: "XP", value: 7 }])).toEqual(["no-field"]);
    expect(reasons([{ op: "dbf.set", table: "Gunits", key: ["G000UU0001"], field: "LEVEL", value: 1000 }])).toEqual(["cannot-hold"]);
    expect(reasons([{ op: "dbf.add", table: "Gunits", key: ["G000UU0001"], values: { UNIT_ID: "G000UU0001", LEVEL: 9 } }])).toEqual(["key-exists"]);
    expect(reasons([{ op: "dbf.add", table: "Gunits", key: ["G230UU0001"], values: { UNIT_ID: "G230UU0001", NAME_TXT: "a name too long" } }])).toEqual(["cannot-hold"]);
    const twice = units([...UNITS, { UNIT_ID: "G000UU0001", NAME_TXT: "Again" }]);
    expect(applyTableEdits(twice, delta([{ op: "dbf.delete", table: "Gunits", key: ["G000UU0003"] }])).conflicts.map((c) => c.reason)).toEqual(["key-not-unique"]);
    expect(applyTableEdits(units(), delta([{ op: "dbf.delete", table: "Gunits", key: ["x"] }], { kind: "columns", columns: ["ATT_ID"] })).conflicts[0]?.reason).toBe("no-key-column");
  });

  it("finds a changed row of a whole-row table a conflict, not a done delete", () => {
    const fields = [
      { name: "BELONGS_TO", type: "C" as const, length: 10 },
      { name: "PERCENT", type: "N" as const, length: 3 },
    ];
    const rebuilt = table("GmodifL", fields, [{ BELONGS_TO: "g000um0001", PERCENT: 15 }]);
    const res = applyTableEdits(
      rebuilt,
      delta(
        [
          { op: "dbf.delete", table: "GmodifL", key: ["G000UM0001", 10] },
          { op: "dbf.add", table: "GmodifL", key: ["G000UM0001", 20], values: { BELONGS_TO: "g000um0001", PERCENT: 20 } },
        ],
        { kind: "row" },
        "GmodifL",
      ),
    );
    expect(res.conflicts.map((c) => c.reason)).toEqual(["missing-row"]);
  });

  it("does not add a half row when a cell does not fit", () => {
    const t = units();
    applyTableEdits(t, delta([{ op: "dbf.add", table: "Gunits", key: ["G230UU0001"], values: { UNIT_ID: "G230UU0001", LEVEL: 12345 } }]));
    expect(t.rowCount).toBe(4);
    expect(t.modified).toBe(false);
  });
});

describe("the delta between two tables", () => {
  const roundTrip = (parent: DbfTable, child: DbfTable, key: KeyDecl, name = "Gunits") => {
    const d = diffTable(name, parent, child, key);
    const copy = DbfTable.read(parent.toBytes(), name);
    if (d.ops.length) {
      const res = applyTableEdits(copy, delta(d.ops, key, name));
      expect(res.conflicts).toEqual([]);
    }
    return { d, applied: copy };
  };

  it("is empty for a table and itself", () => {
    expect(diffTable("Gunits", units(), units(), UNIT).ops).toEqual([]);
  });

  it("turns the parent into the child, rows by key and in order", () => {
    const child = units([
      { UNIT_ID: "g000uu0001", NAME_TXT: "Squire II", LEVEL: 1, WATER_ONLY: false },
      { UNIT_ID: "g000uu0002", NAME_TXT: "Knight", LEVEL: null, WATER_ONLY: true },
      { UNIT_ID: "g230uu0001", NAME_TXT: "New", LEVEL: 4, WATER_ONLY: false },
    ]);
    const { d, applied } = roundTrip(units(), child, UNIT);
    expect(d.ops.map((o) => o.op).sort()).toEqual(["dbf.add", "dbf.delete", "dbf.set", "dbf.set", "dbf.set"]);
    expect(d.ops.find((o) => o.op === "dbf.set" && o.field === "LEVEL")).toEqual({ op: "dbf.set", table: "Gunits", key: ["G000UU0002"], field: "LEVEL", value: null, was: 3 });
    expect(liveRows(applied)).toEqual(liveRows(child));
    expect(Object.keys(liveRows(applied))).toEqual(Object.keys(liveRows(child)));
  });

  it("reports the child's own columns and values the parent cannot hold, and carries neither", () => {
    const wider = table("Gunits", [...UNIT_FIELDS.slice(0, 2), { name: "LEVEL", type: "N", length: 5 }, UNIT_FIELDS[3]!, { name: "XP_POTION", type: "L", length: 1 }], [
      { UNIT_ID: "g000uu0001", NAME_TXT: "Squire", LEVEL: 12345, WATER_ONLY: false, XP_POTION: true },
      { UNIT_ID: "g000uu0003", NAME_TXT: "Archer", LEVEL: null, WATER_ONLY: true },
      { UNIT_ID: "g000uu0002", NAME_TXT: "Knight", LEVEL: 3, WATER_ONLY: false },
    ]);
    const { d, applied } = roundTrip(units(), wider, UNIT);
    expect(d.schema.added.map((f) => f.name)).toEqual(["XP_POTION"]);
    expect(d.skipped).toEqual([{ key: ["G000UU0001"], field: "LEVEL", reason: expect.stringMatching(/does not fit/) }]);
    expect(d.ops).toEqual([]);
    expect(applied.get(0, "LEVEL")).toBe(1);
  });

  it("names the rows of a list table by the whole row", () => {
    const fields = [
      { name: "BELONGS_TO", type: "C" as const, length: 10 },
      { name: "TYPE", type: "N" as const, length: 2 },
    ];
    const parent = table("GmodifL", fields, [
      { BELONGS_TO: "g000um0001", TYPE: 1 },
      { BELONGS_TO: "g000um0001", TYPE: 2 },
    ]);
    const child = table("GmodifL", fields, [
      { BELONGS_TO: "g000um0001", TYPE: 1 },
      { BELONGS_TO: "g000um0001", TYPE: 3 },
    ]);
    const key = declareKey("GmodifL", parent);
    expect(key).toEqual({ kind: "row" });
    const { d, applied } = roundTrip(parent, child, key, "GmodifL");
    expect(d.ops).toEqual([
      { op: "dbf.delete", table: "GmodifL", key: ["G000UM0001", 2] },
      { op: "dbf.add", table: "GmodifL", key: ["G000UM0001", 3], values: { BELONGS_TO: "g000um0001", TYPE: 3 } },
    ]);
    expect(applied.rowCount).toBe(3);
    const other = table("GmodifL", [fields[0]!], [{ BELONGS_TO: "g000um0001" }]);
    expect(() => diffTable("GmodifL", parent, other, key)).toThrow(DiffError);
  });

  it("carries a change of letter case in a whole-row table, and reports one in a key cell", () => {
    const fields = [{ name: "TEXT", type: "C" as const, length: 20 }];
    const parent = table("TLeader", fields, [{ TEXT: "sir lancelot" }, { TEXT: "merlin" }]);
    const child = table("TLeader", fields, [{ TEXT: "Sir Lancelot" }, { TEXT: "merlin" }]);
    const { d, applied } = roundTrip(parent, child, { kind: "row" }, "TLeader");
    expect(d.ops.map((o) => o.op)).toEqual(["dbf.delete", "dbf.add"]);
    expect(Object.keys(liveRows(applied, "TEXT"))).toEqual(["MERLIN", "SIR LANCELOT"]);
    expect(liveRows(applied, "TEXT")["SIR LANCELOT"]).toEqual({ TEXT: "Sir Lancelot" });

    const upper = units(UNITS.map((r) => ({ ...r, UNIT_ID: String(r.UNIT_ID).toUpperCase() })));
    const k = diffTable("Gunits", units(), upper, UNIT);
    expect(k.ops).toEqual([]);
    expect(k.skipped.map((s) => s.field)).toEqual(["UNIT_ID", "UNIT_ID", "UNIT_ID"]);
  });

  it("declares the key of a table the registry does not know", () => {
    const lookup = table("LAttR", [{ name: "ID", type: "N", length: 3 }, { name: "TEXT", type: "C", length: 8 }], [{ ID: 1, TEXT: "a" }]);
    expect(declareKey("LAttR", lookup)).toEqual({ kind: "columns", columns: ["ID"] });
    expect(declareKey("Gitem", lookup)).toEqual({ kind: "columns", columns: ["ITEM_ID"] });
    const firstUnique = table("Gother", [{ name: "CODE", type: "C", length: 4 }], [{ CODE: "a" }, { CODE: "b" }]);
    expect(declareKey("Gother", firstUnique)).toEqual({ kind: "columns", columns: ["CODE"] });
    const notUnique = table("Gother", [{ name: "CODE", type: "C", length: 4 }], [{ CODE: "a" }, { CODE: "A" }]);
    expect(declareKey("Gother", notUnique)).toEqual({ kind: "row" });
  });
});
