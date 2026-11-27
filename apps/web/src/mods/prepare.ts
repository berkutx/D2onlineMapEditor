/**
 * The diff itself, from a worker payload: bytes -> DbfTable, capital.dat -> text, then
 * diffMods. Also the few look-up tables the page needs to show raw rows (owned rows of an
 * entity, list rows) in words: each side's L* constants, entity names and the texts those
 * rows name. Runs in the diff worker, or on the page when no worker can start.
 */
import { DbfTable } from "@d2/dbf";
import { diffMods, isNoId, linkOf, normId, rootOf, stripStyle, type ModData, type ModDiff, type Row, type SectionId } from "@d2/mod-diff";
import type { DiffPayload, PayloadSide } from "./loader";

/** What one side adds to the diff for display. */
export interface SideExtras {
  /** L* table (lower case) -> ID -> TEXT constant ("L_HUMAN"). */
  lookups: Record<string, Record<string, string>>;
  /** L* table (lower case) -> TEXT constant -> the mod's own name of it (LAttR REACH_TXT ...). */
  lookupNames: Record<string, Record<string, string>>;
  /** Entity id (upper case) -> name. */
  names: Record<string, string>;
  /** Text id (upper case) -> text, for the texts that owned and list rows name. */
  texts: Record<string, string>;
}

export interface DiffResult {
  diff: ModDiff;
  extras: { a: SideExtras; b: SideExtras };
  /** Time diffMods took. */
  ms: number;
}

/** capital.dat is ASCII; read it byte for byte (latin1), as the engine expects. */
export function latin1(bytes: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step));
  return s;
}

function rowsOf(t: DbfTable): Row[] {
  const out: Row[] = [];
  for (let r = 0; r < t.rowCount; r++) {
    if (t.isDeleted(r)) continue;
    const row: Row = {};
    for (const [k, v] of Object.entries(t.row(r))) row[k.toUpperCase()] = v;
    out.push(row);
  }
  return out;
}

const NAMED: ReadonlySet<SectionId> = new Set(["units", "attacks", "items", "spells", "buildings", "lords", "races", "modifiers", "landmarks"]);
const TEXT_TABLES = new Set(["tglobal", "tapp", "tappedit"]);
const OWN_NAME_COLUMNS = ["NAME_TXT", "REACH_TXT"];

function sideTables(p: PayloadSide, blobs: DiffPayload["blobs"], cache: Map<string, DbfTable>): Map<string, DbfTable> {
  const tables = new Map<string, DbfTable>();
  for (const [name, sha] of Object.entries(p.tables)) {
    const bytes = blobs[sha];
    if (!bytes) continue;
    // a table both mods share is read once and given to both sides (diffMods only reads)
    let t = cache.get(sha);
    if (!t) cache.set(sha, (t = DbfTable.read(new Uint8Array(bytes), `${p.id}/${name}`)));
    tables.set(name, t);
  }
  return tables;
}

function toModData(p: PayloadSide, tables: Map<string, DbfTable>, blobs: DiffPayload["blobs"]): ModData {
  const data: ModData = { id: p.id, name: p.name, tables, files: p.files };
  const cap = p.capitalSha ? blobs[p.capitalSha] : undefined;
  if (cap) data.capitalDat = latin1(new Uint8Array(cap));
  if (p.manifest) data.manifest = p.manifest;
  return data;
}

function textIndex(tables: Map<string, DbfTable>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, t] of tables) {
    if (!TEXT_TABLES.has(name.toLowerCase())) continue;
    for (const row of rowsOf(t)) {
      const id = normId(row.TXT_ID);
      if (id && !out.has(id)) out.set(id, stripStyle(String(row.TEXT ?? "")));
    }
  }
  return out;
}

/** Text ids that owned rows and list rows of the diff name through a text column. */
function referencedTexts(diff: ModDiff): Set<string> {
  const ids = new Set<string>();
  const scan = (table: string, row: Row | undefined) => {
    if (!row) return;
    for (const [col, v] of Object.entries(row)) {
      if (typeof v !== "string" || isNoId(v)) continue;
      if (linkOf(table, col)?.target.kind === "text") ids.add(normId(v));
    }
  };
  for (const list of Object.values(diff.sections)) {
    for (const e of list) {
      for (const o of e.owned) {
        scan(o.table, o.rowA);
        scan(o.table, o.rowB);
      }
      for (const l of e.lists) for (const r of [...l.a, ...l.b]) scan(l.table, r);
    }
  }
  return ids;
}

export function sideExtras(tables: Map<string, DbfTable>, wantTexts: ReadonlySet<string>): SideExtras {
  const texts = textIndex(tables);
  const extras: SideExtras = { lookups: {}, lookupNames: {}, names: {}, texts: {} };
  for (const [name, t] of tables) {
    const lower = name.toLowerCase();
    if (/^l/.test(lower) && t.hasField("ID") && t.hasField("TEXT")) {
      const byId: Record<string, string> = {};
      const own: Record<string, string> = {};
      for (const row of rowsOf(t)) {
        const constant = String(row.TEXT ?? "").trim();
        if (!constant) continue;
        byId[String(row.ID)] = constant;
        for (const col of OWN_NAME_COLUMNS) {
          const txt = row[col];
          if (typeof txt === "string" && !isNoId(txt)) {
            const words = texts.get(normId(txt));
            if (words) {
              own[constant] = words;
              break;
            }
          }
        }
      }
      extras.lookups[lower] = byId;
      if (Object.keys(own).length) extras.lookupNames[lower] = own;
      continue;
    }
    const spec = rootOf(name);
    if (!spec || !NAMED.has(spec.section) || !spec.nameColumn) continue;
    for (const row of rowsOf(t)) {
      const id = spec.idOf(row, name);
      const txt = row[spec.nameColumn];
      if (!id || typeof txt !== "string" || isNoId(txt)) continue;
      const words = texts.get(normId(txt));
      if (words) extras.names[id] = words;
    }
  }
  for (const id of wantTexts) {
    const words = texts.get(id);
    if (words !== undefined) extras.texts[id] = words;
  }
  return extras;
}

/** Turn a payload into the diff and its display extras. */
export function runPayload(payload: DiffPayload): DiffResult {
  const cache = new Map<string, DbfTable>();
  const ta = sideTables(payload.a, payload.blobs, cache);
  const tb = sideTables(payload.b, payload.blobs, cache);
  const t0 = performance.now();
  const diff = diffMods(toModData(payload.a, ta, payload.blobs), toModData(payload.b, tb, payload.blobs));
  const ms = Math.round(performance.now() - t0);
  const want = referencedTexts(diff);
  return { diff, extras: { a: sideExtras(ta, want), b: sideExtras(tb, want) }, ms };
}
