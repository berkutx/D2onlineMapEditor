import { describe, it, expect } from "vitest";
import { tileZone, tilesCover, zoneLocationOps, type ZoneTile } from "../src/zones";
import type { MapDocument } from "@d2/map-schema";

const key = (x: number, y: number): string => `${x},${y}`;
const rect = (x0: number, y0: number, w: number, h: number): Set<string> => {
  const s = new Set<string>();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) s.add(key(x, y));
  return s;
};
/** Every tile square must be a SUBSET of the mask (exact trigger semantics). */
const allInside = (tiles: ZoneTile[], mask: Set<string>): boolean =>
  tiles.every((t) => {
    for (let y = t.y - t.r; y <= t.y + t.r; y++)
      for (let x = t.x - t.r; x <= t.x + t.r; x++) if (!mask.has(key(x, y))) return false;
    return true;
  });
const coversExactly = (tiles: ZoneTile[], mask: Set<string>): boolean => {
  const cov = tilesCover(tiles);
  if (cov.size !== mask.size) return false;
  for (const k of mask) if (!cov.has(k)) return false;
  return true;
};

describe("@d2/map-edit zones — greedy square tiling", () => {
  it("10×10 square = 4 perfect 5×5 tiles", () => {
    const mask = rect(0, 0, 10, 10);
    const tiles = tileZone(mask);
    expect(tiles).toHaveLength(4);
    expect(tiles.every((t) => t.r === 2)).toBe(true);
    expect(allInside(tiles, mask)).toBe(true);
    expect(coversExactly(tiles, mask)).toBe(true);
  });

  it("1-wide line = one 1×1 per cell (worst case, still exact)", () => {
    const mask = new Set([key(5, 5), key(6, 5), key(7, 5), key(8, 5), key(9, 5)]);
    const tiles = tileZone(mask);
    expect(tiles).toHaveLength(5);
    expect(tiles.every((t) => t.r === 0)).toBe(true);
    expect(coversExactly(tiles, mask)).toBe(true);
  });

  it("1-wide ring (12×12 frame): exact cover, no tile leaks outside", () => {
    const outer = rect(0, 0, 12, 12);
    const inner = rect(1, 1, 10, 10);
    const mask = new Set([...outer].filter((k) => !inner.has(k)));
    const tiles = tileZone(mask);
    expect(allInside(tiles, mask)).toBe(true);
    expect(coversExactly(tiles, mask)).toBe(true);
    expect(tiles.every((t) => t.r === 0)).toBe(true); // 1-wide ring can't fit 3×3
  });

  it("L-blob: exact cover with mixed tile sizes, count within sane bounds", () => {
    const mask = new Set([...rect(0, 0, 12, 6), ...rect(0, 6, 6, 8)]);
    const tiles = tileZone(mask);
    expect(allInside(tiles, mask)).toBe(true);
    expect(coversExactly(tiles, mask)).toBe(true);
    // area 12*6 + 6*8 = 120; perfect 5×5 cover would be ~5-6 tiles; greedy with the
    // 1-2 cell rim stays well under per-cell worst case
    expect(tiles.length).toBeGreaterThanOrEqual(5);
    expect(tiles.length).toBeLessThanOrEqual(30);
    expect(tiles.some((t) => t.r === 2)).toBe(true);
  });

  it("zoneLocationOps: fresh LO ids, center+radius from tiles, «имя · k» naming", () => {
    const doc = {
      header: { version: "S143" },
      objects: [
        { type: "location", id: "S143LO000a", pos: { x: 1, y: 1 } },
        { type: "stack", id: "S143KC0001", pos: { x: 2, y: 2 } },
      ],
    } as unknown as MapDocument;
    const tiles: ZoneTile[] = [
      { x: 10, y: 10, r: 2 },
      { x: 14, y: 10, r: 1 },
    ];
    const { ops, locIds } = zoneLocationOps(doc, "Болото", tiles);
    expect(locIds).toEqual(["S143LO000b", "S143LO000c"]); // max existing 0x0a + 1
    expect(ops).toHaveLength(2);
    const o0 = (ops[0] as { object: { name: string; radius: number; pos: { x: number } } }).object;
    expect(o0.name).toBe("Болото · 1");
    expect(o0.radius).toBe(2);
    expect(o0.pos.x).toBe(10);
  });
});
