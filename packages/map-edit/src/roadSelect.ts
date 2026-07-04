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
import { applyOps } from "./ops.js";
import { roadOverlay } from "./roadOverlay.js";

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
 * TRANSLATE a selected road segment by (dx,dy): the old cells lose their road (terrain
 * kept), the target cells gain it (terrain stripped bare like roadBrush), and BOTH
 * neighbourhoods re-autotile in one batch. Returns [] when any target cell is off-map
 * (an aborted drop keeps the original road — the UI keeps the selection carried).
 */
export function translateRoadCells(
  doc: MapDocument,
  cells: readonly Cell[],
  dx: number,
  dy: number,
): EditOp[] {
  if ((dx === 0 && dy === 0) || cells.length === 0) return [];
  const n = doc.size;
  const cellAt = (x: number, y: number) => doc.terrain.cells[y * n + x];
  const key = (x: number, y: number) => `${x},${y}`;
  const oldSet = new Set(cells.map((c) => key(c.x, c.y)));
  const newCells = cells.map((c) => ({ x: c.x + dx, y: c.y + dy }));
  if (newCells.some((c) => c.x < 0 || c.y < 0 || c.x >= n || c.y >= n)) return [];
  const newSet = new Set(newCells.map((c) => key(c.x, c.y)));

  const ov = roadOverlay(doc);
  // old cells that are NOT re-covered lose the road (terrain value kept)
  for (const c of cells) {
    if (newSet.has(key(c.x, c.y))) continue;
    ov.set(c.x, c.y, { value: cellAt(c.x, c.y)!.value, roadType: -1, roadVar: -1 });
  }
  // target cells gain the road: bare terrain (roadBrush semantics), roadVar CARRIED from
  // the source cell (preserves the segment's look at the new place)
  for (const c of cells) {
    const t = { x: c.x + dx, y: c.y + dy };
    const wasRoad = oldSet.has(key(t.x, t.y));
    const src = cellAt(c.x, c.y)!;
    const tgt = cellAt(t.x, t.y)!;
    ov.set(t.x, t.y, {
      value: wasRoad ? tgt.value : tgt.value & 7,
      roadType: 0, // placeholder — the mask pass below recomputes the piece
      roadVar: src.roadVar >= 0 ? src.roadVar : 0,
    });
  }
  for (const c of newCells) ov.updateAround(c.x, c.y, true);
  for (const c of cells) ov.updateAround(c.x, c.y);
  return ov.diff();
}

/** The axis-first L-path from→to (inclusive): horizontal run, then vertical. */
export function lPath(from: Cell, to: Cell): Cell[] {
  const out: Cell[] = [];
  const sx = Math.sign(to.x - from.x);
  for (let x = from.x; x !== to.x; x += sx) out.push({ x, y: from.y });
  const sy = Math.sign(to.y - from.y);
  for (let y = from.y; y !== to.y; y += sy) out.push({ x: to.x, y });
  out.push({ x: to.x, y: to.y });
  return out;
}

/**
 * EXTEND the road with an L-path from a cell (typically a selection endpoint) to `to`:
 * road is placed on every non-road path cell (terrain stripped bare, like roadBrush),
 * then the path + its ring re-autotile — joints with existing roads come out right.
 * Terrain never blocks (roadBrush semantics). Returns [] for an off-map target.
 */
export function extendRoadPath(doc: MapDocument, from: Cell, to: Cell): EditOp[] {
  const n = doc.size;
  if (to.x < 0 || to.y < 0 || to.x >= n || to.y >= n) return [];
  if (from.x < 0 || from.y < 0 || from.x >= n || from.y >= n) return [];
  const path = lPath(from, to);
  const cellAt = (x: number, y: number) => doc.terrain.cells[y * n + x];
  const ov = roadOverlay(doc);
  for (const c of path) {
    if (ov.cur(c.x, c.y).roadType !== -1) continue; // already road — keep as-is
    ov.set(c.x, c.y, { value: cellAt(c.x, c.y)!.value & 7, roadType: 0, roadVar: 0 });
  }
  for (const c of path) ov.updateAround(c.x, c.y, true);
  return ov.diff();
}

/**
 * The ENTRANCE cell of a fort at `pos` with footprint `size` (4 village / 5 capital):
 * byte-derived over every shipped campaign map (742 forts, 347 with an adjacent road
 * end) — road terminals cluster at pos+(size,size), the cell diagonally OUTSIDE the
 * footprint's SE corner; (size,size-1)/(size-1,size) are the hugging fallbacks.
 * `find` locates the EXISTING attachment among the three; absent = no road attached.
 */
