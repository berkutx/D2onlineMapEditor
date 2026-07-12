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

import type { MapDocument, MapObject, GarrisonUnit } from "@d2/map-schema";
import {
  landmarkFrame, locationFrame, crystalFrame, siteFrame, itemFrame, unitFrame, stackFrame,
  villageFrame, ruinFrame, bagFrame, mountainsFrame, capitalFrame, rodFrame, tombFrame,
  playerFrame, subraceFrame, scenarioInfoFrame, mapFrame,
  fogFrame, playerSpellsFrame, playerBuildingsFrame, talismanChargesFrame, stackDestroyedFrame,
  questLogFrame, spellCastFrame, spellEffectsFrame, turnSummaryFrame,
  planFrame, mapBlockFrame, roadFrame,
} from "./sgRebuild.js";
import { eventFrame, scenVariablesFrame, stackTemplateFrame, diplomacyFrame } from "./eventFrame.js";
import { splitScenario, rebuildScenario, type ScenarioBlock, type ScenarioBlocks } from "./sgBlocks.js";
import { encodeCp1251 } from "./cp1251.js";

/** The name/desc/author ALSO live in the FILE HEADER at fixed zero-padded offsets (the
 *  D2EESFISIG MapHeaderBlock, before every block frame — desc@43×256, author@299×21, name@321×64).
 *  The game's map-select list reads them from HERE, so an EDITED scenario name/desc/author must be
 *  re-stamped (the ScenarioInfo block alone leaves the header stale). ONLY the actually-edited
 *  fields are patched (mirrors applyBytes): an unedited field keeps its exact original bytes —
 *  including any trailing non-zero padding a zero-fill would clobber — so an unedited map stays
 *  byte-identical. */
export interface HeaderTextEdit { name?: string; description?: string; author?: string }
function patchHeaderText(header: Uint8Array, t: HeaderTextEdit): Uint8Array {
  if (t.name === undefined && t.description === undefined && t.author === undefined) return header;
  const out = header.slice();
  const put = (at: number, len: number, val: string | undefined): void => {
    if (val === undefined || out.length < at + len) return;
    const enc = encodeCp1251(val);
    out.fill(0, at, at + len);
    out.set(enc.subarray(0, len), at);
  };
  put(43, 256, t.description);
  put(299, 21, t.author);
  put(321, 64, t.name);
  return out;
}

/** The numeric `second` (uid) a frame-writer needs = the 4-hex tail of the compound id. */
function secondOf(id: string): number {
  const m = /([0-9a-fA-F]{4})$/.exec(id);
  return m ? parseInt(m[1]!, 16) : 0;
}

const NIL = "G000000000";

/** Derive the on-disk UNIT_/POS_ arrays from garrison members' entity identity (key+slot).
 *  Returns null when any member lacks its identity (a placed/edited garrison — the rebuild
 *  cannot mint ids; the prod export path, applyBytes, does). MEASURED safe: 0 orphan slots /
 *  0 double refs on 13116 shipped garrisons, so members reproduce the packing exactly. */
