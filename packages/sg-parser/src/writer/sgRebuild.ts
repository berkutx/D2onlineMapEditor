/**
 * Growable `.sg` edits — APPEND new block frames (e.g. MidRoad) to the object
 * stream and bump the header object count. The `.sg` has no footer (header then
 * concatenated frames), so appending at EOF + patching the OB0000 count is enough;
 * `offset` is player-count-derived and unchanged. This is the M4 path for edits
 * that add blocks, complementing the fixed-width SgWriter.
 *
 * (Our reader scans for blocks, so appended blocks are found regardless of order;
 * game-faithful placement / Plan entries are a later refinement.)
 */

import { ByteBuffer, tagValueOffset } from "../bytebuffer.js";
import { ByteWriter } from "./byteWriter.js";
import { encodeCp1251 } from "./cp1251.js";

const hex4 = (n: number): string => (n >>> 0).toString(16).padStart(4, "0");

/** Build one complete framed block: WHAT/code/.?AVC + OBJ_ID + BEGOBJECT + body + ENDOBJECT. */
export function emitBlock(
  version: string,
  typeName: string,
  code: number,
  short: string,
  second: number,
  body: (w: ByteWriter, fullId: string) => void,
): Uint8Array {
  const full = version + short + hex4(second);
  const w = new ByteWriter();
  w.blockHeader(typeName, code);
  w.refField("OBJ_ID", full);
  w.begin();
  body(w, full);
  w.end();
  return w.toBytes();
}

/** A MidRoad block frame (code 15, short RA): ROAD_ID, INDEX, VAR, POS_X, POS_Y. */
export function roadFrame(
  version: string,
  second: number,
  x: number,
  y: number,
  index: number,
  variant: number,
): Uint8Array {
  return emitBlock(version, "MidRoad", 0x0f, "RA", second, (w, full) => {
    w.refField("ROAD_ID", full);
    w.defaultInt("INDEX", index);
    w.defaultInt("VAR", variant);
    w.defaultInt("POS_X", x);
    w.defaultInt("POS_Y", y);
  });
}

/** A MidLandmark block frame (code 0x13, short MM): LMARK_ID, TYPE, POS_X, POS_Y, DESC_TXT. */
export function landmarkFrame(
  version: string,
  second: number,
  x: number,
  y: number,
  lmarkId: string,
  desc = "",
): Uint8Array {
  return emitBlock(version, "MidLandmark", 0x13, "MM", second, (w, full) => {
    w.refField("LMARK_ID", full);
    w.stringField("TYPE", lmarkId);
    w.defaultInt("POS_X", x);
    w.defaultInt("POS_Y", y);
    w.stringField("DESC_TXT", desc);
  });
}

/** A MidItem block frame (code 0x0f, short IM): ITEM_ID (self) + ITEM_TYPE (global
 *  GItem template id). A scenario item instance referenced by chests/heroes. */
export function itemFrame(version: string, second: number, templateId: string): Uint8Array {
  return emitBlock(version, "MidItem", 0x0f, "IM", second, (w, full) => {
    w.refField("ITEM_ID", full);
    w.refField("ITEM_TYPE", templateId);
  });
}

/** A MidUnit block frame (code 0x0f, short UN): a unit INSTANCE referenced by a fort garrison
 *  or a stack. Minimal body verified on real bytes: UNIT_ID(self) + TYPE(global Gunit id) +
 *  LEVEL + MODIF count(0, tag=self id) + CREATION(0) + NAME_TXT("") + TRANSF/DYNLEVEL(false) +
 *  HP + XP. */
export function unitFrame(
  version: string,
  second: number,
  typeId: string,
  level: number,
  hp: number,
  xp = 0,
): Uint8Array {
  return emitBlock(version, "MidUnit", 0x0f, "UN", second, (w, full) => {
    w.refField("UNIT_ID", full);
    w.refField("TYPE", typeId);
    w.defaultInt("LEVEL", level);
    w.defaultInt(full, 0); // MODIF_ID list count (count tag = the unit's own id) = no modifiers
    w.defaultInt("CREATION", 0);
    w.stringField("NAME_TXT", ""); // default name
    w.bool("TRANSF", false);
    w.bool("DYNLEVEL", false);
    w.defaultInt("HP", hp);
    w.defaultInt("XP", xp);
  });
}

/** One mountain entry written into the MidMountains body. */
export interface MountainEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  image: number;
  race: number;
}

