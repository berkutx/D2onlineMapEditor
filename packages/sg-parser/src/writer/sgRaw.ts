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
import { ByteBuffer, readDefaultString, readAllStrings } from "../bytebuffer.js";
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
  /** ID_MOUNT — per-entry id (non-sequential on loaded maps); preserved so a mountain edit doesn't
   *  renumber the survivors. Undefined for a freshly placed entry (gets its index at export). */
  idMount?: number;
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
        ...(o.idMount !== undefined ? { idMount: o.idMount } : {}),
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

/** The nil/empty sentinel for a ref slot ("G000000000" for a compound id, "000000" for a
 *  short item-ref) — a slot holding one of these points at nothing and has no dependent block. */
function isNilRef(id: string): boolean {
  return id === "" || /^G0+$/.test(id) || /^0+$/.test(id);
}

/** Tag-alphabet byte (A-Z, 0-9, _): used to reject a match that is the TAIL of a longer tag. */
function isTagChar(b: number | undefined): boolean {
  return b !== undefined && ((b >= 0x41 && b <= 0x5a) || (b >= 0x30 && b <= 0x39) || b === 0x5f);
}

/**
 * Read a single refField VALUE (`tag + [0B 00 00 00] + <id(10)> + NUL`) in [from, end), or
 * null. Two precision checks make a bare `indexOf` safe: (1) the int32 length must be 11 —
 * skips a tag that is only a PREFIX of a longer one (searching "STACK" never matches a
 * "STACK_ID" field); (2) the byte BEFORE the match must not be a tag character — skips a
 * match that is the SUFFIX of a longer tag ("STACK" inside an event's "ID_STACK", whose
 * following int32 IS 11 and would otherwise pass the length check).
 */
function readRefField(buf: ByteBuffer, tag: string, from: number, end: number): string | null {
  let cursor = from;
  for (;;) {
    const i = buf.indexOf(tag, cursor);
    if (i < 0 || i >= end) return null;
    const at = i + tag.length;
    const suffixOfLonger = i > from && isTagChar(buf.bytes[i - 1]);
    if (!suffixOfLonger && at + 4 <= buf.length && buf.readInt32LE(at) === 11) {
      return buf.asciiSlice(at + 4, at + 14);
    }
    cursor = i + 1; // a prefix/suffix-only hit — keep scanning
  }
}

/** A stack's dependent-block cascade, read straight from the raw bytes for a mid-stream delete. */
export interface StackDeleteCascade {
  /** garrison MidUnit (UNIT_0..5) + inventory MidItem (ITEM_ID list) instance ids to delete
   *  alongside the stack. LEADER_ID names one of the UNIT_j instances, so it adds no new id. */
  dependentIds: string[];
  /** the field range of the city/holder whose STACK ref points at this stack (to clear to the
   *  nil sentinel before the delete, else the referential guard fails loud), or null. */
  holder: { fieldsFrom: number; fieldsEnd: number } | null;
}

/**
 * Enumerate what a MidStack delete must cascade: its owned garrison MidUnit blocks + inventory
 * MidItem blocks (they are referenced ONLY by this stack, so they are removed with it), plus the
 * city/holder whose `STACK` visitor ref points at it (cleared to nil so no dangling reference
 * survives). Everything is read from the ORIGINAL bytes — no guessing, mirrors the readers.
 */
