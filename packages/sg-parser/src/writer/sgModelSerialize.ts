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

import type { MapDocument, MapObject, ItemInstance, UnitInstance } from "@d2/map-schema";
import {
  landmarkFrame, locationFrame, crystalFrame, siteFrame, itemFrame, unitFrame, stackFrame,
  villageFrame, ruinFrame, bagFrame, mountainsFrame, capitalFrame, rodFrame, tombFrame,
  playerFrame, subraceFrame, scenarioInfoFrame, mapFrame,
} from "./sgRebuild.js";
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
    case "MidStack": {
      if (obj.type !== "stack") return null;
      // The instance-graph refs (UNIT_/POS_/LEADER_ID/ITEM_ID) come from the load-only `raw`
      // snapshot; the scalars from the object (defaults reproduce a fresh stack).
      return stackFrame(version, secondOf(obj.id), {
        owner: obj.owner ?? "G000000000",
        inside: obj.inside ?? "G000000000",
        subRace: obj.subRace,
        posX: obj.pos.x,
        posY: obj.pos.y,
        unitSlots: obj.raw?.unitSlots,
        posOfCell: obj.raw?.posOfCell,
        leaderId: obj.raw?.leaderId,
        itemIds: obj.raw?.itemIds,
        morale: obj.morale,
        move: obj.move,
        facing: obj.facing,
        banner: obj.banner,
        equip: obj.equip,
        order: obj.order,
        priority: obj.priority,
        creatLvl: obj.creatLvl,
        srcTemplate: obj.srcTemplate,
        leaderAlive: obj.leaderAlive,
        invisible: obj.invisible,
        aiIgnore: obj.aiIgnore,
        upgCount: obj.upgCount,
        orderTarget: obj.orderTarget,
        aiOrder: obj.aiOrder,
        aiOrderTarget: obj.aiOrderTarget,
        nbBattle: obj.nbBattle,
      });
    }
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
    case "MidVillage": {
      if (obj.type !== "village") return null;
      // garrison slots + captured-loot ITEM_ID from the load-only `raw` snapshot; RIOT_T/PROTECT_B/
      // P_O_* are invariant on shipped maps (villageFrame's hardcoded constants reproduce them).
      return villageFrame(version, secondOf(obj.id), {
        posX: obj.pos.x,
        posY: obj.pos.y,
        name: obj.name,
        desc: obj.desc,
        owner: obj.owner,
        subRace: obj.subRace,
        stackRef: obj.stackRef,
        tier: obj.tier,
        priority: obj.priority,
        regen: obj.regen,
        morale: obj.morale,
        growth: obj.growth,
        unitSlots: obj.raw?.unitSlots,
        posOfCell: obj.raw?.posOfCell,
        itemIds: obj.raw?.itemIds,
      });
    }
    case "MidRuin": {
      if (obj.type !== "ruin") return null;
      return ruinFrame(version, secondOf(obj.id), {
        posX: obj.pos.x,
        posY: obj.pos.y,
        name: obj.name,
        desc: obj.desc,
        image: obj.image,
        reward: obj.reward,
        item: obj.item,
        looter: obj.looter,
        priority: obj.priority,
        unitSlots: obj.raw?.unitSlots,
        posOfCell: obj.raw?.posOfCell,
      });
    }
    case "MidBag": {
      if (obj.type !== "treasure") return null;
      return bagFrame(version, secondOf(obj.id), {
        posX: obj.pos.x,
        posY: obj.pos.y,
        image: obj.image ?? 0,
        priority: obj.priority,
        itemIds: obj.raw?.itemIds,
      });
    }
    case "Capital": {
      if (obj.type !== "capital") return null;
      return capitalFrame(version, secondOf(obj.id), {
        posX: obj.pos.x,
        posY: obj.pos.y,
        name: obj.name,
        desc: obj.desc,
        owner: obj.owner,
        subRace: obj.subRace,
        stackRef: obj.stackRef,
        priority: obj.priority,
        unitSlots: obj.raw?.unitSlots,
        posOfCell: obj.raw?.posOfCell,
        itemIds: obj.raw?.itemIds,
      });
    }
    case "MidRod":
      if (obj.type !== "rod") return null;
      return rodFrame(version, secondOf(obj.id), obj.pos.x, obj.pos.y, obj.owner);
    case "MidTomb":
      if (obj.type !== "tomb") return null;
      return tombFrame(version, secondOf(obj.id), obj.pos.x, obj.pos.y, obj.epitaphs ?? []);
    default:
      return null;
  }
}

