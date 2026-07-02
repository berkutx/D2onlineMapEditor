/**
 * Map integrity validator — the editor's #1 safety net before any `.sg` leaves us.
 *
 * Three op-agnostic tiers live here (the op-aware semantic tier lives in
 * @d2/map-edit). They port the intent of the reference editor's checks:
 *   - roundTripIdentity  == BlockComparator: re-emit with no edits, expect the
 *                           exact same bytes (proves the pass-through is lossless).
 *   - verifyCellOffsets   : every captured cell offset reads back the parsed value
 *                           (proves setCell patches will land on the right bytes).
 *   - validateMap         == MapConverter::validateMap subset: structural + ref
 *                           sanity of the MapDocument.
 */

import type { MapDocument, MapObject } from "@d2/map-schema";
import { originKey, parseScenarioRaw, type SgRaw } from "./sgRaw.js";
import { SgWriter } from "./patch.js";

/** True iff two byte arrays are identical. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** First differing byte offset, or -1 if equal (for diagnostics). */
export function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/**
 * Tier 1 — write with zero edits and confirm byte-identical output. This is the
 * round-trip guarantee that lets us splice edits without corrupting unmodeled blocks.
 */
export function roundTripIdentity(bytes: Uint8Array): boolean {
  const { raw } = parseScenarioRaw(bytes);
  const out = new SgWriter(raw).toBytes();
  return bytesEqual(out, bytes);
}

/**
 * Cross-check the cell offset index: the int32 at each computed offset must equal
 * the value the parser decoded. Returns the count of mismatches (0 == sound).
 */
