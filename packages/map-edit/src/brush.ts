/**
 * Terrain brushes — turn a click/drag at a cell into setCell EditOps over a square
 * footprint (the editor's 1×1 / 3×3 / 5×5 sizes). Each brush mutates only the bits
 * it owns (via bits.ts), preserving the rest of the packed cell value.
 */

import type { MapDocument } from "@d2/map-schema";
import type { EditOp } from "./ops.js";
import { setTerrain, setGround, setForest, GROUND_WATER } from "./bits.js";

/** Ground/surface code for a forested cell (renderer draws a tree when ground===1). */
const GROUND_FOREST = 1;
/** Forest tree-variant ids 0..19 exist for every land terrain (verified from the atlas). */
const FOREST_RANGE = 20;

/** A pseudo-random tree variant per cell, so a painted forest doesn't repeat. */
function forestIdFor(x: number, y: number): number {
  return ((Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) >>> 0) % FOREST_RANGE;
}

/** What a brush paints. `terrain` = a Lterrain id (1=HU,2=DW,3=HE,4=UN,5=NE,6=EL). */
export type BrushKind =
  | { type: "terrain"; terrain: number }
  | { type: "water" }
  | { type: "forest" } // ground=forest + a per-cell tree variant
  | { type: "erase" }; // back to neutral land (terrain 5, no water/forest)

/** The new packed cell value this brush produces from the old one at (x,y). */
export function brushValue(old: number, kind: BrushKind, x: number, y: number): number {
  switch (kind.type) {
    case "terrain":
      return setGround(setTerrain(old, kind.terrain), 0); // land (clears water)
    case "water":
      return setGround(old, GROUND_WATER);
    case "forest":
      return setForest(setGround(old, GROUND_FOREST), forestIdFor(x, y));
    case "erase":
      return setForest(setGround(setTerrain(old, 5), 0), 0);
  }
}

/**
 * Road auto-tiling: 4-neighbour connectivity bitmask (top=1,bottom=2,left=4,right=8)
 * -> road piece INDEX (0..16). Ported verbatim from the editor's MapEditTool::updateRoad.
 */
export function roadTypeFromMask(m: number): number {
  if (m === 0 || m === 15) return 0;
  switch (m) {
    case 12: return 2;
    case 3: return 3;
    case 7: return 4;
    case 13: return 5;
    case 14: return 6;
    case 11: return 7;
    case 9: return 8;
    case 10: return 9;
    case 6: return 10;
    case 5: return 11;
    case 8: return 12;
    case 2: return 13;
    case 1: return 14;
    case 4: return 15;
    default: return 16;
  }
}

/**
 * Paint a road at (cx,cy) and recompute the auto-tile piece for the cell + its 4
 * orthogonal neighbours (matching the editor). Returns setCell ops (with roadType/
 * roadVar) for every cell whose road changed. Off-map neighbours count as no road.
 * The painted cell is cleared to bare terrain (ground/forest removed), like the editor.
 */
export function roadBrush(doc: MapDocument, cx: number, cy: number): EditOp[] {
  const n = doc.size;
  if (cx < 0 || cy < 0 || cx >= n || cy >= n) return [];
  const cellAt = (x: number, y: number) => doc.terrain.cells[y * n + x];
  const over = new Map<string, { value: number; roadType: number; roadVar: number }>();
  const key = (x: number, y: number) => `${x},${y}`;
  const cur = (x: number, y: number) => {
    const o = over.get(key(x, y));
    if (o) return o;
    const c = cellAt(x, y)!;
    return { value: c.value, roadType: c.roadType, roadVar: c.roadVar };
  };
  const roadAt = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < n && y < n && cur(x, y).roadType !== -1;

  // place the road on the painted cell: bare terrain, road piece recomputed below
  over.set(key(cx, cy), { value: cellAt(cx, cy)!.value & 7, roadType: 0, roadVar: 0 });

  const updateRoad = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    const c = cur(x, y);
    if (c.roadType < 0) return; // only cells that already have a road
    let m = 0;
    if (roadAt(x, y - 1)) m |= 1;
    if (roadAt(x, y + 1)) m |= 2;
    if (roadAt(x - 1, y)) m |= 4;
    if (roadAt(x + 1, y)) m |= 8;
    over.set(key(x, y), { value: c.value, roadType: roadTypeFromMask(m), roadVar: c.roadVar });
  };
  updateRoad(cx, cy);
  updateRoad(cx + 1, cy);
  updateRoad(cx - 1, cy);
  updateRoad(cx, cy + 1);
  updateRoad(cx, cy - 1);

  const ops: EditOp[] = [];
  for (const [k, v] of over) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    const c = cellAt(x, y)!;
    if (v.value !== c.value || v.roadType !== c.roadType || v.roadVar !== c.roadVar) {
      ops.push({ kind: "setCell", x, y, value: v.value, roadType: v.roadType, roadVar: v.roadVar });
    }
  }
  return ops;
}