function slotsFromGarrison(
  garrison: readonly (GarrisonUnit | null)[] | undefined,
): { unitSlots: (string | null)[]; posOfCell: number[] } | null {
  const unitSlots: (string | null)[] = [null, null, null, null, null, null];
  const posOfCell = [-1, -1, -1, -1, -1, -1];
  for (let i = 0; i < 6; i++) {
    const m = garrison?.[i];
    if (!m) continue;
    if (m.key == null || m.slot == null || m.slot < 0 || m.slot > 5) return null;
    unitSlots[m.slot] = m.key;
    posOfCell[i] = m.slot;
  }
  return { unitSlots, posOfCell };
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
      // UNIT_/POS_/LEADER_ID/ITEM_ID are DERIVED from the entities themselves: garrison members
      // carry key+slot, the leader is the leaderCell member's key, item lists carry their keys.
      const slots = slotsFromGarrison(obj.garrison);
      if (!slots) return null; // placed/edited garrison (no keys) — applyBytes mints, not us
      // same for a placed/edited INVENTORY: template inventory but no minted instance keys.
      if ((obj.inventory?.length ?? 0) > 0 && (obj.inventoryKeys?.length ?? 0) === 0) return null;
      const leaderId = obj.leaderCell != null ? obj.garrison?.[obj.leaderCell]?.key : undefined;
      return stackFrame(version, secondOf(obj.id), {
        owner: obj.owner ?? NIL,
        inside: obj.inside ?? NIL,
        subRace: obj.subRace,
        posX: obj.pos.x,
        posY: obj.pos.y,
        unitSlots: slots.unitSlots,
        posOfCell: slots.posOfCell,
        leaderId,
        itemIds: obj.inventoryKeys ?? [],
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
    case "MidSiteMercs":
    case "MidSiteResourceMarket": {
      if (obj.type !== "merchant" && obj.type !== "mage" && obj.type !== "trainer" && obj.type !== "mercenary" && obj.type !== "resourceMarket")
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
        ...(obj.type === "resourceMarket" ? { custom: obj.custom, code: obj.code, bank: obj.bank, inf: obj.inf } : {}),
      });
    }
    case "MidVillage": {
      if (obj.type !== "village") return null;
      // garrison slots derived from the members (key+slot); captured-loot ITEM_ID = itemKeys.
      // RIOT_T/PROTECT_B/P_O_* are invariant on shipped maps (villageFrame's constants).
      const slots = slotsFromGarrison(obj.garrison);
      if (!slots) return null;
      // placed/edited captured-loot list without minted instance keys → skeleton fallback
      if ((obj.items?.length ?? 0) > 0 && (obj.itemKeys?.length ?? 0) === 0) return null;
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
        unitSlots: slots.unitSlots,
        posOfCell: slots.posOfCell,
        itemIds: obj.itemKeys ?? [],
      });
    }
    case "MidRuin": {
      if (obj.type !== "ruin") return null;
      const slots = slotsFromGarrison(obj.garrison);
      if (!slots) return null;
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
        unitSlots: slots.unitSlots,
        posOfCell: slots.posOfCell,
      });
    }
    case "MidBag": {
      if (obj.type !== "treasure") return null;
      // A freshly-PLACED chest carries template `items` but no `itemKeys` (instance ids are
      // minted by the byte writer, not applyOp) — like the garrison guard above, fall back to
      // the skeleton's own block rather than emit an empty ITEM_ID list.
      if ((obj.items?.length ?? 0) > 0 && (obj.itemKeys?.length ?? 0) === 0) return null;
      return bagFrame(version, secondOf(obj.id), {
        posX: obj.pos.x,
        posY: obj.pos.y,
        image: obj.image ?? 0,
        priority: obj.priority,
        itemIds: obj.itemKeys ?? [],
      });
    }
    case "Capital": {
      if (obj.type !== "capital") return null;
      const slots = slotsFromGarrison(obj.garrison);
      if (!slots) return null;
      return capitalFrame(version, secondOf(obj.id), {
        posX: obj.pos.x,
        posY: obj.pos.y,
        name: obj.name,
        desc: obj.desc,
        owner: obj.owner,
        subRace: obj.subRace,
        stackRef: obj.stackRef,
        priority: obj.priority,
        unitSlots: slots.unitSlots,
        posOfCell: slots.posOfCell,
        itemIds: obj.itemKeys ?? [],
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
 * Serialize an INSTANCE block (MidItem / MidUnit) from the entity graph, or null to keep it raw.
 * These aren't placed objects — the entities live ON their owners (garrison members with key+slot,
 * item lists with itemKeys); the indexes map block id → owning entity. Stray blocks (referenced by
 * nothing) come from doc.strayInstances. A unit flagged `transformed` (a polymorph carrying a
 * nested block we don't model) stays raw.
 */
function serializeInstanceBlock(
  typeName: string,
  id: string,
  itemsByKey: ReadonlyMap<string, string>,
  unitsByKey: ReadonlyMap<string, GarrisonUnit>,
  version: string,
): Uint8Array | null {
  switch (typeName) {
    case "MidItem": {
      const template = itemsByKey.get(id);
      return template ? itemFrame(version, secondOf(id), template) : null;
    }
    case "MidUnit": {
      const m = unitsByKey.get(id);
      if (!m || m.transformed) return null; // transformed → un-modeled nested block → keep raw
      // `unit` == key means the record had no TYPE (see the assemble enrichment) → the nil ref.
      const impl = m.unit === id ? NIL : m.unit;
      return unitFrame(version, secondOf(id), impl, m.level ?? 1, m.hp ?? 0, m.xp ?? 0, {
        modifiers: m.modifiers,
        creation: m.creation,
        name: m.name,
      });
    }
    default:
      return null;
  }
}

/** Build the block-id → entity indexes by walking the whole object graph once: every garrison
 *  member with a key, every item list zipped with its keys, plus the stray instance blocks. */
function buildEntityIndexes(doc: MapDocument): {
  itemsByKey: Map<string, string>;
  unitsByKey: Map<string, GarrisonUnit>;
} {
  const itemsByKey = new Map<string, string>();
  const unitsByKey = new Map<string, GarrisonUnit>();
  const takeGarrison = (g: readonly (GarrisonUnit | null)[] | undefined): void => {
    for (const m of g ?? []) if (m?.key) unitsByKey.set(m.key, m);
  };
  const takeItems = (keys: readonly string[] | undefined, templates: readonly string[] | undefined): void => {
    if (!keys) return;
    // keys carry the exact on-disk list; templates are the resolved view. MEASURED index-aligned
    // (0 sentinels in 8127 shipped lists); a sentinel key has no block, so skipping is safe.
    let t = 0;
    for (const k of keys) {
      if (!k || k === NIL || k === "000000") continue;
      const template = templates?.[t++];
      // record EVERY non-sentinel key — even if its template didn't resolve — so an owner that still
      // references it never has its MidItem block dropped (isDead keys off this map). An unresolved
      // template serialises to null → the block is kept RAW (its original bytes), not lost.
      itemsByKey.set(k, template ?? "");
    }
  };
  for (const o of doc.objects) {
    if (o.type === "stack") {
      takeGarrison(o.garrison);
      takeItems(o.inventoryKeys, o.inventory);
    } else if (o.type === "village" || o.type === "capital") {
      takeGarrison(o.garrison);
      takeItems(o.itemKeys, o.items);
    } else if (o.type === "ruin") {
      takeGarrison(o.garrison);
    } else if (o.type === "treasure") {
      takeItems(o.itemKeys, o.items);
    }
  }
  for (const it of doc.strayInstances?.items ?? []) itemsByKey.set(it.id, it.itemType);
  for (const u of doc.strayInstances?.units ?? []) {
    if (unitsByKey.has(u.id)) continue;
    unitsByKey.set(u.id, {
      unit: u.implId ?? u.id, // == id → serialized as the nil ref (no TYPE), like the enrichment
      level: u.level ?? 1,
      hp: u.hp ?? 0,
      ...(u.xp ? { xp: u.xp } : {}),
      ...(u.creation ? { creation: u.creation } : {}),
      ...(u.name ? { name: u.name } : {}),
      ...(u.modifiers?.length ? { modifiers: u.modifiers } : {}),
      ...(u.transformed ? { transformed: true } : {}),
      key: u.id,
    });
  }
  return { itemsByKey, unitsByKey };
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
  const { itemsByKey, unitsByKey } = buildEntityIndexes(doc);
  const version = doc.header.version || "S143";
  const blocks: ScenarioBlock[] = s.blocks.map((b) => {
    if (!types.has(b.typeName)) return b;
    // Instance blocks (MidItem/MidUnit) come from the entity graph, not doc.objects directly.
    if (b.typeName === "MidItem" || b.typeName === "MidUnit") {
      const frame = b.id ? serializeInstanceBlock(b.typeName, b.id, itemsByKey, unitsByKey, version) : null;
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
    // Terrain chunks: origin from the uid (second = rowOrigin<<8 | colOrigin), 32 raw cell values.
    if (b.typeName === "MidgardMapBlock") {
      const s = secondOf(b.id);
      const bx = s & 0xff;
      const by = (s >> 8) & 0xff;
      const values: number[] = [];
      for (let i = 0; i < 32; i++) {
        const x = bx + (i % 8);
        const y = by + Math.floor(i / 8);
        values.push(doc.terrain.cells[y * doc.size + x]?.value ?? 0);
      }
      return { ...b, bytes: mapBlockFrame(version, s, values) };
    }
    if (b.typeName === "MidRoad") {
      const r = (doc.roads ?? []).find((x) => x.id === b.id);
      return r ? { ...b, bytes: roadFrame(version, secondOf(b.id), r.x, r.y, r.index, r.variant) } : b;
    }
    if (b.typeName === "MidgardPlan" && doc.plan && doc.plan.id === b.id)
      return { ...b, bytes: planFrame(version, secondOf(b.id), doc.plan.size, doc.plan.entries) };
    if (b.typeName === "MidEvent") {
      const ev = (doc.events ?? []).find((x) => x.id === b.id);
      return ev ? { ...b, bytes: eventFrame(version, ev) } : b;
    }
    if (b.typeName === "MidScenVariables")
      return { ...b, bytes: scenVariablesFrame(version, b.id, doc.variables ?? []) };
    if (b.typeName === "MidStackTemplate") {
      const t = (doc.templates ?? []).find((x) => x.id === b.id);
      return t ? { ...b, bytes: stackTemplateFrame(version, t) } : b;
    }
    if (b.typeName === "MidDiplomacy")
      return { ...b, bytes: diplomacyFrame(version, b.id, doc.diplomacy ?? []) };
    // Satellite blocks (per-player state + playthrough logs), keyed by block id.
    const sat = doc.satellites;
    if (sat) {
      const s = secondOf(b.id);
      switch (b.typeName) {
        case "MidgardMapFog": {
          const r = sat.fogs.find((x) => x.id === b.id);
          return r ? { ...b, bytes: fogFrame(version, s, r.rows) } : b;
        }
        case "PlayerKnownSpells": {
          const r = sat.playerSpells.find((x) => x.id === b.id);
          return r ? { ...b, bytes: playerSpellsFrame(version, s, r.spells) } : b;
        }
        case "PlayerBuildings": {
          const r = sat.playerBuildings.find((x) => x.id === b.id);
          return r ? { ...b, bytes: playerBuildingsFrame(version, s, r.buildings) } : b;
        }
        case "MidTalismanCharges": {
          const r = sat.talismanCharges.find((x) => x.id === b.id);
          return r ? { ...b, bytes: talismanChargesFrame(version, s, r.entries) } : b;
        }
        case "MidStackDestroyed": {
          const r = sat.stackDestroyed.find((x) => x.id === b.id);
          return r ? { ...b, bytes: stackDestroyedFrame(version, s, r.entries) } : b;
        }
        case "MidQuestLog": {
          const r = sat.questLogs.find((x) => x.id === b.id);
          return r ? { ...b, bytes: questLogFrame(version, s, r.entries) } : b;
        }
        case "MidSpellCast": {
          const r = sat.spellCasts.find((x) => x.id === b.id);
          return r ? { ...b, bytes: spellCastFrame(version, s, r.v1, r.v2) } : b;
        }
        case "MidSpellEffects": {
          const r = sat.spellEffects.find((x) => x.id === b.id);
          return r ? { ...b, bytes: spellEffectsFrame(version, s, r.v) } : b;
        }
        case "TurnSummary": {
          const r = sat.turnSummaries.find((x) => x.id === b.id);
          return r ? { ...b, bytes: turnSummaryFrame(version, s, r.entries) } : b;
        }
      }
    }
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
  "MidSiteResourceMarket",
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
  "MidgardMapFog",
  "PlayerKnownSpells",
  "PlayerBuildings",
  "MidTalismanCharges",
  "MidStackDestroyed",
  "MidQuestLog",
  "MidSpellCast",
  "MidSpellEffects",
  "TurnSummary",
  "MidgardMapBlock",
  "MidRoad",
  "MidgardPlan",
  "MidEvent",
  "MidScenVariables",
  "MidStackTemplate",
  "MidDiplomacy",
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

/** MapObject.type → its block decl TypeName (the inverse of the parser's dispatch). */
function objTypeName(o: MapObject): string {
  switch (o.type) {
    case "stack": return "MidStack";
    case "village": return "MidVillage";
    case "capital": return "Capital";
    case "ruin": return "MidRuin";
    case "treasure": return "MidBag";
    case "merchant": return "MidSiteMerchant";
    case "mage": return "MidSiteMage";
    case "trainer": return "MidSiteTrainer";
    case "mercenary": return "MidSiteMercs";
    case "resourceMarket": return "MidSiteResourceMarket";
    case "landmark": return "MidLandmark";
    case "location": return "MidLocation";
    case "crystal": return "MidCrystal";
    case "rod": return "MidRod";
    case "tomb": return "MidTomb";
    case "mountains": return "MidMountains";
    case "generic": return o.blockType;
    default: return "";
  }
}

/**
 * FULL from-model export container. Unlike rebuildBytes (payload-swap over a byte skeleton — which
 * for an EDITED map must be fed the byte-patch output), this drives the block SET from the MODEL:
 *   - payload-swap every base block whose entity is still live (via rebuildFromModel);
 *   - DROP base blocks whose entity is gone (deleted object / cascaded instance / washed road /
 *     deleted event or template / emptied mountains block);
 *   - APPEND a synthesized frame for every model entity with no base block (added objects + their
 *     minted MidItem/MidUnit instances, new MidRoad, new events/templates).
 * `doc` MUST be materializeForExport'd (all instance keys minted, plan/roads/charges derived) — every
 * live block then serialises from the model with NO raw fallback. `s` supplies only the header +
 * original block order (unchanged blocks stay in place; new ones append). NO byte patch anywhere.
 */
export function serializeMapFromModel(
  s: ScenarioBlocks,
  doc: MapDocument,
  headerText: HeaderTextEdit = {},
): ScenarioBlocks {
  const version = doc.header.version || "S143";
  const byId = new Map<string, MapObject>(doc.objects.map((o) => [o.id, o]));
  const { itemsByKey, unitsByKey } = buildEntityIndexes(doc);
  const roadById = new Map((doc.roads ?? []).map((r) => [r.id, r] as const));
  const eventIds = new Set((doc.events ?? []).map((e) => e.id));
  const templateIds = new Set((doc.templates ?? []).map((t) => t.id));

  // A base block whose model entity no longer exists → drop it from the output.
  // MidMountains is NOT droppable: it is a singleton-ish block (one per map, N children, legally
  // EMPTY on some maps) — rebuildFromModel rebuilds its payload from the children and keeps it raw
  // when empty, so it is never removed (deleteMountainOps rebuilds the block, never deletes it).
  const isDead = (b: ScenarioBlock): boolean => {
    if (!b.id) return false;
    switch (b.typeName) {
      case "MidItem": return !itemsByKey.has(b.id);
      case "MidUnit": return !unitsByKey.has(b.id);
      case "MidRoad": return !roadById.has(b.id);
      case "MidEvent": return !eventIds.has(b.id);
      case "MidStackTemplate": return !templateIds.has(b.id);
      default:
        // object blocks (the discriminated placed types) are dead when the object is gone.
        return REBUILD_OBJECT_TYPES.has(b.typeName) && !byId.has(b.id);
    }
  };

  const swapped = rebuildFromModel(s, doc, REBUILD_TYPES).blocks.filter((b) => !isDead(b));

  const baseIds = new Set(s.blocks.map((b) => b.id).filter(Boolean));
  const add: ScenarioBlock[] = [];
  const emit = (typeName: string, id: string, bytes: Uint8Array | null): void => {
    if (!bytes) throw new Error(`serializeMapFromModel: cannot serialise new ${typeName} ${id} from the model`);
    add.push({ typeName, id, bytes });
  };
  // new placed objects (mountains handled separately — they live N-per-block)
  for (const o of doc.objects) {
    if (o.type === "mountains" || baseIds.has(o.id)) continue;
    const tn = objTypeName(o);
    emit(tn, o.id, serializeTypedBlock(tn, o, version));
  }
  // a MidMountains block minted THIS session (the map had none, or a new block id): its children
  // are `${blockId}#n`; gather each new block id and synthesise it (existing blocks are swapped
  // in place above by rebuildFromModel).
  const newMountainBlocks = new Set<string>();
  for (const o of doc.objects) {
    if (o.type !== "mountains") continue;
    const blockId = o.id.slice(0, o.id.indexOf("#"));
    if (blockId && !baseIds.has(blockId)) newMountainBlocks.add(blockId);
  }
  for (const blockId of newMountainBlocks) emit("MidMountains", blockId, serializeMountainsBlock(blockId, doc, version));
  // new instance blocks (minted for added/edited item lists + garrisons)
  for (const [key] of itemsByKey) if (!baseIds.has(key)) emit("MidItem", key, serializeInstanceBlock("MidItem", key, itemsByKey, unitsByKey, version));
  for (const [key] of unitsByKey) if (!baseIds.has(key)) emit("MidUnit", key, serializeInstanceBlock("MidUnit", key, itemsByKey, unitsByKey, version));
  // new roads
  for (const r of doc.roads ?? []) if (!baseIds.has(r.id)) emit("MidRoad", r.id, roadFrame(version, secondOf(r.id), r.x, r.y, r.index, r.variant));
  // new events / templates
  for (const e of doc.events ?? []) if (!baseIds.has(e.id)) emit("MidEvent", e.id, eventFrame(version, e));
  for (const t of doc.templates ?? []) if (!baseIds.has(t.id)) emit("MidStackTemplate", t.id, stackTemplateFrame(version, t));
  // a MidTalismanCharges block MINTED this session (a talisman placed on a map that had no charges
  // block) — materializeForExport creates it in doc.satellites; without this it is silently dropped.
  for (const tc of doc.satellites?.talismanCharges ?? [])
    if (!baseIds.has(tc.id)) emit("MidTalismanCharges", tc.id, talismanChargesFrame(version, secondOf(tc.id), tc.entries));

  return { ...s, header: patchHeaderText(s.header, headerText), blocks: [...swapped, ...add] };
}

/** Export the whole `.sg` from a materialized model — no byte patch, no skeleton fallback.
 *  `originalBytes` supplies only the header + block order of the unchanged blocks. `headerText`
 *  names the scenario name/desc/author fields an edit changed (so the FILE HEADER is re-stamped;
 *  unedited fields keep their exact original bytes). */
export function serializeMapFromModelBytes(
  originalBytes: Uint8Array,
  doc: MapDocument,
  headerText: HeaderTextEdit = {},
): Uint8Array {
  return rebuildScenario(serializeMapFromModel(splitScenario(originalBytes), doc, headerText));
}

/** The placed-object block TypeNames (dead when their MapObject is deleted). */
const REBUILD_OBJECT_TYPES: ReadonlySet<string> = new Set([
  "MidStack", "MidVillage", "Capital", "MidRuin", "MidBag",
  "MidSiteMerchant", "MidSiteMage", "MidSiteTrainer", "MidSiteMercs", "MidSiteResourceMarket",
  "MidLandmark", "MidLocation", "MidCrystal", "MidRod", "MidTomb",
]);