export function verifyCellOffsets(raw: SgRaw, doc: MapDocument): number {
  const view = new DataView(raw.bytes.buffer, raw.bytes.byteOffset, raw.bytes.byteLength);
  let mismatches = 0;
  for (const c of doc.terrain.cells) {
    const bx = Math.floor(c.x / 8) * 8;
    const by = Math.floor(c.y / 4) * 4;
    const block = raw.blockByOrigin.get(originKey(bx, by));
    if (!block) {
      // an uncovered cell defaults to 0 in the grid; only a non-zero value is wrong
      if (c.value !== 0) mismatches++;
      continue;
    }
    const off = block.cellsAt + ((c.y - by) * 8 + (c.x - bx)) * 4;
    if (view.getInt32(off, true) !== c.value) mismatches++;
  }
  return mismatches;
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Objects that carry an `owner` linking to a player. */
function ownerOf(o: MapObject): string | undefined {
  return "owner" in o && typeof o.owner === "string" ? o.owner : undefined;
}

/**
 * Tier 3 — structural + referential sanity of a MapDocument. Structural problems
 * are hard errors (a malformed map); unresolved refs are warnings for now (we do
 * not yet model every cross-block reference the editor checks).
 */
export function validateMap(doc: MapDocument): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { size } = doc;
  if (!Number.isInteger(size) || size <= 0) errors.push(`bad map size ${size}`);

  const cells = doc.terrain.cells;
  if (cells.length !== size * size) {
    errors.push(`terrain has ${cells.length} cells, expected ${size * size}`);
  }
  // row-major integrity: index y*size+x holds the matching x,y
  let gridOk = cells.length === size * size;
  if (gridOk) {
    for (let y = 0; y < size && gridOk; y++) {
      for (let x = 0; x < size; x++) {
        const c = cells[y * size + x];
        if (!c || c.x !== x || c.y !== y) {
          errors.push(`terrain cell at index ${y * size + x} is not (${x},${y})`);
          gridOk = false;
          break;
        }
      }
    }
  }

  if (doc.players.length === 0) errors.push("map has no players");
  const playerIds = new Set<string>();
  for (const p of doc.players) {
    if (playerIds.has(p.id)) errors.push(`duplicate player id ${p.id}`);
    playerIds.add(p.id);
  }

  const objectIds = new Set<string>();
  for (const o of doc.objects) {
    if (!o.id) {
      warnings.push(`object of type ${o.type} has no id`);
      continue;
    }
    if (objectIds.has(o.id)) errors.push(`duplicate object id ${o.id}`);
    objectIds.add(o.id);
    const owner = ownerOf(o);
    if (owner && !playerIds.has(owner)) {
      warnings.push(`object ${o.id} owner ${owner} does not resolve to a player`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Tier 3b — BYTE-level block integrity. Catches the exact defect classes that our
 * self-consistent parser/writer CANNOT see but that make the GAME editor refuse a map
 * (discovered via the ScenEdit gold check):
 *   1. the OB0000 header count must equal the number of block frames actually present
 *      (the game trusts it to know how many blocks to read);
 *   2. every internal reference (the `0B 00 00 00`-prefixed 10-char ids inside block
 *      bodies: FOG_ID, SUBRACE, STACK, OWNER, INSIDE, ELEMENT, event ID_LOC/ID_STACK…)
 *      should point to an EXISTING block of this map. Dangling refs are WARNINGS, not
 *      errors: shipped campaign maps carry some (Dragon's teeth references a deleted
 *      player S143PL0001 and still loads — the game falls back), but they are exactly
 *      how «событие ссылается на удалённый объект» class bugs surface, so we report them.
 * Global game-data ids (G000…) and the empty sentinel are outside the map and skipped.
 */
export function verifyBlockIntegrity(bytes: Uint8Array): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const buf = bytes;
  const td = new TextDecoder("latin1");

  const indexOfSeq = (needle: number[], from: number): number => {
    outer: for (let i = from; i <= buf.length - needle.length; i++) {
      for (let k = 0; k < needle.length; k++) if (buf[i + k] !== needle[k]) continue outer;
      return i;
    }
    return -1;
  };
  const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

  // 1) collect every block id (OBJ_ID right before BEGOBJECT) + count frames
  const WHAT = ascii("WHAT");
  const BEG = ascii("BEGOBJECT\0");
  const ids = new Set<string>();
  let blockCount = 0;
  let version = "";
  for (let i = indexOfSeq(WHAT, 0); i >= 0; i = indexOfSeq(WHAT, i + 4)) {
    const beg = indexOfSeq(BEG, i);
    if (beg < 0) break;
    // OBJ_ID + [0B 00 00 00] + id(10) + NUL sits immediately before BEGOBJECT
    const id = td.decode(buf.subarray(beg - 11, beg - 1));
    ids.add(id);
    if (!version) version = id.slice(0, 4);
    blockCount++;
  }

  // OB0000 declared count
  const ob = indexOfSeq(ascii(`${version}OB0000`), 0);
  if (ob < 0) {
    errors.push("integrity: OB0000 marker not found");
  } else {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const declared = dv.getInt32(ob + 10, true);
    if (declared !== blockCount) {
      errors.push(
        `integrity: OB0000 declares ${declared} blocks but ${blockCount} are present — the game will refuse to load this map`,
      );
    }
  }

  // 2) dangling internal refs: scan block bodies for [0B 00 00 00] + "<version>….\0"
  const idRe = /^[A-Z]\d{3}[A-Z]{2}[0-9a-fA-F]{4}$/;
  const seen = new Set<string>(); // dedup (ref target + tag context not tracked — id only)
  for (let i = 0; i + 15 <= buf.length; i++) {
    if (buf[i] !== 0x0b || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) continue;
    if (buf[i + 14] !== 0) continue; // trailing NUL of the 10-char id
    const id = td.decode(buf.subarray(i + 4, i + 14));
    if (!id.startsWith(version) || !idRe.test(id)) continue; // globals (G000…) / noise
    if (ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    warnings.push(`integrity: dangling reference ${id} — no such block in this map`);
  }

  return { ok: errors.length === 0, errors, warnings };
}
