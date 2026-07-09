/**
 * Assemble a MapDocument (Contract A) from the framed objects of a .sg buffer.
 *
 * Dispatch is keyed on the `.?AVC<TypeName>` decl. Stage-1 modelled types get a
 * concrete reader; anything else degrades to GenericObject. Terrain is unpacked
 * from MidgardMapBlock chunks; MidRoad overlays are applied onto cells.
 */

import { ByteBuffer } from "./bytebuffer.js";
import { iterateObjects, parseCompoundId, type FramedObject } from "./framing.js";
import { buildGrid, type TerrainBlock } from "./grid.js";
import {
  readScenarioInfo,
  readDiplomacy,
  readPlayer,
  readSubRace,
  readMidgardMapSize,
  readMapBlock,
  readRoad,
  readStack,
  readVillage,
  readCapital,
  readRuin,
  readSite,
  readCrystal,
  readLocation,
  readLandmark,
  readUnit,
  readTreasure,
  readRod,
  readTomb,
  readMountains,
  readGeneric,
  type RoadRecord,
} from "./blocks/index.js";
import { readDefaultInt, readDefaultString } from "./bytebuffer.js";
import { readEvent, readScenVariables, readStackTemplate } from "./blocks/events.js";
import {
  readFog, readPlayerSpells, readPlayerBuildings, readTalismanCharges, readStackDestroyed,
  readQuestLog, readSpellCast, readSpellEffects, readTurnSummary, readPlan,
} from "./blocks/satellites.js";
import type {
  MapDocument, MapObject, PlayerInfo, MapHeader, GarrisonUnit, MapEvent, ScenarioVariable,
  StackTemplate, DiplomacyEntry, UnitInstance, SubRaceInfo, MapPlan, RoadInfo,
} from "@d2/map-schema";

const DEFAULT_SG_VERSION = "S143";

/**
 * The on-disk format version is the 4-char prefix shared by every compound uid
 * (e.g. "S143", "S129"). Detect it from the first BEGOBJECT's id, falling back
 * to the known default.
 */
function detectVersion(buf: ByteBuffer): string {
  for (const obj of iterateObjects(buf)) {
    const parsed = parseCompoundId(obj.id);
    if (parsed) return parsed.version;
  }
  return DEFAULT_SG_VERSION;
}

/** Header info available without a full parse. */
export interface ParsedHeader {
  size: number;
  header: MapHeader;
  players: PlayerInfo[];
}

interface Accumulated {
  size: number | null;
  header: MapHeader | null;
  players: PlayerInfo[];
  objects: MapObject[];
  events: MapEvent[];
  variables: ScenarioVariable[];
  templates: StackTemplate[];
  diplomacy: DiplomacyEntry[];
  /** true for the elf-expansion format (magic D2EESFISIG) — gates ELF/VERELF event race flags. */
  isEES: boolean;
  blocks: TerrainBlock[];
  roads: RoadRecord[];
  /** MidSubRace block index -> banner number (for stack/fort STACK_BANNER sprites). */
  subraceBanners: Map<number, number>;
  /** Full MidSubRace records — the typed table the rebuild re-emits. */
  subraces: SubRaceInfo[];
  /** Satellite blocks (per-player state + playthrough logs) — fully typed (Stage D). */
  satellites: NonNullable<MapDocument["satellites"]>;
  /** The MidgardPlan, fully typed (Stage E). */
  plan: MapPlan | null;
  /** MidRoad block records with ids (Stage E; the cell overlay stays in `roads`). */
  roadBlocks: RoadInfo[];
  /** MidItem instance id -> ITEM_TYPE global template id (for chest item resolution). */
  itemInstances: Record<string, string>;
  /** MidUnit instance id -> its FULL record (impl/level/hp/xp/creation/name/modifiers). Used for
   *  garrison + stack-leader resolution (impl/level/hp) AND the byte-exact model rebuild (all
   *  fields). Units are NOT placed objects (they live inside stacks/forts), so they stay out of
   *  objects. */
  unitInstances: Record<string, Omit<UnitInstance, "id">>;
}

/** Single-object readers keyed by TypeName. */
const SINGLE_READERS: Record<
  string,
  (buf: ByteBuffer, obj: FramedObject) => MapObject
> = {
  MidStack: readStack,
  MidVillage: readVillage,
  Capital: readCapital,
  MidRuin: readRuin,
  MidSiteMerchant: readSite("merchant"),
  MidSiteMage: readSite("mage"),
  MidSiteTrainer: readSite("trainer"),
  MidSiteMercs: readSite("mercenary"),
  MidSiteResourceMarket: readSite("resourceMarket"),
  MidCrystal: readCrystal,
  MidLocation: readLocation,
  MidLandmark: readLandmark,
  MidBag: readTreasure,
  MidRod: readRod,
  MidTomb: readTomb,
};

