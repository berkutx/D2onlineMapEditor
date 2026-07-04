/**
 * Free-form ZONES → game MidLocation primitives. The editor lets the user draw an
 * arbitrary cell mask; the game only has (2r+1)² SQUARE locations (r = 0..3 → 1×1..7×7,
 * byte-verified — see MAX_TILE_RADIUS). This module tiles the mask with overlapping
 * squares so that:
 *   - every mask cell is covered (the zone triggers everywhere it was drawn), and
 *   - every tile is a SUBSET of the mask (cells outside the drawing never trigger) —
 *     overlap is legal: locations are exempt from occupancy (Riders ships 418).
 *
 * Algorithm: Chebyshev distance transform (largest r whose square fits inside the mask,
 * two-pass chamfer), then a greedy cover — for each uncovered cell pick the candidate
 * center within reach that (a) has the largest usable r, (b) covers the most uncovered
 * cells. O(cells · (2rMax+1)⁴) worst case — fine for hand-drawn zones (≤ a few thousand
 * cells).
 */
import type { MapDocument } from "@d2/map-schema";
import type { EditOp } from "./ops.js";

export interface ZoneTile {
  /** CENTER cell of the location (MidLocation POS is the center). */
  x: number;
  y: number;
  /** radius: 0=1×1, 1=3×3, 2=5×5, 3=7×7. */
  r: number;
}

/**
 * The largest location radius PROVEN safe for the game + native ScenEdit (byte-verified
 * 2026-07-04): the ScenEdit location dialog offers exactly 1×1/3×3/5×5/7×7 (RADIUS =
 * spin index 0..3), the reference Qt editor whitelists the same four, and across 54
 * shipped campaign .sg maps (1877 locations) the global max RADIUS is 3. The format
 * stores int32 with no clamp, but r≥4 risks an out-of-range spin index in ScenEdit —
 * don't emit it.
 */
export const MAX_TILE_RADIUS = 3;