/** The single MidMountains block frame (code 0x14, short ML): count + per-entry fields. */
export function mountainsFrame(
  version: string,
  second: number,
  mountains: readonly MountainEntry[],
): Uint8Array {
  return emitBlock(version, "MidMountains", 0x14, "ML", second, (w, full) => {
    w.defaultInt(full, mountains.length);
    mountains.forEach((m, i) => {
      w.defaultInt("ID_MOUNT", i);
      w.defaultInt("SIZE_X", m.w);
      w.defaultInt("SIZE_Y", m.h);
      w.defaultInt("POS_X", m.x);
      w.defaultInt("POS_Y", m.y);
      w.defaultInt("IMAGE", m.image);
      w.defaultInt("RACE", m.race);
    });
  });
}

/** Per-block frame ranges (start/end byte offsets + on-disk OBJ_ID), in file order. */
function frameRanges(buf: ByteBuffer): { start: number; end: number; objId: string }[] {
  const out: { start: number; end: number; objId: string }[] = [];
  const first = buf.indexOf("WHAT");
  if (first < 0) return out;
  const starts: number[] = [];
  let p = first;
  for (;;) {
    const i = buf.indexOf("WHAT", p);
    if (i < 0) break;
    starts.push(i);
    p = i + 4;
  }
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k]!;
    const end = k + 1 < starts.length ? starts[k + 1]! : buf.length;
    const oid = buf.indexOf("OBJ_ID", start);
    // OBJ_ID is a refField: "OBJ_ID" + [0B 00 00 00] + value(10) + NUL
    const objId = oid >= 0 && oid < end ? buf.asciiSlice(oid + 10, oid + 20) : "";
    out.push({ start, end, objId });
  }
  return out;
}

/** Replace the block whose OBJ_ID == `objId` with `newFrame` (object count unchanged). */
export function replaceBlock(bytes: Uint8Array, objId: string, newFrame: Uint8Array): Uint8Array {
  const buf = new ByteBuffer(bytes);
  const f = frameRanges(buf).find((r) => r.objId === objId);
  if (!f) throw new Error(`replaceBlock: block ${objId} not found`);
  const out = new Uint8Array(bytes.length - (f.end - f.start) + newFrame.length);
  out.set(bytes.subarray(0, f.start), 0);
  out.set(newFrame, f.start);
  out.set(bytes.subarray(f.end), f.start + newFrame.length);
  return out;
}

/** One variable-length string field edit: where to find it + the new value. */
export interface StringFieldEdit {
  /** the object's BEGOBJECT+1 offset (raw.objectById fieldsFrom) */
  fieldsFrom: number;
  /** the object's ENDOBJECT offset (raw.objectById fieldsEnd) */
  fieldsEnd: number;
  /** the field tag, e.g. "NAME_TXT" / "TITLE" / "DESC_TXT" / "DESC" */
  tag: string;
  /** the new string value (CP1251-encoded; stored as int32 len(+NUL) + bytes + NUL) */
  value: string;
}

/** One count-prefixed ITEM_ID list edit (the chest item list). The new ordered list of
 *  MidItem instance ids replaces the whole `objId + int32(count) + N×ITEM_ID` tail. */
export interface ItemListEdit {
  /** the object's fieldsFrom (raw.objectById) */
  fieldsFrom: number;
  /** the object's fieldsEnd (raw.objectById) */
  fieldsEnd: number;
  /** the object's full 10-char compound id — the list count's tag (D2's writeDefaultInt(objId,count)). */
  objId: string;
  /** the new ordered list of MidItem instance ids (each a 10-char compound id). */
  instanceIds: readonly string[];
}

/** One site STOCK list edit (merchant items / mage spells / mercenary units). Unlike the
 *  chest ITEM_ID list, the count is keyed by a LITERAL `qtyTag` (not the objId) and the
 *  entries are GLOBAL template ids written directly (no MidItem/MidUnit instances). */
export interface QtyListEdit {
  fieldsFrom: number;
  fieldsEnd: number;
  qtyTag: string; // "QTY_ITEM" | "QTY_SPELL" | "QTY_UNIT"
  /** the per-entry field layout, in order (used to walk the OLD entries + write the new). */
  schema: { tag: string; kind: "str" | "int" | "bool" }[];
  /** new entries; each row's values are aligned to `schema`. */
  entries: (string | number | boolean)[][];
}

