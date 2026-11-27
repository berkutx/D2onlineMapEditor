/**
 * One mod's data, indexed for the diff: tables by lower-case name, decoded live rows, root
 * rows by entity id, texts by id, L* lookups by ID, and the names of entities.
 */
import { DbfError, type DbfTable } from "@d2/dbf";
import type { CellValue } from "@d2/mod-edit";
import { classifyId, isNoId, normId, stripStyle } from "./ids.js";
import { linkOf, rootOf, ROOTS, type RootSpec } from "./model.js";
import type { ModData, ModTables, Row, SectionId } from "./types.js";

export interface RootRow {
  /** Lower-case table name. */
  table: string;
  spec: RootSpec;
  row: Row;
}

export function tableEntries(tables: ModTables): [string, DbfTable][] {
  return tables instanceof Map ? [...tables.entries()] : Object.entries(tables as Record<string, DbfTable>);
}

const CP866 = new TextDecoder("ibm866");
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/;

/** A table's file bytes, the same bytes as CP866 text (one character per byte), and its layout. */
export interface TableText {
  bytes: Uint8Array;
  text: string;
  headerLength: number;
  recordLength: number;
}

export function tableText(t: DbfTable): TableText {
  const bytes = t.toBytes();
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(8, true);
  return { bytes, text: CP866.decode(bytes), headerLength, recordLength: t.recordLength };
}

/**
 * Every row of a table (null for a deleted one), decoded as @d2/dbf decodes a cell, in one
 * pass over the file: CP866 maps every byte to one character, so a cell is a slice of the
 * decoded file. C: the text without trailing spaces; N: a number or null; L: T/t/Y/y.
 */
export function decodeTable(t: DbfTable, tt: TableText = tableText(t)): (Row | null)[] {
  const { bytes, text, headerLength, recordLength } = tt;
  if (text.length !== bytes.length) return Array.from({ length: t.rowCount }, (_, r) => (t.isDeleted(r) ? null : decodeRow(t, r)));
  const fields = t.fields.map((f) => ({ f, name: f.name.toUpperCase() }));
  const out: (Row | null)[] = [];
  for (let r = 0; r < t.rowCount; r++) {
    const base = headerLength + r * recordLength;
    if (t.isDeleted(r)) {
      out.push(null);
      continue;
    }
    const row: Row = {};
    for (const { f, name } of fields) {
      const s = base + f.offset;
      const e = s + f.length;
      if (f.type === "C") {
        let end = e;
        while (end > s && text.charCodeAt(end - 1) === 32) end--;
        row[name] = text.slice(s, end);
      } else if (f.type === "L") {
        const c = bytes[s];
        row[name] = c === 0x54 || c === 0x74 || c === 0x59 || c === 0x79;
      } else {
        const int = f.type === "N" ? plainInteger(bytes, s, e) : undefined;
        if (int !== undefined) {
          row[name] = int;
          continue;
        }
        let ascii = f.type === "N" || f.type === "F";
        for (let k = s; ascii && k < e; k++) if (bytes[k]! >= 0x80) ascii = false;
        if (ascii) {
          const v = text.slice(s, e).trim();
          row[name] = v === "" ? null : NUMBER.test(v) ? Number(v) : null;
        } else {
          let v: CellValue = null;
          try {
            v = t.get(r, f.name);
          } catch (err) {
            if (!(err instanceof DbfError)) throw err;
          }
          row[name] = v;
        }
      }
    }
    out.push(row);
  }
  return out;
}

/** A blank cell (null) or a padded integer of up to 15 digits; undefined for anything else. */
function plainInteger(bytes: Uint8Array, s: number, e: number): number | null | undefined {
  let i = s;
  let j = e;
  while (i < j && bytes[i] === 32) i++;
  while (j > i && bytes[j - 1] === 32) j--;
  if (i === j) return null;
  const neg = bytes[i] === 45;
  if (neg || bytes[i] === 43) i++;
  if (i === j || j - i > 15) return undefined;
  let v = 0;
  for (; i < j; i++) {
    const d = bytes[i]! - 48;
    if (d < 0 || d > 9) return undefined;
    v = v * 10 + d;
  }
  return neg ? -v : v;
}

