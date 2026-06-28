/**
 * SgWriter — fixed-width, in-place byte patcher over a copy of the original `.sg`.
 *
 * Every edit overwrites an int32 already present in the file (a terrain cell, an
 * object POS, a road INDEX/VAR); nothing is inserted or resized, so byte offsets
 * never shift and unmodeled blocks pass through verbatim. Operations that would
 * change the file's length (adding/removing objects, growing a string) are NOT
 * supported here and must fail loud at the op layer until M4 adds a growable path.
 */

import { ByteBuffer, tagValueOffset } from "../bytebuffer.js";
import { encodeCp1251 } from "./cp1251.js";
import { originKey, cellKey, type SgRaw } from "./sgRaw.js";

export class SgWriter {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly buf: ByteBuffer;

  constructor(private readonly raw: SgRaw) {
    // work on an independent copy; raw.bytes stays pristine
    this.bytes = raw.bytes.slice();
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.buf = new ByteBuffer(this.bytes);
  }

  /** Overwrite the raw int32 of terrain cell (x,y) — terrain/ground/forest bits. */
  setCellValue(x: number, y: number, value: number): void {
    const bx = Math.floor(x / 8) * 8;
    const by = Math.floor(y / 4) * 4;
    const block = this.raw.blockByOrigin.get(originKey(bx, by));
    if (!block) {
      throw new Error(
        `SgWriter.setCellValue: no terrain block covers cell ${x},${y} ` +
          `(chunk ${bx},${by}); creating a chunk is not supported`,
      );
    }
    const off = block.cellsAt + ((y - by) * 8 + (x - bx)) * 4;
    this.view.setInt32(off, value | 0, true);
  }

  /** Overwrite an object's POS_X/POS_Y int32s in place (moveObject). */
  setObjectPos(id: string, x: number, y: number): void {
    const o = this.raw.objectById.get(id);
    if (!o) throw new Error(`SgWriter.setObjectPos: unknown object ${id}`);
    const xa = tagValueOffset(this.buf, "POS_X", o.fieldsFrom, o.fieldsEnd);
    const ya = tagValueOffset(this.buf, "POS_Y", o.fieldsFrom, o.fieldsEnd);
    if (xa === null || ya === null) {
      throw new Error(`SgWriter.setObjectPos: object ${id} has no POS_X/POS_Y field`);
    }
    this.view.setInt32(xa, x | 0, true);
    this.view.setInt32(ya, y | 0, true);
  }

  /** Overwrite an existing road's INDEX/VAR at cell (x,y) (retune, not add). */
  setRoad(x: number, y: number, roadType: number, roadVar: number): void {
    const r = this.raw.roadByCell.get(cellKey(x, y));
    if (!r) {
      throw new Error(
        `SgWriter.setRoad: no MidRoad block at cell ${x},${y}; adding a road needs a new block`,
      );
    }
    if (r.indexAt === null || r.varAt === null) {
      throw new Error(`SgWriter.setRoad: road at ${x},${y} missing INDEX/VAR field`);
    }
    this.view.setInt32(r.indexAt, roadType | 0, true);
    this.view.setInt32(r.varAt, roadVar | 0, true);
  }

  /**
   * Overwrite an object's string field in place — ONLY when the new value has the same
   * byte length as the stored one (fixed-width splice; a length change would resize the
   * file and is not supported here). Used to re-roll a landmark's TYPE (all GLmark ids
   * are 10 chars, so the length is constant).
   */
  setObjectString(id: string, tag: string, value: string): void {
    const o = this.raw.objectById.get(id);
    if (!o) throw new Error(`SgWriter.setObjectString: unknown object ${id}`);
    const at = tagValueOffset(this.buf, tag, o.fieldsFrom, o.fieldsEnd);
    if (at === null) throw new Error(`SgWriter.setObjectString: object ${id} has no ${tag} field`);
    const stored = this.view.getInt32(at, true); // int32 length prefix = byteLen + 1 (incl NUL)
    const enc = encodeCp1251(value);
    if (enc.length + 1 !== stored) {
      throw new Error(
        `SgWriter.setObjectString: ${tag} length change not supported ` +
          `(${enc.length + 1} vs stored ${stored})`,
      );
    }
    this.bytes.set(enc, at + 4); // overwrite the chars (NUL stays put — same length)
  }

  /** Overwrite an arbitrary numeric (int32) field of an object in place. */
  setObjectInt(id: string, tag: string, value: number): void {
    const o = this.raw.objectById.get(id);
    if (!o) throw new Error(`SgWriter.setObjectInt: unknown object ${id}`);
    const at = tagValueOffset(this.buf, tag, o.fieldsFrom, o.fieldsEnd);
    if (at === null) throw new Error(`SgWriter.setObjectInt: object ${id} has no ${tag} field`);
    this.view.setInt32(at, value | 0, true);
  }

  /** The patched bytes (the writer's working copy). */
  toBytes(): Uint8Array {
    return this.bytes;
  }
}
