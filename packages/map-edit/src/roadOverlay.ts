/**
 * roadOverlay — the shared working-copy idiom of every road algorithm (brush, erase,
 * translate, extend): a Map-backed OVERLAY over the doc's cells where reads fall through
 * to the document, writes stay local, `updateRoad` recomputes a cell's auto-tile piece
 * from its 4 orthogonal neighbours, and `diff()` emits one setCell op per changed cell.
 * Was copy-pasted five times (brush.ts ×2, roadSelect.ts ×3) — one home now.
 */
import type { MapDocument } from "@d2/map-schema";
import type { EditOp } from "./ops.js";

/**
 * Road auto-tiling: 4-neighbour connectivity bitmask (top=1,bottom=2,left=4,right=8)
 * -> road piece INDEX (0..16). Ported verbatim from the editor's MapEditTool::updateRoad.
 * (Lives here — next to its only algorithmic consumer; brush.ts re-exports it.)
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

export interface CellPatch {
  value: number;
  roadType: number;
  roadVar: number;
}

export interface RoadOverlay {
  /** overlay-or-doc read (never writes). */
  cur(x: number, y: number): CellPatch;
  /** stage a local change. */
  set(x: number, y: number, p: CellPatch): void;
  /** in-bounds && has a road in the CURRENT (overlaid) state. */
  roadAt(x: number, y: number): boolean;
  /** recompute the auto-tile piece of a road cell (no-op off-map / non-road). */
  updateRoad(x: number, y: number): void;
  /** updateRoad on the 4 orthogonal neighbours (+ the cell itself when asked). */
  updateAround(x: number, y: number, includeSelf?: boolean): void;
  /** setCell ops for every staged cell that actually differs from the doc. */
  diff(): EditOp[];
}

export function roadOverlay(doc: MapDocument): RoadOverlay {
  const n = doc.size;
  const key = (x: number, y: number): string => `${x},${y}`;
  const cellAt = (x: number, y: number) => doc.terrain.cells[y * n + x];
  const over = new Map<string, CellPatch>();

  const cur = (x: number, y: number): CellPatch => {
    const o = over.get(key(x, y));
    if (o) return o;
    const c = cellAt(x, y)!;
    return { value: c.value, roadType: c.roadType, roadVar: c.roadVar };
  };
  const set = (x: number, y: number, p: CellPatch): void => {
    over.set(key(x, y), p);
  };
  const roadAt = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < n && y < n && cur(x, y).roadType !== -1;
  const updateRoad = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    const c = cur(x, y);
    if (c.roadType < 0) return; // only cells that already have a road
    let m = 0;
    if (roadAt(x, y - 1)) m |= 1;
    if (roadAt(x, y + 1)) m |= 2;
    if (roadAt(x - 1, y)) m |= 4;
    if (roadAt(x + 1, y)) m |= 8;
    set(x, y, { value: c.value, roadType: roadTypeFromMask(m), roadVar: c.roadVar });
  };
  const updateAround = (x: number, y: number, includeSelf = false): void => {
    if (includeSelf) updateRoad(x, y);
    updateRoad(x + 1, y);
    updateRoad(x - 1, y);
    updateRoad(x, y + 1);
    updateRoad(x, y - 1);
  };
  const diff = (): EditOp[] => {
    const ops: EditOp[] = [];
    for (const [k, v] of over) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      const c = cellAt(x, y)!;
      if (v.value !== c.value || v.roadType !== c.roadType || v.roadVar !== c.roadVar) {
        ops.push({ kind: "setCell", x, y, value: v.value, roadType: v.roadType, roadVar: v.roadVar });
      }
    }
    return ops;
  };

  return { cur, set, roadAt, updateRoad, updateAround, diff };
}