/**
 * Erase brush: reset the footprint to neutral land AND remove any roads there, then
 * recompute the road pieces of the surrounding cells (a severed straight becomes an
 * end, a T becomes a corner, …). Returns setCell ops with value + roadType/roadVar.
 */
export function eraseBrush(doc: MapDocument, cx: number, cy: number, size: number): EditOp[] {
  const n = doc.size;
  const r = Math.floor((Math.max(1, size) - 1) / 2);
  const key = (x: number, y: number) => `${x},${y}`;
  const cellAt = (x: number, y: number) => doc.terrain.cells[y * n + x]!;
  const over = new Map<string, { value: number; roadType: number; roadVar: number }>();
  const cur = (x: number, y: number) => {
    const o = over.get(key(x, y));
    if (o) return o;
    const c = cellAt(x, y);
    return { value: c.value, roadType: c.roadType, roadVar: c.roadVar };
  };
  const roadAt = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < n && y < n && cur(x, y).roadType !== -1;

  // erase the footprint: neutral terrain, no road
  const footprint: [number, number][] = [];
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      over.set(key(x, y), { value: brushValue(cellAt(x, y).value, { type: "erase" }, x, y), roadType: -1, roadVar: -1 });
      footprint.push([x, y]);
    }
  }
  // recompute the road piece of the cells ringing the erased footprint
  const updateRoad = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    const c = cur(x, y);
    if (c.roadType < 0) return;
    let m = 0;
    if (roadAt(x, y - 1)) m |= 1;
    if (roadAt(x, y + 1)) m |= 2;
    if (roadAt(x - 1, y)) m |= 4;
    if (roadAt(x + 1, y)) m |= 8;
    over.set(key(x, y), { value: c.value, roadType: roadTypeFromMask(m), roadVar: c.roadVar });
  };
  for (const [x, y] of footprint) {
    updateRoad(x + 1, y);
    updateRoad(x - 1, y);
    updateRoad(x, y + 1);
    updateRoad(x, y - 1);
  }

  const ops: EditOp[] = [];
  for (const [k, v] of over) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    const c = cellAt(x, y);
    if (v.value !== c.value || v.roadType !== c.roadType || v.roadVar !== c.roadVar) {
      ops.push({ kind: "setCell", x, y, value: v.value, roadType: v.roadType, roadVar: v.roadVar });
    }
  }
  return ops;
}

/**
 * setCell ops for a square brush of side `size` (1/3/5…) centred on (cx,cy).
 * Cells whose value would not change are skipped, so a no-op stroke produces nothing.
 */
export function terrainBrush(
  doc: MapDocument,
  cx: number,
  cy: number,
  size: number,
  kind: BrushKind,
): EditOp[] {
  const r = Math.floor((Math.max(1, size) - 1) / 2);
  const n = doc.size;
  const ops: EditOp[] = [];
  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 0 || y >= n) continue;
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= n) continue;
      const cell = doc.terrain.cells[y * n + x];
      if (!cell) continue;
      const value = brushValue(cell.value, kind, x, y);
      if (value !== cell.value) ops.push({ kind: "setCell", x, y, value });
    }
  }
  return ops;
}
