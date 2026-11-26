/**
 * A dBASE III table (.dbf) of the game, read and written without losing a byte.
 *
 * The game's tables carry quirks a "clean" writer would erase, all of them in the four mods
 * this editor serves (a survey of their 473 tables in Globals, Scens and Interf):
 *   - non-zero bytes in the header's reserved area and in field descriptors' reserved bytes;
 *   - a language byte that is mostly 0, sometimes 0x03, 0x26 or 0x65;
 *   - one extra 0x1A byte between the header terminator (0x0D) and the first record;
 *   - a file end of 0x1A, of 0x0D, or of nothing at all;
 *   - deleted rows (`*`), which the game skips and which stay in the file;
 *   - logical cells holding "?" (232 of them), "N" or "G" besides T, F and space;
 *   - author-only COMMENTS columns (Gbuild, Gmodif) whose text mixes CP1251 with CP866.
 * So a table keeps every byte it was read from — the header, the descriptors, each record,
 * the tail — and an edit rewrites exactly the cells it changes. A table that was not edited
 * writes back identical bytes; an edited one differs only in its edited cells (and the
 * record count when rows were appended).
 *
 * Values, read the way the game reads them (CodeBase 6.3 in the game's C4dll):
 *   C  CP866 text without the padding spaces on the right (leading spaces stay);
 *   N  a number, or null when the cell is blank (the game reads a blank as 0, the mss32 mod
 *      loader as "not given", so the two are kept apart here);
 *   L  true for T, t, Y, y and false for anything else, blank and "?" included.
 * Every C and N cell of the four mods (4.96 million) re-encodes to its own bytes
 * (test/mods.test.ts); an L cell other than T or F does not ("?" reads false, false writes "F"). Setting a cell to
 * the value it already reads as leaves its bytes alone, so a "?" survives a form that writes
 * back every field.
 */
import { decodeCp866, encodeCp866 } from "./cp866.js";

const HEADER_SIZE = 32;
const DESCRIPTOR_SIZE = 32;
const HEADER_TERMINATOR = 0x0d;
const LIVE = 0x20;
const DELETED = 0x2a;
const END_OF_FILE = 0x1a;
const SPACE = 0x20;

export type DbfValue = string | number | boolean | null;

export interface DbfField {
  /** The column name as stored (the game's tables use upper case; lookups ignore case). */
  readonly name: string;
  /** One letter: C (text), N (number), L (logical); others are read as text. */
  readonly type: string;
  /** Width in bytes. */
  readonly length: number;
  /** Digits after the point (N only). */
  readonly decimals: number;
  /** Offset of the cell inside a record; byte 0 of a record is its deletion flag. */
  readonly offset: number;
}

export interface DbfFieldSpec {
  name: string;
  type: "C" | "N" | "L";
  length: number;
  decimals?: number;
}

export class DbfError extends Error {
  override name = "DbfError";
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The value of a cell's stored bytes (see the rules above). `where` labels errors. Throws a
 * DbfError for an N cell that holds no number.
 */
export function decodeCell(f: Pick<DbfField, "type">, raw: Uint8Array, where = "cell"): DbfValue {
  switch (f.type) {
    case "C":
      return decodeCp866(raw).replace(/ +$/, "");
    case "N":
    case "F": {
      const text = latin1(raw).trim();
      if (text === "") return null;
      if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(text)) throw new DbfError(`${where}: ${JSON.stringify(text)} is not a number`);
      return Number(text);
    }
    case "L":
      return "TtYy".includes(String.fromCharCode(raw[0] ?? SPACE));
    default:
      return latin1(raw).replace(/ +$/, "");
  }
}

/**
 * The bytes a cell stores for a value: C padded with spaces on the right, N right-aligned,
 * L "T", "F" or (for null) a space; null blanks a C or N cell. Throws a DbfError for a value
 * the field cannot hold (too long, not a whole number, a character CP866 lacks, the wrong type).
 */
export function encodeCell(f: Pick<DbfField, "type" | "length" | "decimals">, value: DbfValue, where = "cell"): Uint8Array {
  switch (f.type) {
    case "C": {
      if (typeof value !== "string" && value !== null) throw new DbfError(`${where}: text expected, got ${typeof value}`);
      let bytes: Uint8Array;
      try {
        bytes = encodeCp866(value ?? "");
      } catch (e) {
        throw new DbfError(`${where}: ${(e as Error).message}`);
      }
      if (bytes.length > f.length) throw new DbfError(`${where}: ${bytes.length} characters do not fit C(${f.length})`);
      const out = new Uint8Array(f.length).fill(SPACE);
      out.set(bytes, 0);
      return out;
    }
    case "N":
    case "F": {
      if (value === null) return new Uint8Array(f.length).fill(SPACE);
      if (typeof value !== "number" || !Number.isFinite(value)) throw new DbfError(`${where}: a number expected, got ${String(value)}`);
      if (f.decimals === 0 && !Number.isInteger(value)) throw new DbfError(`${where}: N(${f.length}) holds whole numbers, not ${value}`);
      const text = value.toFixed(f.decimals);
      // toFixed falls back to exponent notation from 1e21 on, which no N cell can hold
      if (!/^-?\d+(\.\d+)?$/.test(text) || text.length > f.length) throw new DbfError(`${where}: ${value} does not fit N(${f.length},${f.decimals})`);
      const out = new Uint8Array(f.length).fill(SPACE);
      for (let i = 0; i < text.length; i++) out[f.length - text.length + i] = text.charCodeAt(i);
      return out;
    }
    case "L": {
      if (value !== null && typeof value !== "boolean") throw new DbfError(`${where}: true, false or null expected, got ${String(value)}`);
      return Uint8Array.of(value === null ? SPACE : value ? 0x54 /* T */ : 0x46 /* F */);
    }
    default:
      throw new DbfError(`${where}: fields of type ${f.type} cannot be written`);
  }
}

