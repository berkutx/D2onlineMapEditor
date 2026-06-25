/**
 * Object framing for the .sg scenario format.
 *
 * VERIFIED layout per object (CLAUDE.md / spikes):
 *   WHAT <int32 len> .?AVC<TypeName>@@\0 OBJ_ID <int32 len> <compoundId>\0
 *   BEGOBJECT\0 ...fields... ENDOBJECT\0
 *
 * The `.?AVC<TypeName>@@` decl appears once per object, immediately before that
 * object's BEGOBJECT. We therefore iterate by BEGOBJECT/ENDOBJECT and recover
 * the TypeName from the nearest preceding `.?AVC...@@`.
 *
 * Type counts match `.?AVC<TypeName>@@` (one decl per instance), and the
 * Stage-0 spike proved `indexOf("<TypeName>@@")` counts match these too.
 */

import { ByteBuffer, stripTrailingNul } from "./bytebuffer.js";

const BEG = "BEGOBJECT";
const END = "ENDOBJECT";
const AVC_PREFIX = ".?AVC";
const AVC_SUFFIX = "@@";

/** A single framed object: its type name, compound id, and field byte range. */
export interface FramedObject {
  /** Decl TypeName, e.g. "MidStack", "Capital", "ScenarioInfo". */
  typeName: string;
  /** Compound uid as stored, e.g. "S143KC0001" (NUL-trimmed), or "" if absent. */
  id: string;
  /** Byte offset just AFTER `BEGOBJECT\0` (first field). */
  fieldsFrom: number;
  /** Byte offset of `ENDOBJECT` (exclusive upper bound for field scans). */
  fieldsEnd: number;
}

/** Iterate every framed object in declaration order. */
export function* iterateObjects(buf: ByteBuffer): Generator<FramedObject> {
  let cursor = 0;
  for (;;) {
    const beg = buf.indexOf(BEG, cursor);
    if (beg < 0) break;
    const end = buf.indexOf(END, beg + BEG.length);
    if (end < 0) break;

    const typeName = typeNameBefore(buf, beg);
    const id = compoundIdBefore(buf, beg);
    // fields start after "BEGOBJECT\0"
    let fieldsFrom = beg + BEG.length;
    if (buf.bytes[fieldsFrom] === 0) fieldsFrom += 1;

    yield { typeName, id, fieldsFrom, fieldsEnd: end };
    cursor = end + END.length;
  }
}

/** Recover the `.?AVC<TypeName>@@` TypeName immediately preceding `beg`. */
function typeNameBefore(buf: ByteBuffer, beg: number): string {
  const avc = buf.lastIndexOf(AVC_PREFIX, beg);
  if (avc < 0) return "";
  const nameStart = avc + AVC_PREFIX.length;
  const suffix = buf.indexOf(AVC_SUFFIX, nameStart);
  if (suffix < 0 || suffix >= beg) return "";
  return buf.asciiSlice(nameStart, suffix);
}

/** Recover the compound id from the `OBJ_ID` field preceding `beg`. */
function compoundIdBefore(buf: ByteBuffer, beg: number): string {
  const oid = buf.lastIndexOf("OBJ_ID", beg);
  if (oid < 0) return "";
  let at = oid + "OBJ_ID".length;
  if (at + 4 > buf.length) return "";
  const len = buf.readInt32LE(at);
  at += 4;
  if (len < 0 || at + len > beg) return "";
  return stripTrailingNul(buf.cp1251Slice(at, at + len));
}

/**
 * Enumerate the distinct `.?AVC<TypeName>@@` type names present in the buffer
 * (matches `MidScenarioInfo`-less names like `ScenarioInfo`, `Capital`).
 */
export function enumerateTypeNames(buf: ByteBuffer): Set<string> {
  const text = buf.asciiSlice(0, buf.length);
  const re = /\.\?AVC([A-Za-z0-9_]+)@@/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) names.add(m[1]!);
  return names;
}

/** Count occurrences of `<TypeName>@@` (== object instance count for that type). */
export function countType(buf: ByteBuffer, typeName: string): number {
  const needle = typeName + AVC_SUFFIX;
  let i = 0;
  let n = 0;
  for (;;) {
    i = buf.indexOf(needle, i);
    if (i < 0) break;
    n++;
    i += needle.length;
  }
  return n;
}

/** Parsed compound id: `S143` version + 2-char type code + 4-hex index. */
export interface CompoundId {
  raw: string;
  version: string; // e.g. "S143"
  typeCode: string; // e.g. "KC", "PL", "FT", "LO"
  index: number; // 4-hex parsed, or NaN
}

const COMPOUND_RE = /^([A-Za-z]\d{3})([A-Za-z]{2})([0-9A-Fa-f]{4})$/;

/** Parse a compound uid like "S143KC0001" into parts. Returns null if it does not match. */
export function parseCompoundId(raw: string): CompoundId | null {
  const m = COMPOUND_RE.exec(raw);
  if (!m) return null;
  return {
    raw,
    version: m[1]!,
    typeCode: m[2]!,
    index: parseInt(m[3]!, 16),
  };
}
