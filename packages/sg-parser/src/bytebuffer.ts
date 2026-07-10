/**
 * Low-level little-endian byte reading over a .sg scenario buffer, plus the
 * verified tag-based field readers used by every block reader.
 *
 * VERIFIED field encoding (CLAUDE.md / spikes, do not re-derive):
 *  - int field:   raw ASCII tag (NOT null-terminated) + int32 LE value
 *  - string field: raw ASCII tag + int32 LE byteLen + byteLen CP1251 bytes
 *                  (the stored length usually INCLUDES a trailing NUL; we trim it)
 *  - bool field:   the raw ASCII tag is present with NO following value;
 *                  presence == true, absence == false
 *
 * Every tag search MUST be scoped to the current object's [BEGOBJECT..ENDOBJECT]
 * range so a tag from a neighbouring object is never read by mistake.
 */

const cp1251 = new TextDecoder("windows-1251");
const latin1 = new TextDecoder("latin1");
const enc = new TextEncoder();

/** A thin view over the scenario bytes with LE integer reads. */
export class ByteBuffer {
  readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  readInt32LE(at: number): number {
    return this.view.getInt32(at, true);
  }

  readUint32LE(at: number): number {
    return this.view.getUint32(at, true);
  }

  /** ASCII/latin1 slice (used for markers and raw debug). */
  asciiSlice(from: number, to: number): string {
    return latin1.decode(this.bytes.subarray(from, to));
  }

  /** CP1251-decoded slice (Windows-1251 to JS string). */
  cp1251Slice(from: number, to: number): string {
    return cp1251.decode(this.bytes.subarray(from, to));
  }

  /** Index of literal ASCII `needle` at/after `from`, or -1. */
  indexOf(needle: string, from = 0): number {
    return indexOfAscii(this.bytes, needle, from);
  }

  /** Last index of `needle` strictly before `before`, or -1. */
  lastIndexOf(needle: string, before: number): number {
    return lastIndexOfAscii(this.bytes, needle, before);
  }
}

/** Forward search for an ASCII needle inside a byte array. */
export function indexOfAscii(buf: Uint8Array, needle: string, from = 0): number {
  const pat = enc.encode(needle);
  const n = pat.length;
  if (n === 0) return from;
  const last = buf.length - n;
  const first = pat[0]!;
  for (let i = Math.max(0, from); i <= last; i++) {
    if (buf[i] !== first) continue;
    let j = 1;
    for (; j < n; j++) if (buf[i + j] !== pat[j]) break;
    if (j === n) return i;
  }
  return -1;
}

/** Backward search for an ASCII needle, scanning indices < `before`. */
export function lastIndexOfAscii(buf: Uint8Array, needle: string, before: number): number {
  const pat = enc.encode(needle);
  const n = pat.length;
  if (n === 0) return Math.min(before, buf.length);
  const first = pat[0]!;
  for (let i = Math.min(before, buf.length - n); i >= 0; i--) {
    if (buf[i] !== first) continue;
    let j = 1;
    for (; j < n; j++) if (buf[i + j] !== pat[j]) break;
    if (j === n) return i;
  }
  return -1;
}

/** Remove any trailing NUL characters from a decoded string. */
export function stripTrailingNul(s: string): string {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 0) n--;
  return n === s.length ? s : s.slice(0, n);
}

/**
 * Read the int32 immediately following raw ASCII `tag`, scoped to [from, end).
 * Returns `null` when the tag is not present in range.
 */
export function readDefaultInt(
  buf: ByteBuffer,
  tag: string,
  from: number,
  end: number,
): number | null {
  const i = buf.indexOf(tag, from);
  if (i < 0 || i >= end) return null;
  const at = i + tag.length;
  if (at + 4 > buf.length) return null;
  return buf.readInt32LE(at);
}

/**
 * Offset of the int32 value that immediately follows raw ASCII `tag`, scoped to
 * [from, end). This is `readDefaultInt`'s read position, exposed so the writer can
 * splice the value in place. Returns `null` when the tag is absent in range.
 */
export function tagValueOffset(
  buf: ByteBuffer,
  tag: string,
  from: number,
  end: number,
): number | null {
  const i = buf.indexOf(tag, from);
  if (i < 0 || i >= end) return null;
  const at = i + tag.length;
  if (at + 4 > buf.length) return null;
  return at;
}

/**
 * Read a length-prefixed CP1251 string following raw ASCII `tag`, scoped to
 * [from, end). The stored byte length frequently includes a trailing NUL, which
 * we strip. Returns `null` when the tag is not present in range.
 */
export function readDefaultString(
  buf: ByteBuffer,
  tag: string,
  from: number,
  end: number,
): string | null {
  const i = buf.indexOf(tag, from);
  if (i < 0 || i >= end) return null;
  let at = i + tag.length;
  if (at + 4 > buf.length) return null;
  const len = buf.readInt32LE(at);
  at += 4;
  if (len < 0 || at + len > buf.length) return null;
  return stripTrailingNul(buf.cp1251Slice(at, at + len));
}

/**
 * Read EVERY length-prefixed CP1251 string for raw ASCII `tag` in [from, end), in
 * order (e.g. a repeated `ITEM_ID` list). Advances past each string so consecutive
 * entries are all collected. Empty when the tag is absent.
 */
export function readAllStrings(
  buf: ByteBuffer,
  tag: string,
  from: number,
  end: number,
): string[] {
  const out: string[] = [];
  let cursor = from;
  for (;;) {
    const i = buf.indexOf(tag, cursor);
    if (i < 0 || i >= end) break;
    let at = i + tag.length;
    if (at + 4 > buf.length) break;
    const len = buf.readInt32LE(at);
    at += 4;
    if (len < 0 || at + len > buf.length) break;
    out.push(stripTrailingNul(buf.cp1251Slice(at, at + len)));
    cursor = at + len;
  }
  return out;
}

/**
 * Boolean field: VERIFIED that bool tags carry no value, so the tag's mere
 * presence in [from, end) means `true`.
 */
export function readDefaultBool(
  buf: ByteBuffer,
  tag: string,
  from: number,
  end: number,
): boolean {
  const i = buf.indexOf(tag, from);
  return i >= 0 && i < end;
}

/**
 * VALUE-carrying boolean field: raw tag + ONE value byte (0/1) — the reference's writeBool
 * encoding (IS_HUMAN, ALWAYSAI, BUY_*, MISSION, TRANSF, …). Returns null when the tag is
 * absent. NOT `readDefaultBool` (presence-only), which reads a present-but-FALSE byte as true.
 */
export function readBoolValue(
  buf: ByteBuffer,
  tag: string,
  from: number,
  end: number,
): boolean | null {
  const i = buf.indexOf(tag, from);
  if (i < 0 || i >= end) return null;
  return buf.bytes[i + tag.length] !== 0;
}
