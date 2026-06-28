/**
 * Terrain-related block readers: MidgardMap (size), MidgardMapBlock (cells),
 * MidRoad (road overlay applied onto cells).
 */

import { ByteBuffer, readDefaultInt, tagValueOffset } from "../bytebuffer.js";
import type { FramedObject } from "../framing.js";
import { parseCompoundId } from "../framing.js";
import type { TerrainBlock } from "../grid.js";
import { CHUNK_CELLS } from "../grid.js";

/**
 * MidgardMap: an untagged int32 map size follows the compound id at the start of
 * the object body. We read it defensively by locating the id string and reading
 * the int32 immediately after it.
 */
export function readMidgardMapSize(buf: ByteBuffer, obj: FramedObject): number | null {
  if (!obj.id) return null;
  const idAt = buf.indexOf(obj.id, obj.fieldsFrom);
  if (idAt < 0 || idAt >= obj.fieldsEnd) return null;
  // id is stored NUL-terminated in the body; skip id + its NUL
  let at = idAt + obj.id.length;
  if (buf.bytes[at] === 0) at += 1;
  if (at + 4 > buf.length) return null;
  return buf.readInt32LE(at);
}

/**
 * MidgardMapBlock: read the chunk origin from the block uid and the 32 cell
 * int32s from BLOCKDATA. Returns null if the block is malformed.
 */
export function readMapBlock(buf: ByteBuffer, obj: FramedObject): TerrainBlock | null {
  const id = parseCompoundId(obj.id);
  if (!id) return null;
  // chunk origin (in cells) from uid low word
  const bx = id.index & 0xff;
  const by = (id.index >> 8) & 0xff;

  const bdi = buf.indexOf("BLOCKDATA", obj.fieldsFrom);
  if (bdi < 0 || bdi >= obj.fieldsEnd) return null;
  let at = bdi + "BLOCKDATA".length;
  const byteLen = buf.readInt32LE(at);
  at += 4;
  if (byteLen < CHUNK_CELLS * 4 || at + byteLen > buf.length) return null;

  const values: number[] = new Array(CHUNK_CELLS);
  for (let i = 0; i < CHUNK_CELLS; i++) {
    values[i] = buf.readInt32LE(at + i * 4);
  }
  return { bx, by, values };
}

/**
 * Locate a MidgardMapBlock's raw cell bytes for in-place patching (the writer).
 * Returns the chunk origin (bx,by, in cells) and the absolute byte offset of the
 * first of its 32 int32 cells (i.e. just past `BLOCKDATA` + its int32 byteLen).
 * Cell (x,y) inside the chunk lives at `cellsAt + ((y-by)*8 + (x-bx)) * 4`.
 */
export interface MapBlockLoc {
  bx: number;
  by: number;
  cellsAt: number;
}
export function locateMapBlock(buf: ByteBuffer, obj: FramedObject): MapBlockLoc | null {
  const id = parseCompoundId(obj.id);
  if (!id) return null;
  const bx = id.index & 0xff;
  const by = (id.index >> 8) & 0xff;
  const bdi = buf.indexOf("BLOCKDATA", obj.fieldsFrom);
  if (bdi < 0 || bdi >= obj.fieldsEnd) return null;
  const cellsAt = bdi + "BLOCKDATA".length + 4; // skip tag + int32 byteLen
  if (cellsAt + CHUNK_CELLS * 4 > buf.length) return null;
  return { bx, by, cellsAt };
}

/** A road overlay record extracted from a MidRoad block. */
export interface RoadRecord {
  x: number;
  y: number;
  roadType: number; // INDEX
  roadVar: number; // VAR
}

/** MidRoad: carries INDEX (roadType), VAR (roadVar), POS_X, POS_Y (cartesian). */
export function readRoad(buf: ByteBuffer, obj: FramedObject): RoadRecord | null {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const x = readDefaultInt(buf, "POS_X", f, e);
  const y = readDefaultInt(buf, "POS_Y", f, e);
  if (x === null || y === null) return null;
  const roadType = readDefaultInt(buf, "INDEX", f, e) ?? -1;
  const roadVar = readDefaultInt(buf, "VAR", f, e) ?? -1;
  return { x, y, roadType, roadVar };
}

/**
 * Locate a MidRoad block's patchable fields: the cell it covers and the absolute
 * byte offsets of its INDEX/VAR int32s (null when the tag is absent). Used by the
 * writer to retune an existing road in place (adding a road needs a new block).
 */
export interface RoadLoc {
  x: number;
  y: number;
  indexAt: number | null;
  varAt: number | null;
}
export function locateRoad(buf: ByteBuffer, obj: FramedObject): RoadLoc | null {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const x = readDefaultInt(buf, "POS_X", f, e);
  const y = readDefaultInt(buf, "POS_Y", f, e);
  if (x === null || y === null) return null;
  return {
    x,
    y,
    indexAt: tagValueOffset(buf, "INDEX", f, e),
    varAt: tagValueOffset(buf, "VAR", f, e),
  };
}
