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

/**
 * M4 growable edit: rewrite variable-length STRING fields in place, resizing the file.
 * The `.sg` is purely marker-delimited (BEGOBJECT/ENDOBJECT + tag scans) with only a
 * header object-count and NO byte offset/size tables, so a field can grow/shrink and the
 * file stays valid — no fixups beyond the splice itself. Object count is unchanged (we
 * edit values, not add/remove blocks). All field offsets are computed UP FRONT on the
 * input bytes, then splices applied HIGHEST-offset-first so each lower range stays valid.
 */
export function spliceStringFields(bytes: Uint8Array, edits: readonly StringFieldEdit[]): Uint8Array {
  if (edits.length === 0) return bytes;
  const buf = new ByteBuffer(bytes);
  const splices = edits.map((e) => {
    const at = tagValueOffset(buf, e.tag, e.fieldsFrom, e.fieldsEnd);
    if (at === null) {
      throw new Error(`spliceStringFields: field ${e.tag} not found in [${e.fieldsFrom},${e.fieldsEnd}]`);
    }
    const oldLen = buf.readInt32LE(at); // stored length = byteLen + 1 (incl trailing NUL)
    const enc = encodeCp1251(e.value);
    const region = new Uint8Array(4 + enc.length + 1); // int32 len + bytes + NUL(0)
    new DataView(region.buffer).setInt32(0, enc.length + 1, true);
    region.set(enc, 4);
    return { start: at, end: at + 4 + oldLen, region };
  });
  // overlapping ranges would mean two edits to the same field — reject (caller dedups).
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