/**
 * Serialize an INSTANCE block (MidItem / MidUnit) from the doc's instance graph, or null to keep it
 * raw. These aren't placed objects — they live inside stacks/forts/chests and are looked up by the
 * block's own id. A unit flagged `transformed` (a polymorph carrying a nested block we don't model)
 * stays raw.
 */
function serializeInstanceBlock(
  typeName: string,
  id: string,
  items: ReadonlyMap<string, ItemInstance>,
  units: ReadonlyMap<string, UnitInstance>,
  version: string,
): Uint8Array | null {
  switch (typeName) {
    case "MidItem": {
      const it = items.get(id);
      return it ? itemFrame(version, secondOf(id), it.itemType) : null;
    }
    case "MidUnit": {
      const u = units.get(id);
      if (!u || u.transformed) return null; // transformed → un-modeled nested block → keep raw
      return unitFrame(version, secondOf(id), u.implId ?? "G000000000", u.level ?? 1, u.hp ?? 0, u.xp ?? 0, {
        modifiers: u.modifiers,
        creation: u.creation,
        name: u.name,
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
  const items = new Map<string, ItemInstance>((doc.instances?.items ?? []).map((i) => [i.id, i]));
  const units = new Map<string, UnitInstance>((doc.instances?.units ?? []).map((u) => [u.id, u]));
  const version = doc.header.version || "S143";
  const blocks: ScenarioBlock[] = s.blocks.map((b) => {
    if (!types.has(b.typeName)) return b;
    // Instance blocks (MidItem/MidUnit) come from the instance graph, not doc.objects.
    if (b.typeName === "MidItem" || b.typeName === "MidUnit") {
      const frame = b.id ? serializeInstanceBlock(b.typeName, b.id, items, units, version) : null;
      return frame ? { ...b, bytes: frame } : b;
    }
    // ONE MidMountains block holds N mountains — read as `${blockId}#n` children. Gather them all
    // back into a single block (no 1:1 object for the block id).
    if (b.typeName === "MidMountains") {
      const frame = b.id ? serializeMountainsBlock(b.id, doc, version) : null;
      return frame ? { ...b, bytes: frame } : b;
    }
    // Non-object doc-level records: players + the subrace table (keyed by block id).
    if (b.typeName === "MidPlayer") {
      const p = doc.players.find((x) => x.id === b.id);
      return p ? { ...b, bytes: playerFrame(version, secondOf(b.id), p) } : b;
    }
    if (b.typeName === "MidSubRace") {
      const sr = (doc.subraces ?? []).find((x) => x.id === b.id);
      return sr ? { ...b, bytes: subraceFrame(version, secondOf(b.id), sr) } : b;
    }
    // Singletons from the header.
    if (b.typeName === "ScenarioInfo")
      return { ...b, bytes: scenarioInfoFrame(version, secondOf(b.id), doc.header, doc.size) };
    if (b.typeName === "MidgardMap")
      return { ...b, bytes: mapFrame(version, secondOf(b.id), doc.size) };
    const obj = b.id ? byId.get(b.id) : undefined;
    if (!obj) return b;
    const frame = serializeTypedBlock(b.typeName, obj, version);
    return frame ? { ...b, bytes: frame } : b;
  });
  return { ...s, blocks };
}

/**
 * Gather every `${blockId}#n` mountains child (in index order) back into ONE MidMountains block.
 * Returns null if the block has no children in the model (keep it raw).
 */
function serializeMountainsBlock(blockId: string, doc: MapDocument, version: string): Uint8Array | null {
  const prefix = `${blockId}#`;
  const children = doc.objects
    .filter((o): o is Extract<MapObject, { type: "mountains" }> => o.type === "mountains" && o.id.startsWith(prefix))
    .sort((a, b) => parseInt(a.id.slice(prefix.length), 10) - parseInt(b.id.slice(prefix.length), 10));
  if (!children.length) return null;
  return mountainsFrame(
    version,
    secondOf(blockId),
    children.map((m) => ({
      x: m.pos.x,
      y: m.pos.y,
      w: m.w ?? 0,
      h: m.h ?? 0,
      image: m.image ?? 0,
      race: m.race ?? 0,
      idMount: m.idMount,
    })),
  );
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
  "MidItem",
  "MidUnit",
  "MidStack",
  "MidVillage",
  "MidRuin",
  "MidBag",
  "MidMountains",
  "Capital",
  "MidRod",
  "MidTomb",
  "MidPlayer",
  "MidSubRace",
  "ScenarioInfo",
  "MidgardMap",
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
