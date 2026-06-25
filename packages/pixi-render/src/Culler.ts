/**
 * View culling: given a camera viewport in WORLD space, decide which terrain cells
 * and which objects are (approximately) visible, so the renderer only stamps /
 * animates what is on screen.
 *
 * PURE module — no `pixi.js` import. Operates purely on numbers and Contract types.
 *
 * Strategy: an iso diamond's world AABB maps to a cartesian cell AABB. We invert
 * the four viewport corners through {@link worldToCell}, take the min/max cell, pad
 * by a margin, and clamp to the grid. This over-selects slightly (it is a bounding
 * rectangle in cell space, not the exact rotated region) which is the correct,
 * conservative behaviour for culling.
 */
import type { MapObject } from "@d2/map-schema";
import { worldToCell } from "./iso.js";
import { frontCell } from "./zorder.js";

/** A camera viewport expressed in world-space pixels (the visible rectangle). */
export interface ViewportWorld {
  /** world-space x of the viewport's left edge */
  x: number;
  /** world-space y of the viewport's top edge */
  y: number;
  /** world-space width of the viewport (screen width / zoom) */
  width: number;
  /** world-space height of the viewport (screen height / zoom) */
  height: number;
}

/** Inclusive cell rectangle [minX..maxX] × [minY..maxY], already grid-clamped. */
export interface CellRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Compute the inclusive, grid-clamped cell rectangle covering a world viewport.
 *
 * @param view    viewport in world space
 * @param size    map size (size × size cells)
 * @param margin  extra cells to include on every side (default 2) so partially
 *                visible / tall sprites near the edge are not popped.
 */
export function visibleCellRect(
  view: ViewportWorld,
  size: number,
  margin = 2,
): CellRect {
  const corners = [
    worldToCell(view.x, view.y),
    worldToCell(view.x + view.width, view.y),
    worldToCell(view.x, view.y + view.height),
    worldToCell(view.x + view.width, view.y + view.height),
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }

  const last = size - 1;
  return {
    minX: clamp(Math.floor(minX) - margin, 0, last),
    minY: clamp(Math.floor(minY) - margin, 0, last),
    maxX: clamp(Math.ceil(maxX) + margin, 0, last),
    maxY: clamp(Math.ceil(maxY) + margin, 0, last),
  };
}

/** True if a cell rect contains the given cell. */
export function rectContains(rect: CellRect, x: number, y: number): boolean {
  return x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
}

/**
 * True if an object should be considered visible for a given cell rect. We test
 * the object's footprint span against the rect (an object straddling the edge is
 * visible). Uses the back corner `pos` and the front corner for the span.
 */
export function objectInRect(obj: MapObject, rect: CellRect): boolean {
  const back = obj.pos;
  const front = frontCell(obj);
  // AABB overlap between [back..front] footprint and the cell rect.
  const objMinX = Math.min(back.x, front.x);
  const objMaxX = Math.max(back.x, front.x);
  const objMinY = Math.min(back.y, front.y);
  const objMaxY = Math.max(back.y, front.y);
  return (
    objMaxX >= rect.minX &&
    objMinX <= rect.maxX &&
    objMaxY >= rect.minY &&
    objMinY <= rect.maxY
  );
}

/** Filter an object list to those overlapping the visible cell rect. */
export function visibleObjects(
  objects: readonly MapObject[],
  rect: CellRect,
): MapObject[] {
  return objects.filter((o) => objectInRect(o, rect));
}