function consume(buf: ByteBuffer, obj: FramedObject, acc: Accumulated): void {
  switch (obj.typeName) {
    case "ScenarioInfo": {
      const info = readScenarioInfo(buf, obj);
      if (info) {
        acc.size = info.size;
        acc.header = info.header;
      }
      return;
    }
    case "MidPlayer":
      acc.players.push(readPlayer(buf, obj));
      return;
    case "MidgardMap": {
      const sz = readMidgardMapSize(buf, obj);
      if (sz && acc.size === null) acc.size = sz;
      return;
    }
    case "MidgardMapBlock": {
      const block = readMapBlock(buf, obj);
      if (block) acc.blocks.push(block);
      return;
    }
    case "MidRoad": {
      const road = readRoad(buf, obj);
      if (road) {
        acc.roads.push(road); // per-cell overlay for rendering
        // block record for the byte-exact rebuild (id preserved — 4/87 maps have sequential ids)
        acc.roadBlocks.push({ id: obj.id, x: road.x, y: road.y, index: road.roadType, variant: road.roadVar });
      }
      return;
    }
    case "MidSubRace": {
      // Full record (rebuild re-emits it); the banner map is derived for the sprite resolution
      // (stacks/forts resolve their STACK_BANNER via their SUBRACE link, keyed by block index).
      const sr = readSubRace(buf, obj);
      acc.subraces.push(sr);
      const idx = parseCompoundId(obj.id)?.index;
      if (idx !== undefined) acc.subraceBanners.set(idx, sr.banner);
      return;
    }
    case "MidMountains": {
      for (const m of readMountains(buf, obj)) acc.objects.push(m);
      return;
    }
    case "MidItem": {
      // a scenario item instance: ITEM_ID = its own id, ITEM_TYPE = the global template.
      const type = readDefaultString(buf, "ITEM_TYPE", obj.fieldsFrom, obj.fieldsEnd);
      if (type) acc.itemInstances[obj.id] = type;
      return;
    }
    case "MidUnit": {
      // a scenario unit instance (inside a stack/fort, not a placed object). Collect its FULL
      // record (garrison/leader resolution reads impl/level/hp; the rebuild re-emits every field).
      acc.unitInstances[obj.id] = readUnit(buf, obj);
      return;
    }
    case "MidEvent":
      acc.events.push(readEvent(buf, obj, acc.isEES));
      return;
    case "MidScenVariables":
      acc.variables = readScenVariables(buf, obj);
      return;
    case "MidStackTemplate":
      acc.templates.push(readStackTemplate(buf, obj));
      return;
    case "MidDiplomacy":
      acc.diplomacy = readDiplomacy(buf, obj);
      return;
    // ---- satellite blocks: per-player state + playthrough logs (typed, Stage D) ----
    case "MidgardMapFog":
      acc.satellites.fogs.push(readFog(buf, obj));
      return;
    case "PlayerKnownSpells":
      acc.satellites.playerSpells.push(readPlayerSpells(buf, obj));
      return;
    case "PlayerBuildings":
      acc.satellites.playerBuildings.push(readPlayerBuildings(buf, obj));
      return;
    case "MidTalismanCharges":
      acc.satellites.talismanCharges.push(readTalismanCharges(buf, obj));
      return;
    case "MidStackDestroyed":
      acc.satellites.stackDestroyed.push(readStackDestroyed(buf, obj));
      return;
    case "MidQuestLog":
      acc.satellites.questLogs.push(readQuestLog(buf, obj));
      return;
    case "MidSpellCast":
      acc.satellites.spellCasts.push(readSpellCast(buf, obj));
      return;
    case "MidSpellEffects":
      acc.satellites.spellEffects.push(readSpellEffects(buf, obj));
      return;
    case "TurnSummary":
      acc.satellites.turnSummaries.push(readTurnSummary(buf, obj));
      return;
    case "MidgardPlan": {
      // The placement/passability index — fully typed now (Stage E): size + ordered entries.
      // NOT a placed object (the old generic stub in doc.objects is gone).
      acc.plan = readPlan(buf, obj);
      return;
    }
    default: {
      const reader = SINGLE_READERS[obj.typeName];
      acc.objects.push(reader ? reader(buf, obj) : readGeneric(buf, obj));
      return;
    }
  }
}

