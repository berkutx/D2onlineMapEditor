/**
 * Placement helpers (mountains, landmarks, locations, chests, villages, stacks). They
 * build the EditOps for one placement, allocating the object's id HERE so the byte writer
 * can reuse it (ids must agree between the in-memory model and the exported .sg).
 *
 * - Mountains: addObject + a 37 ("mountain ground") setCell stamp over the footprint
 *   (the editor stamps covered cells to 37; allowed on water — the stamp replaces it).
 * - Landmarks: addObject only (footprint comes from GLmark at render/validate time).
 * - Chests/villages/stacks: addObject whose object EXACTLY matches the reader's output
 *   for the appended block (the semantic round-trip compares them key-for-key).
 */

import type { MapDocument, MapObject } from "@d2/map-schema";
import type { EditOp } from "./ops.js";

/** Mountain-ground cell value (terrain 5 | ground 4), as the editor stamps. */
export const MOUNTAIN_CELL = 37;

const hex4 = (n: number): string => (n >>> 0).toString(16).padStart(4, "0");

/** True iff a w×h footprint anchored at (cx,cy) fits on the map (no overlap check yet). */
export function canPlaceAt(doc: MapDocument, cx: number, cy: number, w: number, h: number): boolean {
  return cx >= 0 && cy >= 0 && cx + w <= doc.size && cy + h <= doc.size;
}

/** Ops to place a mountain: addObject + 37-stamp its footprint. id matches readMountains. */
export function placeMountainOps(
  doc: MapDocument,
  cx: number,
  cy: number,
  w: number,
  h: number,
  image: number,
  race = 0,
): EditOp[] {
  const version = doc.header.version || "S143";
  const count = doc.objects.filter((o) => o.type === "mountains").length;
  // readMountains ids entries as `${blockId}#${index}`; the single block is ML0000.
  const id = `${version}ML0000#${count}`;
  const ops: EditOp[] = [
    { kind: "addObject", object: { type: "mountains", id, pos: { x: cx, y: cy }, w, h, image, race } },
  ];
  const n = doc.size;
  for (let i = 0; i < w; i++) {
    for (let k = 0; k < h; k++) {
      const x = cx + i;
      const y = cy + k;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const cell = doc.terrain.cells[y * n + x];
      if (cell && cell.value !== MOUNTAIN_CELL) {
        ops.push({ kind: "setCell", x, y, value: MOUNTAIN_CELL });
      }
    }
  }
  return ops;
}

/**
 * Ops to add a VISITING hero stack to a city/capital: a fresh empty MidStack (KC id) linked via
 * INSIDE → city, plus city.STACK → the new stack. The stack starts empty (no units/leader/items)
 * and is then filled via the normal garrison/equip/inventory ops. The op.object is built to EXACTLY
 * match what parse() will produce for the written MidStack (so the 3-tier validator's semantic
 * round-trip passes): SUBRACE is left empty (no derived bannerIndex), stacks skip the race pass.
 */