/** Every cell of a row, field names upper-cased. A cell that does not decode reads as null. */
export function decodeRow(t: DbfTable, r: number): Row {
  const out: Row = {};
  try {
    const raw = t.row(r);
    for (const [k, v] of Object.entries(raw)) out[k.toUpperCase()] = v;
  } catch (e) {
    if (!(e instanceof DbfError)) throw e;
    for (const f of t.fields) {
      let v: CellValue = null;
      try {
        v = t.get(r, f.name);
      } catch (err) {
        if (!(err instanceof DbfError)) throw err;
      }
      out[f.name.toUpperCase()] = v;
    }
  }
  return out;
}

export class ModSide {
  readonly id: string;
  readonly name: string;
  /** The table name entity ids are built with (set by diffMods to one name for both mods). */
  canonical: (lower: string) => string = (lower) => this.displayName(lower) ?? lower;
  private readonly byLower = new Map<string, { name: string; table: DbfTable }>();
  private readonly decoded = new Map<string, (Row | null)[]>();
  private readonly texts866 = new Map<string, TableText>();
  private readonly roots = new Map<string, Map<string, Row>>();
  private sectionIndex?: Map<SectionId, Map<string, RootRow[]>>;
  private readonly textTables = new Map<string, Map<string, string>>();
  private readonly lookups = new Map<string, Map<number, string>>();
  private readonly names = new Map<string, string | null>();
  private modifierEffects?: Map<string, string>;

  constructor(data: ModData) {
    this.id = data.id;
    this.name = data.name;
    for (const [name, table] of tableEntries(data.tables)) {
      const lower = name.toLowerCase();
      if (!this.byLower.has(lower)) this.byLower.set(lower, { name, table });
    }
  }

  tableNames(): string[] {
    return [...this.byLower.keys()];
  }

  table(lower: string): DbfTable | undefined {
    return this.byLower.get(lower.toLowerCase())?.table;
  }

  displayName(lower: string): string | undefined {
    return this.byLower.get(lower.toLowerCase())?.name;
  }

  /** A table's bytes and their CP866 text (cached). */
  text866(lower: string): TableText | undefined {
    const k = lower.toLowerCase();
    let tt = this.texts866.get(k);
    if (!tt) {
      const t = this.table(k);
      if (!t) return undefined;
      this.texts866.set(k, (tt = tableText(t)));
    }
    return tt;
  }

  /** Rows by row number: null for a deleted row. */
  rows(lower: string): (Row | null)[] {
    const k = lower.toLowerCase();
    let rows = this.decoded.get(k);
    if (!rows) {
      const t = this.table(k);
      rows = t ? decodeTable(t, this.text866(k)) : [];
      this.decoded.set(k, rows);
    }
    return rows;
  }

  /** Use another side's decoded rows for a table whose file is byte for byte the same here. */
  shareRows(lower: string, rows: (Row | null)[]): void {
    const k = lower.toLowerCase();
    if (!this.decoded.has(k)) this.decoded.set(k, rows);
  }

  liveRows(lower: string): Row[] {
    return this.rows(lower).filter((r): r is Row => r !== null);
  }

  liveCount(lower: string): number | null {
    const t = this.table(lower);
    if (!t) return null;
    let n = 0;
    for (let r = 0; r < t.rowCount; r++) if (!t.isDeleted(r)) n++;
    return n;
  }

  /** Root rows of a root table by entity id (the last live row wins). */
  root(lower: string): Map<string, Row> {
    const k = lower.toLowerCase();
    let m = this.roots.get(k);
    if (!m) {
      m = new Map();
      const spec = rootOf(k);
      const name = this.canonical(k);
      if (spec) for (const row of this.liveRows(k)) m.set(spec.idOf(row, name), row);
      this.roots.set(k, m);
    }
    return m;
  }

