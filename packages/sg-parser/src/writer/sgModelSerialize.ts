/**
 * EXPERIMENT STEP 3 (branch experiment/full-rebuild) — serialize a modeled block FROM THE MODEL,
 * mirroring the reference's typed `IDataBlock::data()` (vs `TagDataBlock`'s raw pass-through). For
 * a block type we handle, re-emit its frame via the existing frame-writers using the parsed object;
 * every other type stays raw (Tag). This is the incremental swap toward a full model rebuild.
 *
 * CAVEAT (measured, not assumed): a model-serialized frame equals the original ONLY where the model
 * captures every persisted field. E.g. `LandmarkObject` keeps `baseType` + pos but NOT `DESC_TXT`,
 * so a landmark with a non-empty description won't reproduce byte-for-byte (its desc is defaulted
 * to ""). The block round-trip test reports the exact byte-diff, making the model gap concrete.
 */

import type { MapDocument, MapObject } from "@d2/map-schema";
import { landmarkFrame, locationFrame } from "./sgRebuild.js";
import type { ScenarioBlock, ScenarioBlocks } from "./sgBlocks.js";

/** The numeric `second` (uid) a frame-writer needs = the 4-hex tail of the compound id. */
function secondOf(id: string): number {
  const m = /([0-9a-fA-F]{4})$/.exec(id);
  return m ? parseInt(m[1]!, 16) : 0;
}

/**
 * Serialize a block frame from the parsed object, or null if this type is not handled yet (keep it
 * raw). Handled so far: MidLandmark, MidLocation — the simplest fixed-shape frames. Others are the
 * next STEP-3 increments (each gold-checked before enabling).
 */
export function serializeTypedBlock(
  typeName: string,
  obj: MapObject,
  version: string,
): Uint8Array | null {
  switch (typeName) {
    case "MidLandmark":
      if (obj.type !== "landmark") return null;
      return landmarkFrame(version, secondOf(obj.id), obj.pos.x, obj.pos.y, obj.baseType ?? "", "");
    case "MidLocation":
      if (obj.type !== "location") return null;
      return locationFrame(version, secondOf(obj.id), obj.pos.x, obj.pos.y, obj.name ?? "", obj.radius ?? 0);
    default:
      return null;
  }
}

/**
 * Re-serialize every block whose decl type is in `types` from the matching parsed object; all other
 * blocks stay raw. Returns a new ScenarioBlocks (feed to `rebuildScenario`). A block whose object
 * or serializer is missing is left raw (safe fallback).
 */
export function rebuildFromModel(
  s: ScenarioBlocks,
  doc: MapDocument,
  types: ReadonlySet<string>,
): ScenarioBlocks {
  const byId = new Map<string, MapObject>(doc.objects.map((o) => [o.id, o]));
  const version = doc.header.version || "S143";
  const blocks: ScenarioBlock[] = s.blocks.map((b) => {
    if (!types.has(b.typeName)) return b;
    const obj = b.id ? byId.get(b.id) : undefined;
    if (!obj) return b;
    const frame = serializeTypedBlock(b.typeName, obj, version);
    return frame ? { ...b, bytes: frame } : b;
  });
  return { ...s, blocks };
}
