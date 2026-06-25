import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { MapDocument } from "@d2/map-schema";
import type { TerrainIndex } from "@d2/asset-manifest";

import {
  TILE_W,
  HALF_W,
  HALF_H,
  isoX,
  isoY,
  cellToWorld,
  worldToCell,
  mapWorldBounds,
} from "../src/iso";
import {
  variantSeed,
  cellAt,
  selectTerrain,
  selectAllTerrain,
} from "../src/terrainSelect";
import { BANDS, typeRank, frontCell, zKey, compareZ, sortByZ } from "../src/zorder";
import {
  visibleCellRect,
  rectContains,
  objectInRect,
  visibleObjects,
} from "../src/Culler";

const FIXTURE = resolve(__dirname, "../../../fixtures/map-json/mock-min.json");
const doc = MapDocument.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));

describe("iso", () => {
  it("has the documented tile geometry", () => {
    expect(TILE_W).toBe(64);
    expect(HALF_W).toBe(32);
    expect(HALF_H).toBe(16);
  });

  it("matches the Contract-A scalar transform", () => {
    expect(isoX(3, 1)).toBe(2);
    expect(isoY(3, 1)).toBe(2);
  });

  it("projects cells to world centers", () => {
    expect(cellToWorld(0, 0)).toEqual({ x: 0, y: 0 });
    expect(cellToWorld(1, 0)).toEqual({ x: 32, y: 16 });
    expect(cellToWorld(0, 1)).toEqual({ x: -32, y: 16 });
    expect(cellToWorld(2, 3)).toEqual({ x: (2 - 3) * 32, y: (2 + 3) * 16 });
  });

  it("worldToCell inverts cellToWorld", () => {
    for (const [cx, cy] of [
      [0, 0],
      [5, 2],
      [10, 10],
      [3, 7],
    ]) {
      const w = cellToWorld(cx, cy);
      const back = worldToCell(w.x, w.y);
      expect(back.x).toBeCloseTo(cx, 9);
      expect(back.y).toBeCloseTo(cy, 9);
    }
  });

  it("computes a padded world AABB for a size×size map", () => {
    const b = mapWorldBounds(2);
    // extreme centers for size=2: left cell (0,1) x=-32, right cell (1,0) x=32,
    // top (0,0) y=0, bottom (1,1) y=32 ; padded by half tile.
    expect(b.minX).toBe(-32 - 32);
    expect(b.maxX).toBe(32 + 32);
    expect(b.minY).toBe(-16);
    expect(b.maxY).toBe(32 + 16);
    expect(b.width).toBe(b.maxX - b.minX);
    expect(b.height).toBe(b.maxY - b.minY);
  });
});

describe("terrainSelect", () => {
  it("variantSeed uses (x*y + x + y) % n deterministically", () => {
    expect(variantSeed(0, 0, 4)).toBe(0);
    expect(variantSeed(2, 3, 4)).toBe((2 * 3 + 2 + 3) % 4); // 11 % 4 = 3
    expect(variantSeed(5, 5, 1)).toBe(0);
    expect(variantSeed(5, 5, 0)).toBe(0); // n<=0 guard
    // deterministic / repeatable
    expect(variantSeed(7, 9, 6)).toBe(variantSeed(7, 9, 6));
  });

  it("cellAt is grid-bounded", () => {
    expect(cellAt(doc.terrain, 0, 0)?.x).toBe(0);
    expect(cellAt(doc.terrain, -1, 0)).toBeUndefined();
    expect(cellAt(doc.terrain, 2, 0)).toBeUndefined();
  });

  const terrain: TerrainIndex = {
    tileW: 192,
    base: { "0": ["G0_a", "G0_b"], "3": ["water0"], water: ["water0"] },
    borders: { "3_S": ["wbS"], water: ["wb"], "0_N": ["g0N"] },
    roads: { "0": ["road0", "road1"] },
    forest: { "3": "forest3" },
    seedFormula: "(x*y + x + y) % n",
  };

  it("picks a base variant by seed", () => {
    const cell = cellAt(doc.terrain, 0, 0)!; // ground 0
    const s = selectTerrain(doc.terrain, cell, terrain);
    // variantSeed(0,0,2) = 0 -> "G0_a"
    expect(s.base).toBe("G0_a");
  });

  it("emits a border where a neighbour's blend class differs", () => {
    // cell (1,1) is water (ground 3); its neighbours (1,0) and (0,1) are land(0).
    const water = cellAt(doc.terrain, 1, 1)!;
    const s = selectTerrain(doc.terrain, water, terrain);
    // neighbours N=(1,0) land, W=(0,1) land -> land bleeding in -> "0_N" / fallback
    expect(s.borders.length).toBeGreaterThan(0);
    // no border toward off-map edges
    expect(s.base).toBe("water0");
  });

  it("emits road only when roadType >= 0", () => {
    const road = cellAt(doc.terrain, 1, 0)!; // roadType 0, roadVar 0
    const noRoad = cellAt(doc.terrain, 0, 0)!; // roadType -1
    expect(selectTerrain(doc.terrain, road, terrain).road).toBe("road0");
    expect(selectTerrain(doc.terrain, noRoad, terrain).road).toBeUndefined();
  });

  it("emits forest only when forest > 0", () => {
    const forestCell = cellAt(doc.terrain, 0, 1)!; // forest 3
    const s = selectTerrain(doc.terrain, forestCell, terrain);
    expect(s.forest).toBe("forest3");
  });

  it("is fully deterministic over the whole grid", () => {
    const a = selectAllTerrain(doc.terrain, terrain);
    const b = selectAllTerrain(doc.terrain, terrain);
    expect(a).toEqual(b);
    expect(a).toHaveLength(doc.terrain.cells.length);
  });

  it("returns empty stamps when no terrain index is provided", () => {
    const cell = cellAt(doc.terrain, 0, 0)!;
    const s = selectTerrain(doc.terrain, cell, undefined);
    expect(s.base).toBeUndefined();
    expect(s.borders).toEqual([]);
  });
});

