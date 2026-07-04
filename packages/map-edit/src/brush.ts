/**
 * Terrain brushes — turn a click/drag at a cell into setCell EditOps over a square
 * footprint (the editor's 1×1 / 3×3 / 5×5 sizes). Each brush mutates only the bits
 * it owns (via bits.ts), preserving the rest of the packed cell value.
 */

import type { MapDocument } from "@d2/map-schema";
import type { EditOp } from "./ops.js";
import { setTerrain, setGround, setForest, GROUND_WATER } from "./bits.js";
import { roadOverlay } from "./roadOverlay.js";

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
      // clears water AND stale forest-variant bits (a tree id under new land is junk)
      return setForest(setGround(setTerrain(old, kind.terrain), 0), 0);
    case "water":
      // clears forest bits too — a tree variant under water is stale junk in the value
      return setForest(setGround(old, GROUND_WATER), 0);
    case "forest":
      return setForest(setGround(old, GROUND_FOREST), forestIdFor(x, y));
    case "erase":
      return setForest(setGround(setTerrain(old, 5), 0), 0);
  }
}

// the auto-tile mask table lives with the shared overlay helper now
export { roadTypeFromMask } from "./roadOverlay.js";

/**
 * Paint a road at (cx,cy) and recompute the auto-tile piece for the cell + its 4
 * orthogonal neighbours (matching the editor). Returns setCell ops (with roadType/
 * roadVar) for every cell whose road changed. Off-map neighbours count as no road.
 * The painted cell is cleared to bare terrain (ground/forest removed), like the editor.
 */
export function roadBrush(doc: MapDocument, cx: number, cy: number): EditOp[] {
  const n = doc.size;
  if (cx < 0 || cy < 0 || cx >= n || cy >= n) return [];
  // no roads on water — the game has no bridges; painting the shore stays fine
  if (((doc.terrain.cells[cy * n + cx]!.value >> 3) & 7) === GROUND_WATER) return [];
  const ov = roadOverlay(doc);
  // place the road on the painted cell: bare terrain, road piece recomputed below
  ov.set(cx, cy, { value: doc.terrain.cells[cy * n + cx]!.value & 7, roadType: 0, roadVar: 0 });
  ov.updateAround(cx, cy, true);
  return ov.diff();
}

/**
 * Erase brush: reset the footprint to neutral land AND remove any roads there, then
 * recompute the road pieces of the surrounding cells (a severed straight becomes an
 * end, a T becomes a corner, …). Returns setCell ops with value + roadType/roadVar.
 */
export function eraseBrush(
  doc: MapDocument,
  cx: number,
  cy: number,
  size: number,
  /** Occupied cells (buildOccupiedSet): erasing WATER under an object would strand a
   *  boat-stack / an underwater treasure on land — those cells are skipped. */
  occupied?: ReadonlySet<string>,
): EditOp[] {
  const n = doc.size;
  const r = Math.floor((Math.max(1, size) - 1) / 2);
  const cellAt = (x: number, y: number) => doc.terrain.cells[y * n + x]!;
  const ov = roadOverlay(doc);

  // erase the footprint: neutral terrain, no road
  const footprint: [number, number][] = [];
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const isWater = ((cellAt(x, y).value >> 3) & 7) === GROUND_WATER;
      if (occupied?.has(`${x},${y}`) && isWater) continue;
      ov.set(x, y, { value: brushValue(cellAt(x, y).value, { type: "erase" }, x, y), roadType: -1, roadVar: -1 });
      footprint.push([x, y]);
    }
  }
  // recompute the road piece of the cells ringing the erased footprint
  for (const [x, y] of footprint) ov.updateAround(x, y);
  return ov.diff();
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
  /** Cells occupied by objects (buildOccupiedSet) — the game-mechanics guard: water/forest
   *  never paint under an object (drowning a village / a tree on a stack), and land paints
   *  (terrain/erase) skip occupied WATER cells (draining under a boat-stack). Plain biome
   *  recolors on occupied LAND stay legal (snow under a village is fine). */
  occupied?: ReadonlySet<string>,
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
      if (occupied?.has(`${x},${y}`)) {
        const isWater = ((cell.value >> 3) & 7) === GROUND_WATER;
        if (kind.type === "water" || kind.type === "forest") continue;
        if (isWater) continue; // terrain/erase would drain the water under a boat-stack
      }
      const value = brushValue(cell.value, kind, x, y);
      // water washes away a road on the cell (a road under water is invalid in the game);
      // -1/-1 is the road-erase idiom — only where a road exists (the writer needs a real
      // MidRoad record to patch)
      const washRoad = kind.type === "water" && cell.roadType !== -1;
      if (washRoad) ops.push({ kind: "setCell", x, y, value, roadType: -1, roadVar: -1 });
      else if (value !== cell.value) ops.push({ kind: "setCell", x, y, value });
    }
  }
  return ops;
}
