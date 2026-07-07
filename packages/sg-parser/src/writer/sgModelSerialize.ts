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
import { landmarkFrame, locationFrame, crystalFrame, siteFrame } from "./sgRebuild.js";
import { splitScenario, rebuildScenario, type ScenarioBlock, type ScenarioBlocks } from "./sgBlocks.js";

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
      // obj.desc is undefined when the source landmark had NO DESC_TXT (RMG) — pass it straight
      // through so landmarkFrame omits the field; "" (present-empty) and names are written.
      return landmarkFrame(version, secondOf(obj.id), obj.pos.x, obj.pos.y, obj.baseType ?? "", obj.desc);
    case "MidLocation":
      if (obj.type !== "location") return null;
      return locationFrame(version, secondOf(obj.id), obj.pos.x, obj.pos.y, obj.name ?? "", obj.radius ?? 0);
    case "MidCrystal":
      if (obj.type !== "crystal") return null;
      return crystalFrame(version, secondOf(obj.id), obj.pos.x, obj.pos.y, obj.resource ?? 0, obj.priority ?? 3);
    // MidSite* — 4 object types share the site blocks; obj.type IS the SiteKind discriminant.
    // Stock lists (items/spells/units) carry GLOBAL template ids, so array order == file order —
    // no instance-ref/ordering loss. IMG_INTF/VISITER/AIPRIORITY/BUY_*/MISSION are invariant on
    // shipped maps and reproduced by siteFrame's hardcoded constants (0-diff verified on Riders).
    case "MidSiteMerchant":
    case "MidSiteMage":
    case "MidSiteTrainer":
    case "MidSiteMercs": {
      if (obj.type !== "merchant" && obj.type !== "mage" && obj.type !== "trainer" && obj.type !== "mercenary")
        return null;
      return siteFrame(version, secondOf(obj.id), obj.type, {
        posX: obj.pos.x,
        posY: obj.pos.y,
        name: obj.name,
        desc: obj.desc,
        image: obj.image,
        aiPriority: obj.aiPriority,
        ...(obj.type === "merchant" ? { items: obj.items, buy: obj.buy, mission: obj.mission } : {}),
        ...(obj.type === "mage" ? { spells: obj.spells } : {}),
        ...(obj.type === "mercenary" ? { units: obj.units } : {}),
      });
    }
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

/**
 * STEP 4 — the block types that reproduce the original frame BYTE-FOR-BYTE from the model (proven
 * by the STEP-3 round-trip: 0 diffs). Only these are model-serialized in a full-rebuild export;
 * every other type stays raw (TagDataBlock). Grows one entry at a time as each type is gold-checked.
 */
export const REBUILD_TYPES: ReadonlySet<string> = new Set([
  "MidLocation",
  "MidLandmark",
  "MidCrystal",
  "MidSiteMerchant",
  "MidSiteMage",
  "MidSiteTrainer",
  "MidSiteMercs",
]);

/**
 * STEP 4 — full-rebuild export: decompose `bytes`, re-serialize the proven block types from `doc`'s
 * model (rest raw), and re-assemble with a re-stamped OB0000 count. `doc` MUST be the parse of the
 * SAME `bytes` (or an edit of it whose object ids/fields align). Since every type in `types` is
 * byte-perfect, the result is byte-identical to the patch-in-place output for those types — this is
 * the safe, incremental rebuild path (it diverges from patch only as more types are added). This is
 * the "export from the JSON state" the reference does, scoped to what our model fully captures.
 */
export function rebuildBytes(
  bytes: Uint8Array,
  doc: MapDocument,
  types: ReadonlySet<string> = REBUILD_TYPES,
): Uint8Array {
  return rebuildScenario(rebuildFromModel(splitScenario(bytes), doc, types));
}
