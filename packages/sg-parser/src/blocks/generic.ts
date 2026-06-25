/**
 * GenericObject fallback for any block type the parser does not yet model.
 * Keeps the map renderable and round-trippable. Captures POS_X/POS_Y when
 * present so unmodeled placed objects still land on the grid.
 */

import { ByteBuffer, readDefaultInt } from "../bytebuffer.js";
import type { FramedObject } from "../framing.js";
import type { MapObject } from "@d2/map-schema";

export function readGeneric(buf: ByteBuffer, obj: FramedObject): MapObject {
  const x = readDefaultInt(buf, "POS_X", obj.fieldsFrom, obj.fieldsEnd) ?? 0;
  const y = readDefaultInt(buf, "POS_Y", obj.fieldsFrom, obj.fieldsEnd) ?? 0;
  return {
    type: "generic",
    id: obj.id,
    pos: { x, y },
    blockType: obj.typeName,
    raw: {},
  };
}
