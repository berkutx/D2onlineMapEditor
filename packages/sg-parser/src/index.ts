/**
 * @d2/sg-parser — a TypeScript port of toolsqt's D2MapModel/DataBlock reader.
 *
 * `parseScenario(buf)` decodes a binary Disciples 2 `.sg` scenario into a
 * `MapDocument` (Contract A). `parseHeaderOnly(buf)` returns just the map header
 * + players + size without building the terrain grid or object list.
 *
 * Stage-1 scope: terrain grid + roads + the Stage-1 object types; any unmodeled
 * block degrades to a GenericObject.
 */

import { SCHEMA_VERSION, MapDocument, type MapHeader, type PlayerInfo } from "@d2/map-schema";
import { ByteBuffer } from "./bytebuffer.js";
import { assembleDocument, assembleHeader, type ParsedHeader } from "./assemble.js";

export const SG_PARSER_VERSION = "0.1.0" as const;

const MAGIC = "D2EESFISIG";

function toByteBuffer(buf: Uint8Array): ByteBuffer {
  const bb = new ByteBuffer(buf);
  const magic = bb.asciiSlice(0, MAGIC.length);
  if (magic !== MAGIC) {
    throw new Error(`sg-parser: bad magic ${JSON.stringify(magic)} (expected ${MAGIC})`);
  }
  return bb;
}

/** Parse a full `.sg` scenario into a render-ready `MapDocument`. */
export function parseScenario(buf: Uint8Array): MapDocument {
  const bb = toByteBuffer(buf);
  return assembleDocument(bb, SCHEMA_VERSION, SG_PARSER_VERSION);
}

/** Parse only the scenario header (name/size/difficulty) and player list. */
export function parseHeaderOnly(buf: Uint8Array): {
  size: number;
  header: MapHeader;
  players: PlayerInfo[];
} {
  const bb = toByteBuffer(buf);
  const h: ParsedHeader = assembleHeader(bb);
  return h;
}

export { MapDocument };
export { ByteBuffer } from "./bytebuffer.js";
export * from "./framing.js";
