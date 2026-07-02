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
  readPlayer,
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
import type {
  MapDocument, MapObject, PlayerInfo, MapHeader, GarrisonUnit, MapEvent, ScenarioVariable,
  StackTemplate,
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
  /** true for the elf-expansion format (magic D2EESFISIG) — gates ELF/VERELF event race flags. */
  isEES: boolean;
  blocks: TerrainBlock[];
  roads: RoadRecord[];
  /** MidSubRace block index -> banner number (for stack/fort STACK_BANNER sprites). */
  subraceBanners: Map<number, number>;
  /** MidItem instance id -> ITEM_TYPE global template id (for chest item resolution). */
  itemInstances: Record<string, string>;
  /** MidUnit instance id -> {impl Gunit id, level, hp} (for garrison + stack-leader resolution).
   *  Units are NOT placed objects (they live inside stacks/forts), so they stay out of objects. */
  unitInstances: Record<string, { implId?: string; level?: number; hp?: number }>;
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
      if (road) acc.roads.push(road);
      return;
    }
    case "MidSubRace": {
      // Non-visual: capture only the banner number, keyed by the block's index,
      // so stacks/forts can resolve their STACK_BANNER sprite via their SUBRACE link.
      const banner = readDefaultInt(buf, "BANNER", obj.fieldsFrom, obj.fieldsEnd);
      const idx = parseCompoundId(obj.id)?.index;
      if (banner !== null && idx !== undefined) acc.subraceBanners.set(idx, banner);
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
      // a scenario unit instance (inside a stack/fort, not a placed object). Collect its
      // impl/level/hp for garrison + stack-leader resolution; do NOT add to objects.
      const u = readUnit(buf, obj);
      if (u.type === "unit") acc.unitInstances[obj.id] = { implId: u.implId, level: u.level, hp: u.hp };
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
    case "MidgardPlan": {
      // The placement plan: per-cell {POS_X, POS_Y, ELEMENT->object} entries. NOT a placed
      // object — readGeneric would grab the FIRST entry's POS_X/POS_Y as its "position",
      // coupling the doc to whichever entry happens to be first (deleting an object purges
      // its plan entries, which could shift that). Keep a stable generic stub instead.
      acc.objects.push({ type: "generic", id: obj.id, pos: { x: 0, y: 0 }, blockType: obj.typeName, raw: {} });
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
    // magic sits at the very start of the file; D2EESFISIG = the elf-expansion (our target) format
    isEES: buf.asciiSlice(0, 10) === "D2EESFISIG",
    blocks: [],
    roads: [],
    subraceBanners: new Map(),
    itemInstances: {},
    unitInstances: {},
  };

  for (const obj of iterateObjects(buf)) consume(buf, obj, acc);

  // Resolve garrison formations from their by-cell MidUnit-instance ids to {global Gunit id,
  // level, hp}. Two DISTINCT armies (verified vs toolsqt D2Capital/D2Village/D2Stack + Riders.sg):
  //   • a city/capital's embedded UNIT_0..5/POS_0..5 = the city's OWN DEFENSE garrison;
  //   • a stack's UNIT_/POS_ = its own army — and when that stack is INSIDE a city (city.STACK →
  //     this stack, stack.INSIDE → the city), it IS the city's separate "visitor" garrison.
  // Do NOT fall back from an empty city defense to the linked visitor — they are different armies
  // (e.g. Riders village FT0002 has empty defense + a visitor; the old fallback merged them).
  const resolveCells = (cells: (string | null)[] | null | undefined): (GarrisonUnit | null)[] =>
    (cells ?? [null, null, null, null, null, null]).map((inst) => {
      if (!inst) return null;
      const u = acc.unitInstances[inst];
      if (u) return { unit: u.implId ?? inst, level: u.level ?? 1, hp: u.hp ?? 0 };
      return { unit: inst, level: 1, hp: 0 };
    });
  for (const o of acc.objects) {
    if (o.type === "stack") {
      const raw = o.garrisonRaw;
      // LEADER_ID names a MidUnit instance; map it to its formation CELL so the leader survives
      // formation edits (instance ids aren't stable). leaderImage = that cell's unit impl —
      // the editor's stack sprite is leaderImpl + "STOP" + facing (StackObjectAccessor).
      if (o.leaderUnitId && raw) {
        const lc = raw.indexOf(o.leaderUnitId);
        if (lc >= 0) o.leaderCell = lc;
      }
      o.garrison = resolveCells(raw);
      if (o.leaderCell !== undefined) o.leaderImage = o.garrison[o.leaderCell]?.unit;
      delete o.garrisonRaw;
      delete o.leaderUnitId;
    } else if (o.type === "village" || o.type === "capital") {
      o.garrison = resolveCells(o.garrisonRaw);
      delete o.garrisonRaw;
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
  // "S143IM000a" -> "G000IG0006") so the editor works with stable catalog templates. The
  // instance indirection is re-created on export (new MidItems). Chest contents + a stack's
  // carried inventory both use this MidItem-instance ITEM_ID list.
  for (const o of acc.objects) {
    if (o.type === "treasure" && o.items) {
      o.items = o.items.map((inst) => acc.itemInstances[inst] ?? inst);
    } else if (o.type === "stack" && o.inventory) {
      o.inventory = o.inventory.map((inst) => acc.itemInstances[inst] ?? inst);
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