interface Splice {
  start: number;
  end: number;
  region: Uint8Array;
}

/** Build the splice that rewrites one site stock list (QTY_* tag + count + entries) in place. */
function qtyListSplice(buf: ByteBuffer, e: QtyListEdit): Splice {
  const at = buf.indexOf(e.qtyTag, e.fieldsFrom);
  if (at < 0 || at >= e.fieldsEnd) {
    throw new Error(`spliceVariableFields: stock tag ${e.qtyTag} not found in [${e.fieldsFrom},${e.fieldsEnd}]`);
  }
  // walk the OLD entries to find the span end (so we replace exactly the old list)
  let p = at + e.qtyTag.length;
  const oldCount = buf.readInt32LE(p);
  p += 4;
  for (let i = 0; i < oldCount; i++) {
    for (const fld of e.schema) {
      p += fld.tag.length;
      if (fld.kind === "str") p += 4 + buf.readInt32LE(p);
      else if (fld.kind === "int") p += 4;
      else p += 1;
    }
  }
  const w = new ByteWriter();
  w.cp(e.qtyTag).i32(e.entries.length);
  for (const row of e.entries) {
    e.schema.forEach((fld, j) => {
      const v = row[j];
      if (fld.kind === "str") w.stringField(fld.tag, String(v));
      else if (fld.kind === "int") w.defaultInt(fld.tag, Number(v));
      else w.bool(fld.tag, Boolean(v));
    });
  }
  return { start: at, end: p, region: w.toBytes() };
}

/** Build the splice for one variable-length string field (resize in place). */
function stringFieldSplice(buf: ByteBuffer, e: StringFieldEdit): Splice {
  const at = tagValueOffset(buf, e.tag, e.fieldsFrom, e.fieldsEnd);
  if (at === null) {
    throw new Error(`spliceVariableFields: field ${e.tag} not found in [${e.fieldsFrom},${e.fieldsEnd}]`);
  }
  const oldLen = buf.readInt32LE(at); // stored length = byteLen + 1 (incl trailing NUL)
  const enc = encodeCp1251(e.value);
  const region = new Uint8Array(4 + enc.length + 1); // int32 len + bytes + NUL(0)
  new DataView(region.buffer).setInt32(0, enc.length + 1, true);
  region.set(enc, 4);
  return { start: at, end: at + 4 + oldLen, region };
}

/**
 * Build the splice for one ITEM_ID list. The list is `objId + int32(count) + N×ITEM_ID`
 * written LAST in the object (verified against D2Bag), so the count's objId-tag (the
 * editor's writeDefaultInt(header.version+objId, count)) is the LAST occurrence of objId
 * in the field range, and [thatOffset, fieldsEnd] is exactly the count+items region.
 */
function itemListSplice(buf: ByteBuffer, e: ItemListEdit): Splice {
  const start = buf.lastIndexOf(e.objId, e.fieldsEnd);
  if (start < e.fieldsFrom) {
    throw new Error(`spliceVariableFields: item-list count tag ${e.objId} not found in [${e.fieldsFrom},${e.fieldsEnd}]`);
  }
  const w = new ByteWriter();
  w.cp(e.objId).i32(e.instanceIds.length);
  for (const id of e.instanceIds) w.refField("ITEM_ID", id);
  return { start, end: e.fieldsEnd, region: w.toBytes() };
}

/**
 * Stack (MidStack) inventory ITEM_ID list. Unlike a chest, the list sits MID-block (after
 * POS_0..5, before STACK_ID/SRCTMPL_ID) and the objId ALSO appears as the GROUP_ID/STACK_ID
 * ref VALUES — so neither lastIndexOf nor "replace to fieldsEnd" works. The bare count tag is
 * the objId occurrence NOT preceded by a refField length prefix (0B 00 00 00) — every ref VALUE
 * is, the count tag (preceded by POS_5's int32 ∈ {-1..5}) is not. We then walk the OLD N entries
 * to bound the span and replace EXACTLY that region.
 */
