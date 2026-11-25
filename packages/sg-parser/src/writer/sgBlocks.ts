/**
 * EXPERIMENT (branch experiment/full-rebuild) — a BLOCK-LIST model of the `.sg`, mirroring the
 * reference toolsqt `D2MapModel`: `save()` there is `header.data(count) + Σ block->data(header)`,
 * where each `IDataBlock` is either a typed block (serialized from fields) or a `TagDataBlock`
 * (raw preserved bytes re-emitted verbatim). Unmodeled blocks stay raw → lossless.
 *
 * This is the SPINE of a full rebuild: split a scenario into its ordered block frames + a header
 * prefix, and re-join them. STEP 1 keeps every block as raw bytes → `join(split(x)) === x`
 * byte-for-byte. Later steps swap individual raw blocks for model-serialized frames (one type at
 * a time, gold-checked) — exactly the reference's typed-vs-Tag split, but incremental.
 *
 * Contrast with the patch-in-place writer (sgRaw/applyBytes): that splices edits into the
 * ORIGINAL bytes (byte-identical on a no-op). This block model instead REBUILDS the byte stream
 * from an ordered list — the prerequisite for "export the whole file from the JSON state".
 */

import { ByteBuffer } from "../bytebuffer.js";
import { iterateObjects } from "../framing.js";

const WHAT = "WHAT";
const END = "ENDOBJECT";
const MAGIC = "D2EESFISIG";

/** One block frame: its full bytes (WHAT…ENDOBJECT\0) plus its decl type + compound id. */
export interface ScenarioBlock {
  /** `.?AVC<TypeName>@@` decl name, e.g. "MidStack", "ScenarioInfo". */
  typeName: string;
  /** OBJ_ID compound uid, e.g. "S143KC0001", or "" if absent. */
  id: string;
  /** The exact frame bytes for this block (a slice of the original — never mutated). */
  bytes: Uint8Array;
}

/** A scenario decomposed into its byte-header prefix + ordered block frames + any trailer. */
export interface ScenarioBlocks {
  /** Everything before the first block frame (magic + version + preamble). */
  header: Uint8Array;
  /** The scenario's OBJECTS — exactly what the header's OB0000 count counts. */
  blocks: ScenarioBlock[];
  /**
   * Any bytes after the last object's ENDOBJECT terminator (usually empty). ATTACHMENTS live
   * here: frames at the end of the file that carry no OBJ_ID (see FramedObject.id) — the map
   * picture a mod's random-scenario generator appends. The game stops reading at the object
   * count, so they are kept byte for byte and never counted.
   */
  trailer: Uint8Array;
}

/** Offset just AFTER a block's `ENDOBJECT\0` terminator (fieldsEnd points AT `ENDOBJECT`). */
function terminatorEnd(bytes: Uint8Array, fieldsEnd: number): number {
  let e = fieldsEnd + END.length;
  if (bytes[e] === 0) e += 1; // the NUL after ENDOBJECT
  return e;
}

/**
 * How many of the leading frames are scenario OBJECTS: all of them, minus the frames at the
 * end that have no OBJ_ID (attachments). A frame without an id BETWEEN objects is not an
 * attachment (the game would choke on it) and stays counted, as does everything in a file
 * where no frame has an id at all.
 */
function objectFrameCount(framed: readonly { id: string }[]): number {
  let n = framed.length;
  while (n > 0 && framed[n - 1]!.id === "") n--;
  return n === 0 ? framed.length : n;
}

/**
 * Offset where the object stream ends: just after the last scenario object's terminator.
 * New blocks are inserted HERE — for an ordinary map that is the end of the file, for a map
 * with attachments it is before them (appended after, the game would never reach the new
 * blocks: it would read an attachment as an object first and refuse the map).
 */
export function objectStreamEnd(input: Uint8Array): number {
  const framed = [...iterateObjects(new ByteBuffer(input))];
  const objects = objectFrameCount(framed);
  if (objects === framed.length) return input.length;
  return terminatorEnd(input, framed[objects - 1]!.fieldsEnd);
}

/**
 * Split a `.sg` into a header prefix + ordered block frames (each raw). The frames are CONTIGUOUS
 * — block i spans from just after block (i-1)'s terminator to the end of block i's terminator — so
 * `join` reproduces the input exactly. The header is everything before the first block's `WHAT`.
 */
export function splitScenario(input: Uint8Array): ScenarioBlocks {
  const buf = new ByteBuffer(input);
  if (buf.asciiSlice(0, MAGIC.length) !== MAGIC) {
    throw new Error(`splitScenario: bad magic (expected ${MAGIC})`);
  }
  const framed = [...iterateObjects(buf)];
  if (framed.length === 0) return { header: input.slice(), blocks: [], trailer: new Uint8Array(0) };

  // block 0's frame starts at its WHAT (the header is everything before it)
  const firstWhat = buf.indexOf(WHAT, 0);
  const headerEnd = firstWhat >= 0 && firstWhat < framed[0]!.fieldsFrom ? firstWhat : 0;

  const blocks: ScenarioBlock[] = [];
  let start = headerEnd;
  // attachments (trailing frames without an OBJ_ID) are not objects: they stay in the trailer
  for (const f of framed.slice(0, objectFrameCount(framed))) {
    const end = terminatorEnd(input, f.fieldsEnd);
    blocks.push({ typeName: f.typeName, id: f.id, bytes: input.slice(start, end) });
    start = end;
  }
  return {
    header: input.slice(0, headerEnd),
    blocks,
    trailer: input.slice(start), // bytes after the last object's terminator (normally none)
  };
}

/** Re-join a header + ordered block frames + trailer into a `.sg` byte stream. */
export function joinScenario(s: ScenarioBlocks): Uint8Array {
  const total = s.header.length + s.blocks.reduce((n, b) => n + b.bytes.length, 0) + s.trailer.length;
  const out = new Uint8Array(total);
  let at = 0;
  out.set(s.header, at); at += s.header.length;
  for (const b of s.blocks) { out.set(b.bytes, at); at += b.bytes.length; }
  out.set(s.trailer, at);
  return out;
}

const OB = "OB0000";

/**
 * STEP 2 — patch the header's `OB0000` block-count int32 to `count` (returns a fresh header). The
 * count lives in the header before the first block frame (`<version>OB0000<int32 LE>`); the game
 * reads exactly that many objects and refuses a map where they are not all there. Mirrors the
 * reference's `header.data(m_blocks.count())`. A header with no OB0000 is returned unchanged.
 */
export function patchBlockCount(header: Uint8Array, count: number): Uint8Array {
  const buf = new ByteBuffer(header);
  const ob = buf.lastIndexOf(OB, header.length);
  if (ob < 0) return header;
  const out = header.slice();
  new DataView(out.buffer, out.byteOffset, out.byteLength).setInt32(ob + OB.length, count, true);
  return out;
}

/**
 * STEP 2 — re-assemble a scenario, re-stamping the header's OB0000 count to match the CURRENT block
 * list. Use this instead of `joinScenario` once blocks are added/removed/replaced (the reference's
 * `save` = `header.data(count) + Σ block.data`). With an unchanged block list it equals `join`.
 */
export function rebuildScenario(s: ScenarioBlocks): Uint8Array {
  return joinScenario({ ...s, header: patchBlockCount(s.header, s.blocks.length) });
}