export function placeVisitorOps(
  doc: MapDocument,
  city: { id: string; pos: { x: number; y: number }; owner?: string },
): EditOp[] {
  const version = doc.header.version || "S143";
  let max = -1;
  for (const o of doc.objects) {
    if (o.type === "stack") {
      const m = /KC([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) max = Math.max(max, parseInt(m[1]!, 16));
    }
  }
  const id = `${version}KC${hex4(max + 1)}`;
  const visitor = {
    type: "stack" as const,
    id,
    pos: { x: city.pos.x, y: city.pos.y },
    garrisoned: true as const,
    inside: city.id,
    facing: 0,
    order: 1, // Normal
    morale: 0,
    move: 20,
    priority: 3,
    creatLvl: 1,
    equip: {},
    inventory: [] as string[],
    garrison: [null, null, null, null, null, null] as (null)[],
    ...(city.owner ? { owner: city.owner } : {}),
  };
  return [
    { kind: "addObject", object: visitor as unknown as MapObject },
    { kind: "patchObject", id: city.id, fields: { stackRef: id } },
  ];
}

/** Ops to place a landmark: one addObject. id = a fresh S143MM#### (matches the block). */
export function placeLandmarkOps(doc: MapDocument, cx: number, cy: number, lmarkKey: string): EditOp[] {
  const version = doc.header.version || "S143";
  let max = -1;
  for (const o of doc.objects) {
    if (o.type === "landmark") {
      const m = /MM([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) max = Math.max(max, parseInt(m[1]!, 16));
    }
  }
  const id = `${version}MM${hex4(max + 1)}`;
  return [{ kind: "addObject", object: { type: "landmark", id, pos: { x: cx, y: cy }, baseType: lmarkKey } }];
}

/** Ops to place a treasure chest (MidBag): one addObject. id = a fresh S143BG####.
 *  The object mirrors readTreasure's output EXACTLY (IMAGE + AIPRIORITY are always
 *  written by bagFrame, items always present) so the semantic round-trip passes.
 *  `items` are global GItem TEMPLATE ids — MidItem instances are minted on export. */
export function placeChestOps(
  doc: MapDocument,
  cx: number,
  cy: number,
  image = 0,
  items: readonly string[] = [],
): EditOp[] {
  const version = doc.header.version || "S143";
  let max = -1;
  for (const o of doc.objects) {
    if (o.type === "treasure") {
      const m = /BG([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) max = Math.max(max, parseInt(m[1]!, 16));
    }
  }
  const id = `${version}BG${hex4(max + 1)}`;
  return [{
    kind: "addObject",
    object: { type: "treasure", id, pos: { x: cx, y: cy }, image, priority: 0, items: items.slice() },
  }];
}

/** Ops to place a race-neutral EMPTY village (MidVillage): one addObject. The FT id prefix
 *  is SHARED by Village/Fort/Capital (byte-verified: Riders villages AND capitals are all
 *  S143FT####), so the fresh id scans EVERY object carrying the prefix, not just villages.
 *  The object mirrors readVillage + the assemble post-pass exactly: neutral owner (OWNER =
 *  the nil sentinel -> key omitted, no race), empty 6-cell garrison, desc "" and the always-
 *  written scalars at their frame defaults. The inspector edits everything after placement. */
export function placeVillageOps(
  doc: MapDocument,
  cx: number,
  cy: number,
  name: string,
  tier = 1,
): EditOp[] {
  const version = doc.header.version || "S143";
  let max = -1;
  for (const o of doc.objects) {
    const m = /FT([0-9a-fA-F]{4})$/.exec(o.id);
    if (m) max = Math.max(max, parseInt(m[1]!, 16));
  }
  const id = `${version}FT${hex4(max + 1)}`;
  const village = {
    type: "village" as const,
    id,
    pos: { x: cx, y: cy },
    name,
    desc: "",
    tier,
    priority: 0,
    morale: 0,
    regen: 0,
    growth: 0,
    garrison: [null, null, null, null, null, null] as null[],
  };
  return [{ kind: "addObject", object: village as unknown as MapObject }];
}

/** Ops to place a REAL army stack (MidStack WITH units): one addObject. `units` = up to 6
 *  formation cells (index = FORMATION CELL; {unit: global Gunit id, level, hp} | null);
 *  `leaderCell` names the hero's cell (exported as LEADER_ID via that cell's minted MidUnit
 *  instance). The object mirrors readStack + the assemble post-pass exactly (leaderCell +
 *  leaderImage resolved from LEADER_ID; scalar defaults = stackFrame's frame defaults). */
export function placeStackOps(
  doc: MapDocument,
  cx: number,
  cy: number,
  o: {
    owner?: string;
    units: readonly ({ unit: string; level?: number; hp?: number } | null)[];
    leaderCell: number;
  },
): EditOp[] {
  const version = doc.header.version || "S143";
  let max = -1;
  for (const obj of doc.objects) {
    if (obj.type === "stack") {
      const m = /KC([0-9a-fA-F]{4})$/.exec(obj.id);
      if (m) max = Math.max(max, parseInt(m[1]!, 16));
    }
  }
  const id = `${version}KC${hex4(max + 1)}`;
  const garrison = Array.from({ length: 6 }, (_, i) => {
    const gu = o.units[i];
    return gu ? { unit: gu.unit, level: gu.level ?? 1, hp: gu.hp ?? 0 } : null;
  });
  if (!garrison[o.leaderCell]) {
    throw new Error(`placeStackOps: leaderCell ${o.leaderCell} names an empty formation cell`);
  }
  const stack = {
    type: "stack" as const,
    id,
    pos: { x: cx, y: cy },
    ...(o.owner ? { owner: o.owner } : {}),
    leaderCell: o.leaderCell,
    leaderImage: garrison[o.leaderCell]!.unit,
    facing: 0,
    order: 1, // Normal
    morale: 0,
    move: 20,
    priority: 3,
    creatLvl: 1,
    equip: {},
    inventory: [] as string[],
    garrison,
  };
  return [{ kind: "addObject", object: stack as unknown as MapObject }];
}

/** Ops to place a location (named region): one addObject. id = a fresh S143LO####
 *  (max existing + 1, allocated HERE so model and export agree). */
export function placeLocationOps(
  doc: MapDocument,
  cx: number,
  cy: number,
  radius: number,
  name: string,
): EditOp[] {
  const version = doc.header.version || "S143";
  let max = -1;
  for (const o of doc.objects) {
    if (o.type === "location") {
      const m = /LO([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) max = Math.max(max, parseInt(m[1]!, 16));
    }
  }
  const id = `${version}LO${hex4(max + 1)}`;
  return [{ kind: "addObject", object: { type: "location", id, pos: { x: cx, y: cy }, name, radius } }];
}
