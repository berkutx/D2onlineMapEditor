/**
 * ByteWriter — growable little-endian writer that mirrors toolsqt's `ByteBuffer`
 * (DataBlock.h) method-for-method, so emitted `.sg` bytes match the reference
 * editor exactly. Used by the from-scratch map builder; the field/frame helpers
 * encode the VERIFIED .sg conventions (see CLAUDE.md + the writer spec).
 *
 * Reference (verbatim) semantics:
 *  - writeSimpleString / tag  = CP1251 raw bytes, no length, no NUL.
 *  - writeDefaultInt(name,v)  = tag(name) + int32 LE.
 *  - writeString(name,v)      = tag(name) + int32(v.length+1) + cp(v) + NUL.
 *  - writeDefaultString(name,id) (the "0B 00 00 00" G/uid ref) = tag(name) +
 *                               [0B 00 00 00] + cp(id, 10 chars) + NUL  (len const 11).
 *  - writeBool(name,v)        = tag(name) + 1 byte (00/01).
 *  - frame: WHAT + i32(code) + ".?AVC"+Type+"@@" + NUL ; BEGOBJECT+NUL ; … ; ENDOBJECT+NUL.
 */

import { encodeCp1251 } from "./cp1251.js";

/** The 4-byte length prefix for every defaultString ref ("\v\0\0\0" = 11). */
const DEFSTRING_LEN = 0x0b;
/** The empty/neutral reference id sentinel. */
export const EMPTY_REF = "G000000000";

export class ByteWriter {
  private out: number[] = [];

  // ---- primitives ----------------------------------------------------------
  raw(bytes: Uint8Array | number[]): this {
    for (let i = 0; i < bytes.length; i++) this.out.push(bytes[i]! & 0xff);
    return this;
  }
  u8(v: number): this {
    this.out.push(v & 0xff);
    return this;
  }
  intLE(v: number, size: number): this {
    for (let i = 0; i < size; i++) this.out.push((v >>> (8 * i)) & 0xff);
    return this;
  }
  i32(v: number): this {
    return this.intLE(v, 4);
  }
  /** Raw CP1251 string (no length, no NUL) — toolsqt `writeSimpleString`/`stringToByteArray`. */
  cp(s: string): this {
    return this.raw(encodeCp1251(s));
  }
  repitable(value: number, count: number): this {
    for (let i = 0; i < count; i++) this.out.push(value & 0xff);
    return this;
  }

  // ---- field helpers (between BEGOBJECT and ENDOBJECT) ----------------------
  /** tag(name) + int32 LE. */
  defaultInt(name: string, value: number): this {
    return this.cp(name).i32(value);
  }
  /** tag(name) + 1 byte (00/01). */
  bool(name: string, value: boolean): this {
    return this.cp(name).u8(value ? 1 : 0);
  }
  /** tag(name) + int32(byteLen+1) + cp(value) + NUL. */
  stringField(name: string, value: string): this {
    const bytes = encodeCp1251(value);
    return this.cp(name).i32(bytes.length + 1).raw(bytes).u8(0);
  }
  /**
   * A reference field: tag(name) + [0B 00 00 00] + cp(id) + NUL, where `id` is the
   * full 10-char on-disk id (e.g. "S143MB0001", "G000LR0013", or EMPTY_REF). The
   * length prefix is the fixed const 0x0B (= 10 chars + NUL).
   */
  refField(name: string, id: string): this {
    return this.cp(name).raw([DEFSTRING_LEN, 0, 0, 0]).cp(id).u8(0);
  }

  // ---- object frame --------------------------------------------------------
  blockHeader(typeName: string, code: number): this {
    return this.cp("WHAT").i32(code).cp(`.?AVC${typeName}@@`).u8(0);
  }
  begin(): this {
    return this.cp("BEGOBJECT").u8(0);
  }
  end(): this {
    return this.cp("ENDOBJECT").u8(0);
  }

  // ---- output / patching ---------------------------------------------------
  get length(): number {
    return this.out.length;
  }
  /** Overwrite a previously written int32 (LE) at byte offset `at` (for header offset fixup). */
  patchI32(at: number, v: number): void {
    for (let i = 0; i < 4; i++) this.out[at + i] = (v >>> (8 * i)) & 0xff;
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}