/** Parse "x,y" keys into coords + bbox. */
function parseMask(cells: ReadonlySet<string>): {
  pts: { x: number; y: number }[];
  x0: number;
  y0: number;
  w: number;
  h: number;
} {
  const pts = [...cells].map((k) => {
    const [x, y] = k.split(",").map(Number) as [number, number];
    return { x, y };
  });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { pts, x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Tile the mask with overlapping in-mask squares of radius ≤ rMax. Deterministic
 * (scanline order). Returns center+radius tiles; `tilesCover(tiles)` == the mask.
 */
export function tileZone(cells: ReadonlySet<string>, rMax = MAX_TILE_RADIUS): ZoneTile[] {
  if (cells.size === 0) return [];
  const { pts, x0, y0, w, h } = parseMask(cells);
  const idx = (x: number, y: number): number => (y - y0) * w + (x - x0);
  const inMask = (x: number, y: number): boolean =>
    x >= x0 && y >= y0 && x < x0 + w && y < y0 + h && mask[idx(x, y)] === 1;

  const mask = new Uint8Array(w * h);
  for (const p of pts) mask[idx(p.x, p.y)] = 1;

  // Chebyshev distance-to-outside (chamfer, two passes); r(c) = dist - 1.
  const INF = 1 << 20;
  const dist = new Int32Array(w * h).fill(INF);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = idx(x, y);
      if (!mask[i]) { dist[i] = 0; continue; }
      // anything outside the mask (incl. beyond the bbox) is distance 0
      let d = INF;
      const nb = [
        [x - 1, y - 1], [x, y - 1], [x + 1, y - 1], [x - 1, y],
      ] as const;
      for (const [nx, ny] of nb) {
        const nd = inMask(nx, ny) ? dist[idx(nx, ny)]! : 0;
        if (nd + 1 < d) d = nd + 1;
      }
      dist[i] = Math.min(dist[i]!, d);
    }
  }
  for (let y = y0 + h - 1; y >= y0; y--) {
    for (let x = x0 + w - 1; x >= x0; x--) {
      const i = idx(x, y);
      if (!mask[i]) continue;
      let d = dist[i]!;
      const nb = [
        [x + 1, y + 1], [x, y + 1], [x - 1, y + 1], [x + 1, y],
      ] as const;
      for (const [nx, ny] of nb) {
        const nd = inMask(nx, ny) ? dist[idx(nx, ny)]! : 0;
        if (nd + 1 < d) d = nd + 1;
      }
      dist[i] = d;
    }
  }
  const rOf = (x: number, y: number): number => Math.min(dist[idx(x, y)]! - 1, rMax);

  // greedy cover: scanline over mask cells; for each uncovered cell pick the best center
  const covered = new Uint8Array(w * h);
  const tiles: ZoneTile[] = [];
  const newlyCovered = (cx: number, cy: number, r: number): number => {
    let n = 0;
    for (let yy = cy - r; yy <= cy + r; yy++)
      for (let xx = cx - r; xx <= cx + r; xx++)
        if (inMask(xx, yy) && !covered[idx(xx, yy)]) n++;
    return n;
  };
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = idx(x, y);
      if (!mask[i] || covered[i]) continue;
      // candidate centers c' whose square would cover (x,y): |c'-c|∞ ≤ r(c') ≤ rMax
      let best: { cx: number; cy: number; r: number; gain: number } | null = null;
      for (let dy = -rMax; dy <= rMax; dy++) {
        for (let dx = -rMax; dx <= rMax; dx++) {
          const cx = x + dx, cy = y + dy;
          if (!inMask(cx, cy)) continue;
          const r = rOf(cx, cy);
          if (r < Math.max(Math.abs(dx), Math.abs(dy))) continue; // doesn't reach (x,y)
          const gain = newlyCovered(cx, cy, r);
          if (!best || r > best.r || (r === best.r && gain > best.gain)) {
            best = { cx, cy, r, gain };
          }
        }
      }
      // (x,y) is in the mask so at minimum itself (r=0) qualifies
      const t = best ?? { cx: x, cy: y, r: 0, gain: 1 };
      tiles.push({ x: t.cx, y: t.cy, r: t.r });
      for (let yy = t.cy - t.r; yy <= t.cy + t.r; yy++)
        for (let xx = t.cx - t.r; xx <= t.cx + t.r; xx++)
          if (inMask(xx, yy)) covered[idx(xx, yy)] = 1;
    }
  }
  return tiles;
}

/** The exact cell set a tile list covers (for tests + UI checks). */
export function tilesCover(tiles: readonly ZoneTile[]): Set<string> {
  const out = new Set<string>();
  for (const t of tiles)
    for (let y = t.y - t.r; y <= t.y + t.r; y++)
      for (let x = t.x - t.r; x <= t.x + t.r; x++) out.add(`${x},${y}`);
  return out;
}

/** Live counter while drawing (same greedy — cheap for hand-drawn masks). */
export function estimateTileCount(cells: ReadonlySet<string>, rMax = MAX_TILE_RADIUS): number {
  return tileZone(cells, rMax).length;
}

/**
 * Ops materializing a zone's tiles as named MidLocation objects («<имя> · k»). Ids are
 * allocated HERE (max existing LO + 1, like placeLocationOps) so model and export agree.
 * Returns the ops AND the allocated ids (the project's zone record tracks them for regen).
 */
export function zoneLocationOps(
  doc: MapDocument,
  name: string,
  tiles: readonly ZoneTile[],
): { ops: EditOp[]; locIds: string[] } {
  const version = doc.header.version || "S143";
  let max = -1;
  for (const o of doc.objects) {
    if (o.type === "location") {
      const m = /LO([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) max = Math.max(max, parseInt(m[1]!, 16));
    }
  }
  const hex4 = (n: number): string => (n >>> 0).toString(16).padStart(4, "0");
  const ops: EditOp[] = [];
  const locIds: string[] = [];
  tiles.forEach((t, i) => {
    const id = `${version}LO${hex4(max + 1 + i)}`;
    locIds.push(id);
    ops.push({
      kind: "addObject",
      object: {
        type: "location",
        id,
        pos: { x: t.x, y: t.y },
        name: tiles.length > 1 ? `${name} · ${i + 1}` : name,
        radius: t.r,
      },
    });
  });
  return { ops, locIds };
}