export function fortEntrance(pos: Cell, size: number): Cell {
  return { x: pos.x + size, y: pos.y + size };
}
function findAttachedEntrance(doc: MapDocument, pos: Cell, size: number): Cell | null {
  const n = doc.size;
  const isRoad = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < n && y < n && (doc.terrain.cells[y * n + x]?.roadType ?? -1) >= 0;
  const candidates: Cell[] = [
    { x: pos.x + size, y: pos.y + size },
    { x: pos.x + size, y: pos.y + size - 1 },
    { x: pos.x + size - 1, y: pos.y + size },
  ];
  return candidates.find((c) => isRoad(c.x, c.y)) ?? null;
}

/**
 * RE-ROUTE the road serving a fort when the fort moves («дорога следует за входом»):
 * walk the attached strand from the OLD entrance to its first bend/fork/end B, erase
 * the E0..B tail (exclusive of B), then extend an L-path B → NEW entrance. Composed
 * SEQUENTIALLY (erase ops applied to a working doc before planning the extension) so
 * the two overlays never fight over shared ring cells. Returns [] when no road is
 * attached at the old entrance or the new entrance is off-map — the move still happens,
 * the road just stays put (fail-soft: this is convenience, not integrity).
 */
export function rerouteRoadOps(
  doc: MapDocument,
  oldPos: Cell,
  newPos: Cell,
  size: number,
): EditOp[] {
  const e0 = findAttachedEntrance(doc, oldPos, size);
  if (!e0) return [];
  const e1 = fortEntrance(newPos, size);
  if (e1.x < 0 || e1.y < 0 || e1.x >= doc.size || e1.y >= doc.size) return [];

  // Walk the ROAD GRAPH from E0 to the first bend: step along the single onward road
  // neighbour until the NEXT cell is a corner / fork / dead-end — that cell is the bend B
  // (it stays put); everything walked before it (E0..B-exclusive) is the erased tail.
  const n = doc.size;
  const isRoad = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < n && y < n && (doc.terrain.cells[y * n + x]?.roadType ?? -1) >= 0;
  const N4 = [
    { x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 },
  ];
  const roadNb = (c: Cell): Cell[] =>
    N4.map((d) => ({ x: c.x + d.x, y: c.y + d.y })).filter((p) => isRoad(p.x, p.y));
  const isStraightThrough = (c: Cell): boolean => {
    const nb = roadNb(c);
    if (nb.length !== 2) return false;
    return (isRoad(c.x - 1, c.y) && isRoad(c.x + 1, c.y)) || (isRoad(c.x, c.y - 1) && isRoad(c.x, c.y + 1));
  };

  const tail: Cell[] = [];
  let prev: Cell | null = null;
  let cur: Cell = e0;
  for (;;) {
    const nexts = roadNb(cur).filter((p) => !(prev && p.x === prev.x && p.y === prev.y));
    if (nexts.length !== 1) break; // cur itself is a fork boundary / isolated end
    const nxt = nexts[0]!;
    if (!isStraightThrough(nxt)) { tail.push(cur); cur = nxt; break; } // nxt = the bend B
    tail.push(cur);
    prev = cur;
    cur = nxt;
  }
  const bend = cur; // stays in place; only the E0..bend-exclusive tail is erased

  // nothing to move (the entrance IS the bend/junction) -> just extend from it
  const ops1 = tail.length ? eraseRoadCells(doc, tail) : [];
  const d2 = ops1.length ? applyOps(doc, ops1) : doc;
  const ops2 = extendRoadPath(d2, bend, e1);
  return [...ops1, ...ops2];
}

/**
 * Erase the road on every cell in `cells` (terrain kept), then recompute the road piece
 * of the surrounding cells so severed roads retune (a through-road becomes an end, …).
 * Returns setCell ops with roadType/roadVar; the cell `value` (terrain) is unchanged.
 */
export function eraseRoadCells(doc: MapDocument, cells: readonly Cell[]): EditOp[] {
  const n = doc.size;
  const cellAt = (x: number, y: number) => doc.terrain.cells[y * n + x];
  const ov = roadOverlay(doc);

  // erase the selected road cells (keep terrain value) — overlaid -1 also makes them
  // read as "no road" for the ring recompute below (no separate excluded-set needed)
  for (const c of cells) {
    if (c.x < 0 || c.y < 0 || c.x >= n || c.y >= n) continue;
    const cell = cellAt(c.x, c.y)!;
    ov.set(c.x, c.y, { value: cell.value, roadType: -1, roadVar: -1 });
  }
  // recompute the ring of road cells around the erased set
  for (const c of cells) ov.updateAround(c.x, c.y);
  return ov.diff();
}