describe("zorder", () => {
  it("ranks mobile stacks above flat ground features", () => {
    expect(typeRank("stack")).toBeGreaterThan(typeRank("crystal"));
    expect(typeRank("capital")).toBeGreaterThan(typeRank("ruin"));
  });

  it("front cell of a multi-tile object is the max x+y corner", () => {
    const village = doc.objects.find((o) => o.type === "village")!;
    // footprint 2x2 at (0,0) -> front (1,1)
    expect(frontCell(village)).toEqual({ x: 1, y: 1 });
  });

  it("higher diagonal band always outranks a lower band regardless of type", () => {
    // a generic (low type rank) one band further front must still sort later
    // than a stack (high type rank) one band back.
    const stackBack = { type: "stack", id: "S", pos: { x: 0, y: 0 } } as any;
    const genericFront = { type: "generic", id: "G", pos: { x: 1, y: 0 }, blockType: "X", raw: {} } as any;
    expect(zKey(genericFront)).toBeGreaterThan(zKey(stackBack));
    expect(BANDS).toBeGreaterThan(typeRank("stack"));
  });

  it("sorts back-to-front, stable by id on ties", () => {
    const sorted = sortByZ(doc.objects);
    for (let i = 1; i < sorted.length; i++) {
      expect(compareZ(sorted[i - 1]!, sorted[i]!)).toBeLessThanOrEqual(0);
    }
  });
});

describe("Culler", () => {
  it("inverts a world viewport to a clamped cell rect", () => {
    // a viewport covering the whole 2x2 map
    const rect = visibleCellRect(
      { x: -300, y: -100, width: 600, height: 400 },
      2,
      1,
    );
    expect(rect.minX).toBe(0);
    expect(rect.minY).toBe(0);
    expect(rect.maxX).toBe(1);
    expect(rect.maxY).toBe(1);
  });

  it("clamps to the grid and never goes negative", () => {
    const rect = visibleCellRect(
      { x: 100000, y: 100000, width: 10, height: 10 },
      2,
      0,
    );
    expect(rect.minX).toBeGreaterThanOrEqual(0);
    expect(rect.maxX).toBeLessThanOrEqual(1);
    expect(rect.minY).toBeGreaterThanOrEqual(0);
    expect(rect.maxY).toBeLessThanOrEqual(1);
  });

  it("rectContains and objectInRect agree on a contained object", () => {
    const rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    expect(rectContains(rect, 1, 1)).toBe(true);
    expect(rectContains(rect, 2, 0)).toBe(false);
    const village = doc.objects.find((o) => o.type === "village")!;
    expect(objectInRect(village, rect)).toBe(true);
  });

  it("excludes objects fully outside the rect", () => {
    const rect = { minX: 10, minY: 10, maxX: 12, maxY: 12 };
    expect(visibleObjects(doc.objects, rect)).toHaveLength(0);
  });

  it("includes a multi-tile object that straddles the rect edge", () => {
    const rect = { minX: 1, minY: 1, maxX: 3, maxY: 3 };
    // village footprint (0,0)-(1,1) overlaps the rect at corner (1,1)
    const village = doc.objects.find((o) => o.type === "village")!;
    expect(objectInRect(village, rect)).toBe(true);
  });
});
