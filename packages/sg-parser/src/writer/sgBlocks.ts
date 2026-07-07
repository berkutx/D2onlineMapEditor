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
  blocks: ScenarioBlock[];
  /** Any bytes after the last block's ENDOBJECT terminator (usually empty). */
  trailer: Uint8Array;
}

/** Offset just AFTER a block's `ENDOBJECT\0` terminator (fieldsEnd points AT `ENDOBJECT`). */
function terminatorEnd(bytes: Uint8Array, fieldsEnd: number): number {
  let e = fieldsEnd + END.length;
  if (bytes[e] === 0) e += 1; // the NUL after ENDOBJECT
  return e;
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
  for (const f of framed) {
    const end = terminatorEnd(input, f.fieldsEnd);
    blocks.push({ typeName: f.typeName, id: f.id, bytes: input.slice(start, end) });
    start = end;
  }
  return {
    header: input.slice(0, headerEnd),
    blocks,
    trailer: input.slice(start), // bytes after the last terminator (normally none)
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