/** Apply MidRoad overlays onto the matching terrain cells. */
function applyRoads(
  cells: MapDocument["terrain"]["cells"],
  size: number,
  roads: RoadRecord[],
): void {
  for (const r of roads) {
    if (r.x < 0 || r.x >= size || r.y < 0 || r.y >= size) continue;
    const cell = cells[r.y * size + r.x];
    if (!cell) continue;
    cell.roadType = r.roadType;
    cell.roadVar = r.roadVar;
  }
}

/** Full parse: walk every framed object once and assemble the document. */
export function assembleDocument(
  buf: ByteBuffer,
  schemaVersion: string,
  parserVersion: string,
): MapDocument {
  const acc: Accumulated = {
    size: null,
    header: null,
    players: [],
    objects: [],
    events: [],
    variables: [],
    templates: [],
    diplomacy: [],
    // magic sits at the very start of the file; D2EESFISIG = the elf-expansion (our target) format
    isEES: buf.asciiSlice(0, 10) === "D2EESFISIG",
    blocks: [],
    roads: [],
    subraceBanners: new Map(),
    subraces: [],
    satellites: {
      fogs: [], playerSpells: [], playerBuildings: [], talismanCharges: [],
      stackDestroyed: [], questLogs: [], spellCasts: [], spellEffects: [], turnSummaries: [],
    },
    plan: null,
    roadBlocks: [],
    itemInstances: {},
    unitInstances: {},
  };

  for (const obj of iterateObjects(buf)) consume(buf, obj, acc);

  // Enrich garrison members from their MidUnit records: the reader emitted the ENTITY identity
  // (key = instance id, slot = UNIT_ slot) with `unit` as a placeholder; fill in the resolved
  // global Gunit id + stats (omit-at-default like the record itself). Two DISTINCT armies
  // (verified vs toolsqt D2Capital/D2Village/D2Stack + Riders.sg):
  //   • a city/capital's embedded UNIT_0..5/POS_0..5 = the city's OWN DEFENSE garrison;
  //   • a stack's UNIT_/POS_ = its own army — and when that stack is INSIDE a city (city.STACK →
  //     this stack, stack.INSIDE → the city), it IS the city's separate "visitor" garrison.
  // Do NOT fall back from an empty city defense to the linked visitor — they are different armies
  // (e.g. Riders village FT0002 has empty defense + a visitor; the old fallback merged them).
  const referencedUnits = new Set<string>();
  const referencedItems = new Set<string>();
  const enrichMembers = (cells: (GarrisonUnit | null)[] | undefined): void => {
    for (const m of cells ?? []) {
      if (!m?.key) continue;
      referencedUnits.add(m.key);
      const u = acc.unitInstances[m.key];
      if (!u) continue; // referenced instance without a block: keep the placeholder (unit = key)
      // `unit` stays == key when the record has no TYPE (the rebuild writes the nil ref then)
      if (u.implId) m.unit = u.implId;
      m.level = u.level ?? 1;
      m.hp = u.hp ?? 0;
      if (u.xp) m.xp = u.xp;
      if (u.creation) m.creation = u.creation;
      if (u.name) m.name = u.name;
      if (u.modifiers?.length) m.modifiers = u.modifiers;
      if (u.transformed) m.transformed = true;
    }
  };
  for (const o of acc.objects) {
    if (o.type === "stack") {
      enrichMembers(o.garrison);
      // LEADER_ID names a MidUnit instance; map it to its formation CELL so the leader survives
      // formation edits (a fresh export mints new ids). leaderImage = that cell's unit impl —
      // the editor's stack sprite is leaderImpl + "STOP" + facing (StackObjectAccessor).
      if (o.leaderUnitId && o.garrison) {
        const lc = o.garrison.findIndex((m) => m?.key === o.leaderUnitId);
        if (lc >= 0) o.leaderCell = lc;
      }
      if (o.leaderCell !== undefined) o.leaderImage = o.garrison?.[o.leaderCell]?.unit;
      delete o.leaderUnitId;
    } else if (o.type === "village" || o.type === "capital" || o.type === "ruin") {
      enrichMembers(o.garrison);
    }
  }

  // Resolve each fort/capital/village's sprite race from its OWNER player. The
  // editor sets FortObject.raceId = player.raceId (MapConverter.cpp:380) and builds
  // the image key from Grace[player.raceId] (NOT from the block's SUBRACE, which is
  // the banner/faction). PlayerInfo.race is the Grace RACE_ID index; the renderer
  // maps it through graceFortCodes (Grace -> Lrace 2-char code).
  const playerRace = new Map<string, number>();
  for (const p of acc.players) playerRace.set(p.id, p.race);
  for (const o of acc.objects) {
    if (
      o.type === "capital" || o.type === "village" ||
      o.type === "fort" || o.type === "rod"
    ) {
      if (o.owner !== undefined) {
        const r = playerRace.get(o.owner);
        if (r !== undefined) o.race = r;
      }
    }
  }

  // Resolve item lists from MidItem instance ids to their global GItem template ids (e.g.
  // "S143IM000a" -> "G000IG0006") so the editor works with stable catalog templates; the on-disk
  // ids stay index-aligned in itemKeys/inventoryKeys (the entity identity the rebuild re-emits).
  // Chest/village/capital contents + a stack's carried inventory all use this ITEM_ID list.
  const markItems = (keys: readonly string[] | undefined): void => {
    for (const k of keys ?? []) referencedItems.add(k);
  };
  for (const o of acc.objects) {
    if ((o.type === "treasure" || o.type === "village" || o.type === "capital") && o.items) {
      o.items = o.items.map((inst) => acc.itemInstances[inst] ?? inst);
      markItems(o.itemKeys);
    } else if (o.type === "stack" && o.inventory) {
      o.inventory = o.inventory.map((inst) => acc.itemInstances[inst] ?? inst);
      markItems(o.inventoryKeys);
    }
  }

  // Resolve each stack/fort's STACK_BANNER number from its linked MidSubRace block
  // (the editor reads subrace.banner, NOT the stack's own BANNER field).
  for (const o of acc.objects) {
    if (
      (o.type === "stack" || o.type === "capital" || o.type === "village") &&
      o.subRace !== undefined
    ) {
      const idx = parseCompoundId(o.subRace)?.index;
      const banner = idx !== undefined ? acc.subraceBanners.get(idx) : undefined;
      if (banner !== undefined) o.bannerIndex = banner;
    }
  }

  const size = acc.size;
  if (size === null || size <= 0) {
    throw new Error("sg-parser: could not determine map size (no MAP_SIZE / MidgardMap)");
  }

  const version = detectVersion(buf);
  const header: MapHeader = acc.header ?? {
    name: "",
    description: "",
    author: "",
    version,
    size,
  };
  header.version = version;
  header.size = size;

  const cells = buildGrid(size, acc.blocks);
  applyRoads(cells, size, acc.roads);

  // STRAY instance blocks: MidUnit/MidItem no object references (dangling data the game editor
  // left — measured 62 units + 4 items across the corpus). Referenced instances live inline on
  // their owners (key/slot on garrison members, itemKeys on lists); only the leftovers need a
  // typed home so the rebuild can still re-emit their blocks byte-exact.
  const strayItems = Object.entries(acc.itemInstances)
    .filter(([id]) => !referencedItems.has(id))
    .map(([id, itemType]) => ({ id, itemType }));
  const strayUnits = Object.entries(acc.unitInstances)
    .filter(([id]) => !referencedUnits.has(id))
    .map(([id, u]) => ({ id, ...u }));

  return {
    schemaVersion,
    parserVersion,
    header,
    size,
    terrain: { size, cells },
    objects: acc.objects,
    players: acc.players,
    events: acc.events,
    variables: acc.variables,
    templates: acc.templates,
    diplomacy: acc.diplomacy,
    ...(strayUnits.length || strayItems.length
      ? { strayInstances: { units: strayUnits, items: strayItems } }
      : {}),
    subraces: acc.subraces,
    satellites: acc.satellites,
    ...(acc.plan ? { plan: acc.plan } : {}),
    roads: acc.roadBlocks,
  };
}

/**
 * Header-only parse: read just ScenarioInfo + MidPlayer + map size. Stops as soon
 * as a size is known and all players up to that point are collected. We still walk
 * objects (cheap relative to grid build) but skip terrain/object construction.
 */
export function assembleHeader(buf: ByteBuffer): ParsedHeader {
  let size: number | null = null;
  let header: MapHeader | null = null;
  const players: PlayerInfo[] = [];

  for (const obj of iterateObjects(buf)) {
    if (obj.typeName === "ScenarioInfo") {
      const info = readScenarioInfo(buf, obj);
      if (info) {
        size = info.size;
        header = info.header;
      }
    } else if (obj.typeName === "MidPlayer") {
      players.push(readPlayer(buf, obj));
    } else if (obj.typeName === "MidgardMap" && size === null) {
      const sz = readMidgardMapSize(buf, obj);
      if (sz) size = sz;
    }
  }

  if (size === null || size <= 0) {
    throw new Error("sg-parser: could not determine map size for header");
  }
  const version = detectVersion(buf);
  const hdr: MapHeader = header ?? {
    name: "",
    description: "",
    author: "",
    version,
    size,
  };
  hdr.version = version;
  hdr.size = size;
  return { size, header: hdr, players };
}