export function stackDeleteCascade(raw: SgRaw, stackId: string): StackDeleteCascade {
  const o = raw.objectById.get(stackId);
  if (!o) throw new Error(`stackDeleteCascade: unknown object ${stackId}`);
  if (o.typeName !== "MidStack") {
    throw new Error(`stackDeleteCascade: ${stackId} is ${o.typeName}, not a MidStack`);
  }
  const buf = new ByteBuffer(raw.bytes);
  const ids = new Set<string>();
  for (let s = 0; s < 6; s++) {
    const u = readDefaultString(buf, `UNIT_${s}`, o.fieldsFrom, o.fieldsEnd);
    if (u && !isNilRef(u)) ids.add(u);
  }
  for (const it of readAllStrings(buf, "ITEM_ID", o.fieldsFrom, o.fieldsEnd)) {
    if (it && !isNilRef(it)) ids.add(it);
  }
  // find the city/fort/capital whose STACK visitor ref points at this stack (if any).
  // Scan ONLY fort-like blocks: they are the sole holders of a visitor STACK ref — events
  // carry stack refs under OTHER tags (ID_STACK etc.) and must not trip a "visiting hero"
  // diagnosis (an event-referenced free stack is caught by the referential guard instead).
  const FORT_TYPES = new Set(["MidVillage", "MidFort", "Capital"]);
  let holder: StackDeleteCascade["holder"] = null;
  for (const other of raw.objects) {
    if (other.id === stackId || !FORT_TYPES.has(other.typeName)) continue;
    if (readRefField(buf, "STACK", other.fieldsFrom, other.fieldsEnd) === stackId) {
      holder = { fieldsFrom: other.fieldsFrom, fieldsEnd: other.fieldsEnd };
      break;
    }
  }
  return { dependentIds: [...ids], holder };
}

/** A fort's (village) delete cascade: garrison MidUnit instances + whether a hero visits. */
export interface FortDeleteCascade {
  /** garrison MidUnit (UNIT_0..5) instance ids to delete alongside the fort. */
  dependentIds: string[];
  /** true when the fort's own STACK ref names a visiting hero stack (delete must refuse —
   *  same journal/undo constraint as deleting the visitor stack itself). */
  hasVisitor: boolean;
}

/** Enumerate a MidVillage delete's cascade from the raw bytes (garrison units + visitor). */
export function villageDeleteCascade(raw: SgRaw, fortId: string): FortDeleteCascade {
  const o = raw.objectById.get(fortId);
  if (!o) throw new Error(`villageDeleteCascade: unknown object ${fortId}`);
  if (o.typeName !== "MidVillage") {
    throw new Error(`villageDeleteCascade: ${fortId} is ${o.typeName}, not a MidVillage`);
  }
  const buf = new ByteBuffer(raw.bytes);
  const ids = new Set<string>();
  for (let s = 0; s < 6; s++) {
    const u = readDefaultString(buf, `UNIT_${s}`, o.fieldsFrom, o.fieldsEnd);
    if (u && !isNilRef(u)) ids.add(u);
  }
  const visitor = readRefField(buf, "STACK", o.fieldsFrom, o.fieldsEnd);
  return { dependentIds: [...ids], hasVisitor: !!visitor && !isNilRef(visitor) };
}

/** Enumerate a MidRuin delete's cascade: its guardian MidUnit instances (UNIT_0..5).
 *  The ruin's ITEM is a GLOBAL GItem template (byte-verified on Riders) — no item cascade. */
export function ruinDeleteCascade(raw: SgRaw, ruinId: string): string[] {
  const o = raw.objectById.get(ruinId);
  if (!o) throw new Error(`ruinDeleteCascade: unknown object ${ruinId}`);
  if (o.typeName !== "MidRuin") {
    throw new Error(`ruinDeleteCascade: ${ruinId} is ${o.typeName}, not a MidRuin`);
  }
  const buf = new ByteBuffer(raw.bytes);
  const ids = new Set<string>();
  for (let s = 0; s < 6; s++) {
    const u = readDefaultString(buf, `UNIT_${s}`, o.fieldsFrom, o.fieldsEnd);
    if (u && !isNilRef(u)) ids.add(u);
  }
  return [...ids];
}

/** Enumerate a MidBag (chest) delete's cascade: its MidItem instance ids (ITEM_ID list). */
export function bagDeleteCascade(raw: SgRaw, bagId: string): string[] {
  const o = raw.objectById.get(bagId);
  if (!o) throw new Error(`bagDeleteCascade: unknown object ${bagId}`);
  if (o.typeName !== "MidBag") {
    throw new Error(`bagDeleteCascade: ${bagId} is ${o.typeName}, not a MidBag`);
  }
  const buf = new ByteBuffer(raw.bytes);
  const ids = new Set<string>();
  for (const it of readAllStrings(buf, "ITEM_ID", o.fieldsFrom, o.fieldsEnd)) {
    if (it && !isNilRef(it)) ids.add(it);
  }
  return [...ids];
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
