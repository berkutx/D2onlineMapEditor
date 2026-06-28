/**
 * parseScenarioRaw — parse a `.sg` into a MapDocument AND a byte-offset index
 * (`SgRaw`) over the original buffer, so the writer can patch fields in place.
 *
 * The .sg has ~35 block types; we model only a handful. A faithful re-save must
 * therefore NOT re-serialise the file from the model (that would require guessing
 * the byte layout of every unmodeled block). Instead we keep the original bytes
 * verbatim and splice edits into them at the offsets captured here — mirroring the
 * editor's TagDataBlock pass-through. Zero edits ⇒ byte-identical output.
 */

import { SCHEMA_VERSION, type MapDocument } from "@d2/map-schema";
import { ByteBuffer } from "../bytebuffer.js";
import { iterateObjects, type FramedObject } from "../framing.js";
import { locateMapBlock, locateRoad } from "../blocks/terrain.js";
import { assembleDocument } from "../assemble.js";

const MAGIC = "D2EESFISIG";
const SG_PARSER_VERSION = "0.1.0";

/** One framed object's identity + field byte range (for moveObject/patchObject). */
export interface SgObjectRaw {
  id: string;
  typeName: string;
  fieldsFrom: number;
  fieldsEnd: number;
}

/** A terrain chunk's origin + the absolute offset of its first cell int32. */
export interface SgBlockRaw {
  bx: number;
  by: number;
  cellsAt: number;
}

/** A road block's covered cell + patchable INDEX/VAR offsets. */
export interface SgRoadRaw {
  x: number;
  y: number;
  indexAt: number | null;
  varAt: number | null;
}

/** One mountain entry of the single MidMountains block (for rebuilding it on export). */
export interface SgMountainRaw {
  x: number;
  y: number;
  w: number;
  h: number;
  image: number;
  race: number;
}

/** Byte-offset index over the original `.sg`, the canonical base for editing. */
export interface SgRaw {
  /** The original file bytes (never mutated; the writer works on a copy). */
  readonly bytes: Uint8Array;
  readonly size: number;
  /** Compound-id version prefix (e.g. "S143") for emitting new block ids. */
  readonly version: string;
  readonly objects: SgObjectRaw[];
  readonly objectById: Map<string, SgObjectRaw>;
  readonly blocks: SgBlockRaw[];
  /** chunk origin "bx,by" -> block (for O(1) setCell lookup). */
  readonly blockByOrigin: Map<string, SgBlockRaw>;
  readonly roads: SgRoadRaw[];
  /** cell "x,y" -> road block (for retuning an existing road in place). */
  readonly roadByCell: Map<string, SgRoadRaw>;
  /** original MidMountains entries (to rebuild the block when adding mountains). */
  readonly mountains: SgMountainRaw[];
  /** on-disk OBJ_ID of the single MidMountains block (e.g. "S143ML0000"), or null. */
  readonly mountainsBlockId: string | null;
}

function originKey(bx: number, by: number): string {
  return `${bx},${by}`;
}
function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Build the byte-offset index by walking every framed object once. */
function buildIndex(buf: ByteBuffer, doc: MapDocument): SgRaw {
  const objects: SgObjectRaw[] = [];
  const objectById = new Map<string, SgObjectRaw>();
  const blocks: SgBlockRaw[] = [];
  const blockByOrigin = new Map<string, SgBlockRaw>();
  const roads: SgRoadRaw[] = [];
  const roadByCell = new Map<string, SgRoadRaw>();

  for (const obj of iterateObjects(buf)) {
    const o: SgObjectRaw = {
      id: obj.id,
      typeName: obj.typeName,
      fieldsFrom: obj.fieldsFrom,
      fieldsEnd: obj.fieldsEnd,
    };
    objects.push(o);
    if (obj.id) objectById.set(obj.id, o);

    if (obj.typeName === "MidgardMapBlock") {
      const loc = locateMapBlock(buf, obj as FramedObject);
      if (loc) {
        blocks.push(loc);
        blockByOrigin.set(originKey(loc.bx, loc.by), loc);
      }
    } else if (obj.typeName === "MidRoad") {
      const loc = locateRoad(buf, obj as FramedObject);
      if (loc) {
        roads.push(loc);
        roadByCell.set(cellKey(loc.x, loc.y), loc);
      }
    }
  }

  // original mountains (one MidMountains block holds them all)
  const mountains: SgMountainRaw[] = [];
  for (const o of doc.objects) {
    if (o.type === "mountains") {
      mountains.push({
        x: o.pos.x, y: o.pos.y,
        w: o.w ?? 1, h: o.h ?? 1,
        image: o.image ?? 0, race: o.race ?? 0,
      });
    }
  }
  const mountainsBlockId = objects.find((o) => o.typeName === "MidMountains")?.id ?? null;

  return {
    bytes: buf.bytes,
    size: doc.size,
    version: doc.header.version || "S143",
    objects,
    objectById,
    blocks,
    blockByOrigin,
    roads,
    roadByCell,
    mountains,
    mountainsBlockId,
  };
}

/** Parse a `.sg` into both a render-ready MapDocument and a patchable byte index. */
export function parseScenarioRaw(bytes: Uint8Array): { doc: MapDocument; raw: SgRaw } {
  const buf = new ByteBuffer(bytes);
  const magic = buf.asciiSlice(0, MAGIC.length);
  if (magic !== MAGIC) {
    throw new Error(`sg-parser: bad magic ${JSON.stringify(magic)} (expected ${MAGIC})`);
  }
  const doc = assembleDocument(buf, SCHEMA_VERSION, SG_PARSER_VERSION);
  const raw = buildIndex(buf, doc);
  return { doc, raw };
}

export { originKey, cellKey };
