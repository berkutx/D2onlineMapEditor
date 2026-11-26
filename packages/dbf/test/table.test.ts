/**
 * The table codec on tables built here, with every quirk the game's own tables have, so the
 * rules hold on a machine without a game install.
 */
import { describe, it, expect } from "vitest";
import { DbfError, DbfTable, decodeCell, decodeCp866, diffSchemas, encodeCell, encodeCp866, sameSchema } from "../src/index";

/** A table image as the game's tools leave it, byte by byte. */
function quirkyTable(opts: { extraHeaderByte?: boolean; tail?: number[] } = {}): Uint8Array {
  const fields: [string, string, number][] = [
    ["UNIT_ID", "C", 10],
    ["NAME_TXT", "C", 12],
    ["LEVEL", "N", 3],
    ["WATER_ONLY", "L", 1],
  ];
  const extra = opts.extraHeaderByte ? 1 : 0;
  const headerLength = 32 + fields.length * 32 + 1 + extra;
  const recordLength = 1 + fields.reduce((n, f) => n + f[2], 0);
  const rows = [
    // flag, id, name, level, water
    [0x20, "g000uu0001", " Сквайр", "  1", "T"],
    [0x2a, "g000uu0002", "Удалённый", "  2", "F"],
    [0x20, "g000uu0003", "Без уровня", "   ", "?"],
    [0x20, "g000uu0004", "Странный", " 12", "G"],
  ] as const;
  const tail = opts.tail ?? [0x1a];
  const out = new Uint8Array(headerLength + rows.length * recordLength + tail.length);
  const view = new DataView(out.buffer);
  out[0] = 0x03;
  out.set([125, 3, 14], 1); // 2025-03-14
  view.setUint32(4, rows.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  out.set([0, 0, 0, 0, 0x97, 0x77, 0x20, 0x05], 12); // the reserved area is not always zero
  out[29] = 0x26; // a language byte
  fields.forEach(([name, type, len], k) => {
    const at = 32 + k * 32;
    for (let i = 0; i < name.length; i++) out[at + i] = name.charCodeAt(i);
    out[at + 11] = type.charCodeAt(0);
    out[at + 16] = len;
    out.set([0, 1, 0, 0, 0, 1], at + 18); // reserved descriptor bytes some tables carry
  });
  out[32 + fields.length * 32] = 0x0d;
  if (extra) out[32 + fields.length * 32 + 1] = 0x1a;
  rows.forEach((r, k) => {
    let at = headerLength + k * recordLength;
    out[at++] = r[0];
    const cells = [r[1], r[2], r[3], r[4]];
    fields.forEach(([, , len], i) => {
      const bytes = encodeCp866(cells[i]!);
      const cell = new Uint8Array(len).fill(0x20);
      cell.set(bytes, 0);
      out.set(cell, at);
      at += len;
    });
  });
  out.set(tail, out.length - tail.length);
  return out;
}

describe("reading and writing back", () => {
  for (const variant of [
    { label: "a 0x1A end", opts: {} },
    { label: "an extra 0x1A after the header terminator", opts: { extraHeaderByte: true } },
    { label: "a 0x0D end", opts: { tail: [0x0d] } },
    { label: "no end byte", opts: { tail: [] } },
  ]) {
    it(`gives the same bytes for a table with ${variant.label}`, () => {
      const bytes = quirkyTable(variant.opts);
      const t = DbfTable.read(bytes, "GUnits");
      expect(t.rowCount).toBe(4);
      expect(t.modified).toBe(false);
      expect(t.toBytes()).toEqual(bytes);
    });
  }

  it("reads the values the way the game's tables mean them", () => {
    const t = DbfTable.read(quirkyTable(), "GUnits");
    expect(t.fields.map((f) => [f.name, f.type, f.length, f.offset])).toEqual([
      ["UNIT_ID", "C", 10, 1],
      ["NAME_TXT", "C", 12, 11],
      ["LEVEL", "N", 3, 23],
      ["WATER_ONLY", "L", 1, 26],
    ]);
    expect(t.row(0)).toEqual({ UNIT_ID: "g000uu0001", NAME_TXT: " Сквайр", LEVEL: 1, WATER_ONLY: true });
    expect(t.isDeleted(1)).toBe(true);
    expect(t.get(1, "water_only")).toBe(false); // names ignore case
    expect(t.get(2, "LEVEL")).toBeNull();
    expect(t.get(2, "WATER_ONLY")).toBe(false); // "?": the game reads anything but T/t/Y/y as false
    expect(t.get(3, "WATER_ONLY")).toBe(false); // "G"
    expect(decodeCp866(t.raw(3, "WATER_ONLY"))).toBe("G");
  });

  it("leaves a cell alone when it is set to what it reads as", () => {
    const bytes = quirkyTable();
    const t = DbfTable.read(bytes, "GUnits");
    for (let r = 0; r < t.rowCount; r++) for (const f of t.fields) t.set(r, f.name, t.get(r, f.name));
    expect(t.modified).toBe(false);
    expect(t.toBytes()).toEqual(bytes);
  });

  it("does not depend on the buffer it was read from, a Node Buffer included", () => {
    const bytes = quirkyTable();
    const t = DbfTable.read(bytes, "GUnits");
    bytes.fill(0);
    expect(t.get(0, "UNIT_ID")).toBe("g000uu0001");

    // Buffer.prototype.slice() is a view, not a copy: what readFileSync returns must be copied too
    const buf = Buffer.from(quirkyTable());
    const kept = Buffer.from(buf);
    const b = DbfTable.read(buf, "GUnits");
    b.set(0, "UNIT_ID", "g000uu0009");
    expect(buf.equals(kept)).toBe(true);
    buf.fill(0x20);
    expect(b.get(0, "UNIT_ID")).toBe("g000uu0009");
    expect(b.get(1, "UNIT_ID")).toBe("g000uu0002");
  });
});

describe("cells", () => {
  it("encode to the bytes they decode from", () => {
    const n = { type: "N", length: 5, decimals: 0 };
    const c = { type: "C", length: 6, decimals: 0 };
    const l = { type: "L", length: 1, decimals: 0 };
    const bytes = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
    expect(encodeCell(n, 42)).toEqual(bytes("   42"));
    expect(encodeCell(n, -7)).toEqual(bytes("   -7"));
    expect(encodeCell(n, null)).toEqual(bytes("     "));
    expect(decodeCell(n, bytes("   42"))).toBe(42);
    expect(decodeCell(n, bytes("     "))).toBeNull();
    expect(encodeCell(c, " ab")).toEqual(bytes(" ab   "));
    expect(decodeCell(c, bytes(" ab   "))).toBe(" ab");
    expect([..."TtYyFfNn? G"].map((ch) => decodeCell(l, bytes(ch)))).toEqual([true, true, true, true, false, false, false, false, false, false, false]);
    expect(encodeCell(l, true)).toEqual(bytes("T"));
    expect(encodeCell(l, false)).toEqual(bytes("F"));
    expect(encodeCell(l, null)).toEqual(bytes(" "));
  });

  it("refuse numbers toFixed would write in exponent notation", () => {
    const wide = { type: "N", length: 16, decimals: 0 };
    expect(() => encodeCell(wide, 1e21)).toThrow(/does not fit/);
    expect(() => encodeCell(wide, -1e21)).toThrow(/does not fit/);
    expect(() => encodeCell({ type: "N", length: 16, decimals: 2 }, 1e21)).toThrow(/does not fit/);
    expect(encodeCell(wide, 1e15)).toEqual(Uint8Array.from("1000000000000000", (ch) => ch.charCodeAt(0)));
  });
});

describe("edits", () => {
  it("rewrite only the edited cells", () => {
    const bytes = quirkyTable();
    const t = DbfTable.read(bytes, "GUnits");
    t.set(0, "NAME_TXT", "Рыцарь");
    t.set(2, "LEVEL", 105);
    t.set(3, "WATER_ONLY", false);
    expect(t.modified).toBe(true);
    const out = t.toBytes();
    expect(out.length).toBe(bytes.length);
    const changed: number[] = [];
    for (let i = 0; i < out.length; i++) if (out[i] !== bytes[i]) changed.push(i);
    const cell = (row: number, field: string): [number, number] => {
      const f = t.field(field)!;
      const at = 32 + 4 * 32 + 1 + row * t.recordLength + f.offset;
      return [at, at + f.length];
    };
    const inside = (i: number) =>
      [cell(0, "NAME_TXT"), cell(2, "LEVEL"), cell(3, "WATER_ONLY")].some(([a, b]) => i >= a && i < b);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every(inside)).toBe(true);
    const again = DbfTable.read(out, "GUnits");
    expect(again.row(0).NAME_TXT).toBe("Рыцарь");
    expect(again.get(2, "LEVEL")).toBe(105);
    expect(decodeCp866(again.raw(2, "LEVEL"))).toBe("105");
    expect(again.get(3, "WATER_ONLY")).toBe(false);
  });

  it("write blanks for null", () => {
    const t = DbfTable.read(quirkyTable(), "GUnits");
    t.set(0, "LEVEL", null);
    t.set(0, "WATER_ONLY", null);
    t.set(0, "NAME_TXT", null);
    expect(decodeCp866(t.raw(0, "LEVEL"))).toBe("   ");
    expect(decodeCp866(t.raw(0, "WATER_ONLY"))).toBe(" ");
    expect(t.get(0, "NAME_TXT")).toBe("");
  });

  it("refuse what a field cannot hold", () => {
    const t = DbfTable.read(quirkyTable(), "GUnits");
    expect(() => t.set(0, "NAME_TXT", "Слишком длинное имя")).toThrow(DbfError);
    expect(() => t.set(0, "NAME_TXT", "Rüstung")).toThrow(/CP866 has no byte/);
    expect(() => t.set(0, "LEVEL", 1000)).toThrow(/does not fit N\(3/);
    expect(() => t.set(0, "LEVEL", 1.5)).toThrow(/whole numbers/);
    expect(() => t.set(0, "LEVEL", "1" as unknown as number)).toThrow(/a number expected/);
    expect(() => t.set(0, "WATER_ONLY", 1 as unknown as boolean)).toThrow(DbfError);
    expect(() => t.set(0, "NOPE", 1)).toThrow(/no field NOPE/);
    expect(() => t.get(9, "LEVEL")).toThrow(/no row 9/);
    expect(t.modified).toBe(false);
  });

  it("add no row when a value of the new row is refused", () => {
    const bytes = quirkyTable();
    const t = DbfTable.read(bytes, "GUnits");
    expect(() => t.appendRow({ UNIT_ID: "g000uu0005", LEVEL: 1000 })).toThrow(/does not fit/);
    expect(() => t.appendRow({ NOPE: 1 })).toThrow(/no field NOPE/);
    expect(t.rowCount).toBe(4);
    expect(t.modified).toBe(false);
    expect(t.toBytes()).toEqual(bytes);
  });

  it("can overwrite a cell that does not decode", () => {
    const bytes = quirkyTable();
    const t = DbfTable.read(bytes, "GUnits");
    const f = t.field("LEVEL")!;
    const at = 32 + 4 * 32 + 1 + 0 * t.recordLength + f.offset;
    bytes.set([0x2a, 0x2a, 0x2a], at); // "***", dBASE's overflow mark
    const damaged = DbfTable.read(bytes, "GUnits");
    expect(() => damaged.get(0, "LEVEL")).toThrow(/is not a number/);
    damaged.set(0, "LEVEL", 5);
    expect(damaged.get(0, "LEVEL")).toBe(5);
  });

  it("do not count as edits when the bytes stay the same", () => {
    const t = DbfTable.read(quirkyTable(), "GUnits");
    t.set(2, "WATER_ONLY", false); // "?" already reads false: kept
    expect(decodeCp866(t.raw(2, "WATER_ONLY"))).toBe("?");
    t.set(2, "LEVEL", null); // already blank
    expect(t.modified).toBe(false);
  });

  it("append a row and count it in the header; the end byte stays", () => {
    const bytes = quirkyTable({ tail: [0x0d] });
    const t = DbfTable.read(bytes, "GUnits");
    const row = t.appendRow({ UNIT_ID: "g000uu0005", NAME_TXT: "Новый", LEVEL: 3 });
    expect(row).toBe(4);
    const out = t.toBytes();
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(5);
    expect(out[out.length - 1]).toBe(0x0d);
    const again = DbfTable.read(out, "GUnits");
    expect(again.row(4)).toEqual({ UNIT_ID: "g000uu0005", NAME_TXT: "Новый", LEVEL: 3, WATER_ONLY: false });
    expect(decodeCp866(again.raw(4, "WATER_ONLY"))).toBe(" ");
    expect(again.toBytes()).toEqual(out);
  });

  it("delete and restore a row, keeping its cells", () => {
    const t = DbfTable.read(quirkyTable(), "GUnits");
    t.setDeleted(0, true);
    t.setDeleted(1, false);
    const again = DbfTable.read(t.toBytes(), "GUnits");
    expect(again.isDeleted(0)).toBe(true);
    expect(again.isDeleted(1)).toBe(false);
    expect(again.get(0, "UNIT_ID")).toBe("g000uu0001");
  });
});

describe("a new table", () => {
  it("has the layout of the game's tables and reads back", () => {
    const t = DbfTable.create("LNew", [
      { name: "ID", type: "N", length: 2 },
      { name: "TEXT", type: "C", length: 20 },
      { name: "ON", type: "L", length: 1 },
    ]);
    t.appendRow({ ID: 1, TEXT: "Один", ON: true });
    t.appendRow({ ID: 2, TEXT: "Два" });
    const bytes = t.toBytes();
    expect(bytes[0]).toBe(0x03);
    expect(bytes[32 + 3 * 32]).toBe(0x0d);
    expect(bytes[bytes.length - 1]).toBe(0x1a);
    const again = DbfTable.read(bytes, "LNew");
    expect([again.row(0), again.row(1)]).toEqual([
      { ID: 1, TEXT: "Один", ON: true },
      { ID: 2, TEXT: "Два", ON: false },
    ]);
  });

  it("refuses a field the format cannot describe", () => {
    expect(() => DbfTable.create("X", [])).toThrow(DbfError);
    expect(() => DbfTable.create("X", [{ name: "TOO_LONG_NAME", type: "C", length: 1 }])).toThrow(/bad field name/);
    expect(() => DbfTable.create("X", [{ name: "A", type: "L", length: 2 }])).toThrow(/bad width/);
    expect(() =>
      DbfTable.create("X", [
        { name: "A", type: "C", length: 1 },
        { name: "a", type: "C", length: 1 },
      ]),
    ).toThrow(/twice/);
  });
});

describe("damaged files", () => {
  it("are refused with the reason", () => {
    const bytes = quirkyTable();
    expect(() => DbfTable.read(bytes.subarray(0, 20), "T")).toThrow(/too short/);
    expect(() => DbfTable.read(bytes.subarray(0, bytes.length - 30), "T")).toThrow(/records need/);
    const wrongWidth = bytes.slice();
    new DataView(wrongWidth.buffer).setUint16(10, 99, true);
    expect(() => DbfTable.read(wrongWidth, "T")).toThrow(/fields take 27 bytes/);
  });
});

describe("schemas", () => {
  it("tell added, removed and widened columns apart", () => {
    const a = [
      { name: "UNIT_ID", type: "C", length: 10, decimals: 0 },
      { name: "SCRIPT", type: "C", length: 40, decimals: 0 },
      { name: "IMMUNITYC", type: "N", length: 2, decimals: 0 },
    ];
    const b = [
      { name: "unit_id", type: "C", length: 10, decimals: 0 },
      { name: "SCRIPT", type: "C", length: 64, decimals: 0 },
      { name: "ATCK_COUNT", type: "N", length: 1, decimals: 0 },
    ];
    const d = diffSchemas(a, b);
    expect(d.added.map((f) => f.name)).toEqual(["ATCK_COUNT"]);
    expect(d.removed.map((f) => f.name)).toEqual(["IMMUNITYC"]);
    expect(d.changed.map((c) => [c.name, c.from.length, c.to.length])).toEqual([["SCRIPT", 40, 64]]);
    expect(sameSchema(a, a)).toBe(true);
    expect(sameSchema(a, b)).toBe(false);
  });
});

describe("CP866", () => {
  it("decodes every byte to its own character and back", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(encodeCp866(decodeCp866(all))).toEqual(all);
  });
});
