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
  readMountains,
  readGeneric,
  type RoadRecord,
} from "./blocks/index.js";
import type { MapDocument, MapObject, PlayerInfo, MapHeader } from "@d2/map-schema";

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
  blocks: TerrainBlock[];
  roads: RoadRecord[];
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
  MidUnit: readUnit,
  MidBag: readTreasure,
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
    case "MidMountains": {
      for (const m of readMountains(buf, obj)) acc.objects.push(m);
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
    blocks: [],
    roads: [],
  };

  for (const obj of iterateObjects(buf)) consume(buf, obj, acc);

  // Resolve each stack's leader sprite base: leaderUnitId -> the MidUnit's implId
  // (a Gunit id like G000UU7624). The editor's stack sprite is leaderImpl + "STOP" +
  // facing (StackObjectAccessor), so the renderer needs the impl on the stack itself.
  const unitImpl = new Map<string, string>();
  for (const o of acc.objects) {
    if (o.type === "unit" && o.implId) unitImpl.set(o.id, o.implId);
  }
  for (const o of acc.objects) {
    if (o.type === "stack" && o.leaderUnitId) {
      const impl = unitImpl.get(o.leaderUnitId);
      if (impl) o.leaderImage = impl;
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