function stackCountTagOffset(buf: ByteBuffer, objId: string, from: number, end: number): number {
  let at = buf.indexOf(objId, from);
  while (at >= 0 && at < end) {
    const p = at - 4;
    const isRefValue =
      p >= 0 && buf.bytes[p] === 0x0b && buf.bytes[p + 1] === 0 && buf.bytes[p + 2] === 0 && buf.bytes[p + 3] === 0;
    if (!isRefValue) return at;
    at = buf.indexOf(objId, at + 1);
  }
  return -1;
}
function stackItemListSplice(buf: ByteBuffer, e: ItemListEdit): Splice {
  const start = stackCountTagOffset(buf, e.objId, e.fieldsFrom, e.fieldsEnd);
  if (start < 0) {
    throw new Error(`spliceVariableFields: stack item-list count tag ${e.objId} not found in [${e.fieldsFrom},${e.fieldsEnd}]`);
  }
  let p = start + e.objId.length;
  const oldCount = buf.readInt32LE(p);
  p += 4;
  for (let i = 0; i < oldCount; i++) {
    p += "ITEM_ID".length;
    p += 4 + buf.readInt32LE(p); // int32 len + payload (10-char id + NUL)
  }
  const w = new ByteWriter();
  w.cp(e.objId).i32(e.instanceIds.length);
  for (const id of e.instanceIds) w.refField("ITEM_ID", id);
  return { start, end: p, region: w.toBytes() }; // replace ONLY the old list span (mid-block safe)
}

/** Apply pre-computed splices to `bytes`, HIGHEST-offset-first so lower ranges stay valid. */
function applySplices(bytes: Uint8Array, splices: Splice[]): Uint8Array {
  if (splices.length === 0) return bytes;
  splices.sort((a, b) => b.start - a.start);
  let out = bytes;
  for (const s of splices) {
    const next = new Uint8Array(out.length - (s.end - s.start) + s.region.length);
    next.set(out.subarray(0, s.start), 0);
    next.set(s.region, s.start);
    next.set(out.subarray(s.end), s.start + s.region.length);
    out = next;
  }
  return out;
}

/**
 * M4 growable edit: rewrite variable-length STRING fields and count-prefixed ITEM_ID
 * lists in place, resizing the file. The `.sg` is purely marker-delimited (BEGOBJECT/
 * ENDOBJECT + tag scans) with only a header object-count and NO byte offset/size tables,
 * so a field can grow/shrink and the file stays valid — no fixups beyond the splice
 * itself. Object count is unchanged here (callers add/remove MidItem blocks separately
 * via appendBlocks). ALL offsets are computed UP FRONT on the input bytes, then splices
 * applied HIGHEST-offset-first so each lower range stays valid even across both kinds.
 */
export function spliceVariableFields(
  bytes: Uint8Array,
  stringEdits: readonly StringFieldEdit[],
  itemListEdits: readonly ItemListEdit[] = [],
  qtyListEdits: readonly QtyListEdit[] = [],
  stackItemListEdits: readonly ItemListEdit[] = [],
): Uint8Array {
  if (
    stringEdits.length === 0 && itemListEdits.length === 0 &&
    qtyListEdits.length === 0 && stackItemListEdits.length === 0
  ) return bytes;
  const buf = new ByteBuffer(bytes);
  const splices = [
    ...stringEdits.map((e) => stringFieldSplice(buf, e)),
    ...itemListEdits.map((e) => itemListSplice(buf, e)),
    ...qtyListEdits.map((e) => qtyListSplice(buf, e)),
    ...stackItemListEdits.map((e) => stackItemListSplice(buf, e)),
  ];
  return applySplices(bytes, splices);
}

/** Back-compat: string-field-only splice (used by existing callers/tests). */
export function spliceStringFields(bytes: Uint8Array, edits: readonly StringFieldEdit[]): Uint8Array {
  return spliceVariableFields(bytes, edits, []);
}

/** Append block frames to a `.sg` and bump the header object count. */
export function appendBlocks(bytes: Uint8Array, frames: Uint8Array[]): Uint8Array {
  if (frames.length === 0) return bytes.slice();
  const buf = new ByteBuffer(bytes);
  const firstWhat = buf.indexOf("WHAT");
  if (firstWhat < 0) throw new Error("appendBlocks: no object stream (no WHAT)");
  const obAt = buf.lastIndexOf("OB0000", firstWhat);
  if (obAt < 0) throw new Error("appendBlocks: OB0000 sentinel not found in header");
  const objCountAt = obAt + "OB0000".length;
  const objCount = buf.readInt32LE(objCountAt);

  const extra = frames.reduce((a, f) => a + f.length, 0);
  const out = new Uint8Array(bytes.length + extra);
  out.set(bytes, 0);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setInt32(
    objCountAt,
    objCount + frames.length,
    true,
  );
  let off = bytes.length;
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}
