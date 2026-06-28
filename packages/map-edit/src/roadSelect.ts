/**
 * Road segment selection — a graph traversal over connected road cells, mirroring the
 * "click selects to the corner/fork, click again to the next fork" idea.
 *
 * A road cell = `roadType >= 0`. Neighbours are the 4 orthogonal road cells; `degree`
 * is how many a cell has. A cell is a FORK when degree >= 3, a CORNER when degree == 2
 * with non-opposite neighbours, a STRAIGHT when degree == 2 with opposite neighbours,
 * an END when degree <= 1.
 *
 * Selection levels (each click bumps the level for the same start cell):
 *   0  the straight run up to (and incl.) corners/ends, stopping BEFORE forks.
 *   1  the whole strand between junctions — passes through corners, stops before forks.
 *   2  the entire connected road component (forks included).
 */
import type { MapDocument } from "@d2/map-schema";
import type { EditOp } from "./ops.js";
import { roadTypeFromMask } from "./brush.js";

export interface Cell {
  x: number;
  y: number;
}

/** Cells of the road segment containing (cx,cy) at the given `level` (0/1/2). */
export function selectRoadSegment(
  doc: MapDocument,
  cx: number,
  cy: number,
  level: number,
): Cell[] {
  const n = doc.size;
  const cellAt = (x: number, y: number) => doc.terrain.cells[y * n + x];
  const isRoad = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < n && y < n && (cellAt(x, y)?.roadType ?? -1) >= 0;
  if (!isRoad(cx, cy)) return [];

  const N4: Cell[] = [
    { x: 0, y: -1 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
  ];
  const roadNeighbours = (x: number, y: number): Cell[] =>
    N4.map((d) => ({ x: x + d.x, y: y + d.y })).filter((c) => isRoad(c.x, c.y));
  const degree = (x: number, y: number): number => roadNeighbours(x, y).length;
  const isStraight = (x: number, y: number): boolean => {
    if (degree(x, y) !== 2) return false;
    const lr = isRoad(x - 1, y) && isRoad(x + 1, y);
    const ud = isRoad(x, y - 1) && isRoad(x, y + 1);
    return lr || ud; // exactly-2 + opposite => a straight pass-through
  };

  // Can the selection be ADDED to include this cell? (forks excluded below level 2)
  const selectable = (x: number, y: number): boolean => level >= 2 || degree(x, y) < 3;
  // Can the selection CONTINUE through this cell (keep flooding past it)?
  const expandable = (x: number, y: number): boolean => {
    if (level >= 2) return true;
    if (level === 1) return degree(x, y) <= 2; // through straights + corners, stop at forks
    return isStraight(x, y); // level 0: only straight pass-throughs
  };

  const key = (x: number, y: number) => `${x},${y}`;
  const selected = new Set<string>([key(cx, cy)]);
  const stack: Cell[] = [{ x: cx, y: cy }];
  while (stack.length) {
    const c = stack.pop()!;
    const isStart = c.x === cx && c.y === cy;
    if (!isStart && !expandable(c.x, c.y)) continue; // boundary cell: kept, doesn't expand
    for (const nb of roadNeighbours(c.x, c.y)) {
      const k = key(nb.x, nb.y);
      if (selected.has(k)) continue;
      if (!selectable(nb.x, nb.y) && !(nb.x === cx && nb.y === cy)) continue;
      selected.add(k);
      stack.push(nb);
    }
  }
  return [...selected].map((k) => {
    const [x, y] = k.split(",").map(Number) as [number, number];
    return { x, y };
  });
}

/**
 * Erase the road on every cell in `cells` (terrain kept), then recompute the road piece
 * of the surrounding cells so severed roads retune (a through-road becomes an end, …).
 * Returns setCell ops with roadType/roadVar; the cell `value` (terrain) is unchanged.
 */
export function eraseRoadCells(doc: MapDocument, cells: readonly Cell[]): EditOp[] {
  const n = doc.size;
  const cellAt = (x: number, y: number) => doc.terrain.cells[y * n + x];
  const key = (x: number, y: number) => `${x},${y}`;
  const removed = new Set(cells.map((c) => key(c.x, c.y)));
  const over = new Map<string, { value: number; roadType: number; roadVar: number }>();
  const cur = (x: number, y: number) => {
    const o = over.get(key(x, y));
    if (o) return o;
    const c = cellAt(x, y)!;
    return { value: c.value, roadType: c.roadType, roadVar: c.roadVar };
  };
  const roadAt = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < n && y < n && !removed.has(key(x, y)) && cur(x, y).roadType !== -1;

  // erase the selected road cells (keep terrain value)
  for (const c of cells) {
    if (c.x < 0 || c.y < 0 || c.x >= n || c.y >= n) continue;
    const cell = cellAt(c.x, c.y)!;
    over.set(key(c.x, c.y), { value: cell.value, roadType: -1, roadVar: -1 });
  }
  // recompute the ring of road cells around the erased set
  const updateRoad = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= n || y >= n || removed.has(key(x, y))) return;
    const c = cur(x, y);
    if (c.roadType < 0) return;
    let m = 0;
    if (roadAt(x, y - 1)) m |= 1;
    if (roadAt(x, y + 1)) m |= 2;
    if (roadAt(x - 1, y)) m |= 4;
    if (roadAt(x + 1, y)) m |= 8;
    over.set(key(x, y), { value: c.value, roadType: roadTypeFromMask(m), roadVar: c.roadVar });
  };
  for (const c of cells) {
    updateRoad(c.x + 1, c.y);
    updateRoad(c.x - 1, c.y);
    updateRoad(c.x, c.y + 1);
    updateRoad(c.x, c.y - 1);
  }

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