/** The field descriptors of a header, without the bytes they were read from. */
function readFields(data: Uint8Array, headerLength: number, table: string): DbfField[] {
  const fields: DbfField[] = [];
  let offset = 1; // past the deletion flag
  for (let i = HEADER_SIZE; ; i += DESCRIPTOR_SIZE) {
    if (i >= data.length || i >= headerLength) throw new DbfError(`${table}: the header has no terminator`);
    if (data[i] === HEADER_TERMINATOR) break;
    if (i + DESCRIPTOR_SIZE > headerLength) throw new DbfError(`${table}: a field descriptor runs past the header`);
    const nameBytes = data.subarray(i, i + 11);
    const nul = nameBytes.indexOf(0);
    const name = latin1(nul < 0 ? nameBytes : nameBytes.subarray(0, nul));
    const length = data[i + 16]!;
    fields.push({ name, type: String.fromCharCode(data[i + 11]!), length, decimals: data[i + 17]!, offset });
    offset += length;
  }
  return fields;
}

export class DbfTable {
  /** Lowercase name -> field. */
  private readonly byName: Map<string, DbfField>;
  private edited = false;

  private constructor(
    /** The table's name, for error messages ("GUnits"). */
    readonly name: string,
    /** Everything before the first record: header, descriptors, terminator, any extra byte. */
    private header: Uint8Array,
    readonly fields: readonly DbfField[],
    readonly recordLength: number,
    /** One entry per record, `recordLength` bytes each, the deletion flag first. */
    private readonly records: Uint8Array[],
    /** Whatever follows the declared records (0x1A, 0x0D, nothing). */
    private readonly tail: Uint8Array,
  ) {
    this.byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  }

  /** Read a table. `name` only labels errors. The bytes are copied; the input may be reused. */
  static read(bytes: Uint8Array, name = "table"): DbfTable {
    // the constructor copies; slice() would not for a Node Buffer (readFileSync's result)
    const data = new Uint8Array(bytes);
    if (data.length < HEADER_SIZE + 1) throw new DbfError(`${name}: ${data.length} bytes is too short for a dBASE table`);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint32(4, true);
    const headerLength = view.getUint16(8, true);
    const recordLength = view.getUint16(10, true);
    if (headerLength > data.length) throw new DbfError(`${name}: header length ${headerLength} exceeds the file`);
    const fields = readFields(data, headerLength, name);
    const width = fields.reduce((n, f) => n + f.length, 1);
    if (width !== recordLength) throw new DbfError(`${name}: fields take ${width} bytes, the header says ${recordLength}`);
    const end = headerLength + count * recordLength;
    if (end > data.length) throw new DbfError(`${name}: ${count} records need ${end} bytes, the file has ${data.length}`);
    const records: Uint8Array[] = [];
    for (let r = 0; r < count; r++) records.push(data.subarray(headerLength + r * recordLength, headerLength + (r + 1) * recordLength));
    return new DbfTable(name, data.subarray(0, headerLength), fields, recordLength, records, data.subarray(end));
  }

