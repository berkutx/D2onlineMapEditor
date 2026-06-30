/**
 * Placement helpers for non-interactive objects (mountains, landmarks). They build
 * the EditOps for one placement, allocating the object's id HERE so the byte writer
 * can reuse it (ids must agree between the in-memory model and the exported .sg).
 *
 * - Mountains: addObject + a 37 ("mountain ground") setCell stamp over the footprint
 *   (the editor stamps covered cells to 37; allowed on water — the stamp replaces it).
 * - Landmarks: addObject only (footprint comes from GLmark at render/validate time).
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