  /** Root rows of a section by id (a text id may sit in two tables). */
  sectionRows(section: SectionId, id: string): RootRow[] {
    if (!this.sectionIndex) {
      this.sectionIndex = new Map();
      for (const lower of this.byLower.keys()) {
        const spec = ROOTS.find((r) => r.match(lower));
        if (!spec) continue;
        let bySection = this.sectionIndex.get(spec.section);
        if (!bySection) this.sectionIndex.set(spec.section, (bySection = new Map()));
        for (const [eid, row] of this.root(lower)) {
          const list = bySection.get(eid);
          const rr = { table: lower, spec, row };
          if (list) list.push(rr);
          else bySection.set(eid, [rr]);
        }
      }
    }
    return this.sectionIndex.get(section)?.get(id) ?? [];
  }

  /** The texts of a text table by id, as stored (style tags kept). */
  textTable(lower: string): Map<string, string> {
    const k = lower.toLowerCase();
    let m = this.textTables.get(k);
    if (!m) {
      m = new Map();
      for (const row of this.liveRows(k)) {
        const id = normId(row.TXT_ID);
        if (id && typeof row.TEXT === "string") m.set(id, row.TEXT);
      }
      this.textTables.set(k, m);
    }
    return m;
  }

  /** A text by id, style tag stripped: Tglobal, then TApp, then TAppEdit. */
  text(id: unknown): string | null {
    const k = normId(id);
    if (!k) return null;
    for (const t of ["tglobal", "tapp", "tappedit"]) {
      const v = this.textTable(t).get(k);
      if (v !== undefined) return stripStyle(v);
    }
    return null;
  }

  /** An L* table's TEXT by ID. */
  lookup(table: string, value: CellValue): string | undefined {
    if (typeof value !== "number") return undefined;
    const k = table.toLowerCase();
    let m = this.lookups.get(k);
    if (!m) {
      m = new Map();
      for (const row of this.liveRows(k)) if (typeof row.ID === "number" && typeof row.TEXT === "string") m.set(row.ID, row.TEXT);
      this.lookups.set(k, m);
    }
    return m.get(value);
  }

  /** The name an entity has in this mod, or null. */
  entityName(section: SectionId, id: string): string | null {
    const k = `${section}|${id}`;
    if (this.names.has(k)) return this.names.get(k)!;
    let name: string | null = null;
    const rr = this.sectionRows(section, id)[0];
    if (rr) {
      if (section === "texts") name = typeof rr.row.TEXT === "string" ? stripStyle(rr.row.TEXT) : null;
      else if (rr.spec.nameColumn) name = this.text(rr.row[rr.spec.nameColumn]);
      if (!name && section === "modifiers") name = this.modifierEffect(id) ?? null;
      if (!name && section === "rules" && id === "GVars") name = "GVars";
      if (name === "") name = null;
    }
    this.names.set(k, name);
    return name;
  }

  /** The text of a modifier's first effect (GmodifL.DESC), for modifiers with no DESC_TXT. */
  private modifierEffect(id: string): string | undefined {
    if (!this.modifierEffects) {
      this.modifierEffects = new Map();
      for (const row of this.liveRows("gmodifl")) {
        const owner = normId(row.BELONGS_TO);
        if (this.modifierEffects.has(owner)) continue;
        const t = this.text(row.DESC);
        if (t) this.modifierEffects.set(owner, t);
      }
    }
    return this.modifierEffects.get(id);
  }

  /** What a link cell shows: the linked entity's name, the L* TEXT, the text. */
  display(table: string, column: string, value: CellValue | undefined): string | undefined {
    if (value === undefined || value === null) return undefined;
    const link = linkOf(table, column);
    if (!link) return undefined;
    switch (link.target.kind) {
      case "entity": {
        if (isNoId(value) || typeof value !== "string") return undefined;
        const section = classifyId(value)?.section ?? link.target.section;
        return this.entityName(section, normId(value)) ?? undefined;
      }
      case "lookup":
        return this.lookup(link.target.table, value);
      case "text":
        return isNoId(value) ? undefined : (this.text(value) ?? undefined);
      default:
        return undefined;
    }
  }

  /** Display of every link cell of a row that shows something. */
  rowText(table: string, row: Row | undefined): Record<string, string> | undefined {
    if (!row) return undefined;
    const out: Record<string, string> = {};
    for (const [f, v] of Object.entries(row)) {
      const d = this.display(table, f, v);
      if (d !== undefined && d !== "") out[f] = d;
    }
    return out;
  }
}