  /**
   * A new, empty table in the form the game's own tables have: version 3, no language byte,
   * a 0x0D header terminator, 0x1A at the end. `date` is the header's last-update date.
   */
  static create(name: string, specs: readonly DbfFieldSpec[], date: { year: number; month: number; day: number } = { year: 2000, month: 1, day: 1 }): DbfTable {
    if (specs.length === 0) throw new DbfError(`${name}: a table needs at least one field`);
    const headerLength = HEADER_SIZE + specs.length * DESCRIPTOR_SIZE + 1;
    const recordLength = specs.reduce((n, s) => n + s.length, 1);
    if (headerLength > 0xffff || recordLength > 0xffff) throw new DbfError(`${name}: too many or too wide fields`);
    const header = new Uint8Array(headerLength);
    const view = new DataView(header.buffer);
    header[0] = 0x03;
    header[1] = date.year - 1900;
    header[2] = date.month;
    header[3] = date.day;
    view.setUint16(8, headerLength, true);
    view.setUint16(10, recordLength, true);
    const seen = new Set<string>();
    specs.forEach((s, k) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,10}$/.test(s.name)) throw new DbfError(`${name}: bad field name ${JSON.stringify(s.name)}`);
      if (seen.has(s.name.toLowerCase())) throw new DbfError(`${name}: field ${s.name} twice`);
      seen.add(s.name.toLowerCase());
      const dec = s.decimals ?? 0;
      if (s.length < 1 || s.length > 254 || (s.type === "L" && s.length !== 1) || dec > Math.max(0, s.length - 2)) {
        throw new DbfError(`${name}: bad width for ${s.name} ${s.type}(${s.length},${dec})`);
      }
      const at = HEADER_SIZE + k * DESCRIPTOR_SIZE;
      for (let i = 0; i < s.name.length; i++) header[at + i] = s.name.charCodeAt(i);
      header[at + 11] = s.type.charCodeAt(0);
      header[at + 16] = s.length;
      header[at + 17] = dec;
    });
    header[headerLength - 1] = HEADER_TERMINATOR;
    return new DbfTable(name, header, readFields(header, headerLength, name), recordLength, [], Uint8Array.of(END_OF_FILE));
  }

  /** Number of records, deleted ones included (row numbers run over all of them). */
  get rowCount(): number {
    return this.records.length;
  }

  /** True once a cell, a deletion flag or the row count was changed. */
  get modified(): boolean {
    return this.edited;
  }

  field(name: string): DbfField | undefined {
    return this.byName.get(name.toLowerCase());
  }

  hasField(name: string): boolean {
    return this.byName.has(name.toLowerCase());
  }

  isDeleted(row: number): boolean {
    return this.record(row)[0] === DELETED;
  }

  /** Mark a row deleted (the game skips it) or live again. The row keeps its cells. */
  setDeleted(row: number, deleted: boolean): void {
    const rec = this.record(row);
    const flag = deleted ? DELETED : LIVE;
    if (rec[0] === flag) return;
    this.writable(row)[0] = flag;
    this.edited = true;
  }

  /** The stored bytes of one cell. A view: do not write into it. */
  raw(row: number, field: string): Uint8Array {
    const f = this.mustField(field);
    return this.record(row).subarray(f.offset, f.offset + f.length);
  }

  get(row: number, field: string): DbfValue {
    const f = this.mustField(field);
    return decodeCell(f, this.record(row).subarray(f.offset, f.offset + f.length), this.where(f, row));
  }

  /** All cells of a row by field name (as stored). */
  row(row: number): Record<string, DbfValue> {
    const rec = this.record(row);
    const out: Record<string, DbfValue> = {};
    for (const f of this.fields) out[f.name] = decodeCell(f, rec.subarray(f.offset, f.offset + f.length), this.where(f, row));
    return out;
  }

  /**
   * Write one cell. A value equal to what the cell reads as changes nothing, and so does one
   * whose bytes are already stored. Throws a DbfError for a value the field cannot hold
   * (see encodeCell); the cell is then left as it was. A cell that does not decode (an N cell
   * holding "***") can still be overwritten.
   */
  set(row: number, field: string, value: DbfValue): void {
    const f = this.mustField(field);
    const raw = this.record(row).subarray(f.offset, f.offset + f.length);
    let current: DbfValue | undefined;
    try {
      current = decodeCell(f, raw);
    } catch (e) {
      if (!(e instanceof DbfError)) throw e;
    }
    if (current === value) return;
    const bytes = encodeCell(f, value, this.where(f, row));
    if (sameBytes(bytes, raw)) return;
    this.writable(row).set(bytes, f.offset);
    this.edited = true;
  }

  /**
   * Append a live row of blank cells with the given ones set. Returns its row number. A value
   * the row cannot hold throws, and then no row is added.
   */
  appendRow(values: Readonly<Record<string, DbfValue>> = {}): number {
    const rec = new Uint8Array(this.recordLength).fill(SPACE);
    rec[0] = LIVE;
    const row = this.records.length;
    for (const [name, value] of Object.entries(values)) {
      const f = this.mustField(name);
      rec.set(encodeCell(f, value, this.where(f, row)), f.offset);
    }
    this.records.push(rec);
    this.edited = true;
    return row;
  }

  /** The table as file bytes. Unedited, these are the bytes it was read from. */
  toBytes(): Uint8Array {
    const size = this.header.length + this.records.length * this.recordLength + this.tail.length;
    const out = new Uint8Array(size);
    out.set(this.header, 0);
    new DataView(out.buffer).setUint32(4, this.records.length, true);
    let at = this.header.length;
    for (const rec of this.records) {
      out.set(rec, at);
      at += this.recordLength;
    }
    out.set(this.tail, at);
    return out;
  }

  // ---- internals ----

  private mustField(name: string): DbfField {
    const f = this.byName.get(name.toLowerCase());
    if (!f) throw new DbfError(`${this.name}: no field ${name}`);
    return f;
  }

  private record(row: number): Uint8Array {
    const rec = this.records[row];
    if (!rec) throw new DbfError(`${this.name}: no row ${row} (the table has ${this.records.length})`);
    return rec;
  }

  /** The record as an array of its own (the read buffer is shared until a row is edited). */
  private writable(row: number): Uint8Array {
    const rec = this.record(row).slice();
    this.records[row] = rec;
    return rec;
  }

  private where(f: DbfField, row: number): string {
    return `${this.name}.${f.name} row ${row}`;
  }
}
