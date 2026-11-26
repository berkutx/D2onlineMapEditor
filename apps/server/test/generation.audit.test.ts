/**
 * Generation MECHANICS audit — the regression net for the recipe overhaul: every recipe
 * runs through the REAL server executor (runGenerationSteps) on Riders.sg, and the result
 * must respect the game-mechanics invariants the validator can't see:
 *   - no existing object ends up on water (drowning);
 *   - no generated object overlaps an existing one (footprint-aware);
 *   - no road cell stays on water;
 *   - ribbon recipes (river/road/ridge) CROSS their zone;
 *   - maze grids are sealed with exactly 1–2 cut entrances;
 *   - seeded recipes produce output even on small zones.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseScenario } from "@d2/sg-parser";
import {
  applyOps,
  buildWallSet,
  buildDecorSet,
  buildOccupiedSet,
  type WallSet,
  type DecorSet,
  type EditOp,
} from "@d2/map-edit";
import { RECIPES } from "@d2/mapgen";
import type { MapDocument } from "@d2/map-schema";
import { mazeLatticeSide, recipePreview, runGenerationSteps, sealMazeGrid, widenMazeGrid } from "../src/maps/generation";
import { config } from "../src/config";
import { campaignMap } from "../../../test-helpers/gameDir";

let doc: MapDocument;
let walls: WallSet;
let decor: DecorSet;
let landmarkSizes: Record<string, readonly [number, number]>;

const REGION = { x: 20, y: 20, w: 24, h: 10 };
const SEEDS = [1, 7];

beforeAll(async () => {
  const bytes = await readFile(campaignMap(join("The Power of Eldunari-v1-2 maps", "Riders.sg")));
  doc = parseScenario(new Uint8Array(bytes));
  const catalog = JSON.parse(
    await readFile(join(config.ASSETS_DIR, "decorCatalog.json"), "utf-8"),
  ) as { id: string; cx?: number; cy?: number }[] | Record<string, { id: string; cx?: number; cy?: number }>;
  walls = buildWallSet(catalog as never);
  decor = buildDecorSet(catalog as never);
  landmarkSizes = {};
  const entries = Array.isArray(catalog) ? catalog : Object.values(catalog);
  for (const e of entries) landmarkSizes[e.id.toUpperCase()] = [e.cx ?? 1, e.cy ?? 1];
});

const isWater = (v: number): boolean => ((v >> 3) & 7) === 3;

/** Footprint of an object in the RESULT doc (same tables the guard uses). */
function footprint(o: { type: string; pos: { x: number; y: number } } & Record<string, unknown>): string[] {
  const sizes: Record<string, [number, number]> = {
    village: [4, 4], fort: [4, 4], capital: [5, 5],
    merchant: [3, 3], mage: [3, 3], trainer: [3, 3], mercenary: [3, 3], ruin: [3, 3],
  };
  let w = 1, h = 1;
  if (o.type === "mountains") { w = (o.w as number) ?? 1; h = (o.h as number) ?? 1; }
  else if (o.type === "landmark") {
    const sz = landmarkSizes[String(o.baseType ?? "").toUpperCase()];
    if (sz) [w, h] = sz as [number, number];
  } else if (sizes[o.type]) [w, h] = sizes[o.type]!;
  const out: string[] = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push(`${o.pos.x + dx},${o.pos.y + dy}`);
  return out;
}

async function run(recipeId: string, seed: number, region = REGION, sealed?: boolean): Promise<{ ops: EditOp[]; after: MapDocument }> {
  const ops = await runGenerationSteps(doc, [{ recipeId, region, seed, sealed }], walls, seed, undefined, false, decor, landmarkSizes);
  return { ops, after: applyOps(doc, ops) };
}

/** Mechanics invariants shared by every recipe run. */
function assertMechanics(recipeId: string, seed: number, ops: EditOp[], after: MapDocument): void {
  const n = after.size;
  const label = `${recipeId} seed=${seed}`;
  // 1) no pre-existing object got NEWLY put on water (shipped maps legitimately keep
  //    coastal landmarks with footprints touching water — only the DELTA counts)
  const baseIds = new Set(doc.objects.map((o) => o.id));
  for (const o of after.objects) {
    if (o.type === "location" || !baseIds.has(o.id)) continue;
    for (const k of footprint(o as never)) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      if (x >= n || y >= n) continue;
      const wasWater = isWater(doc.terrain.cells[y * n + x]!.value);
      if (wasWater) continue;
      expect(isWater(after.terrain.cells[y * n + x]!.value), `${label}: DROWNED ${o.type} ${o.id} at ${k}`).toBe(false);
    }
  }
  // 2) no generated object overlaps a pre-existing one
  const occupiedBefore = buildOccupiedSet(doc, landmarkSizes);
  for (const op of ops) {
    if (op.kind !== "addObject") continue;
    for (const k of footprint(op.object as never)) {
      expect(occupiedBefore.has(k), `${label}: OVERLAP ${op.object.type} at ${k}`).toBe(false);
    }
  }
  // 3) no road survives on water
  for (const c of after.terrain.cells) {
    if (c.roadType !== -1 && isWater(c.value)) {
      const was = doc.terrain.cells[c.y * n + c.x]!;
      const preExisting = was.roadType !== -1 && isWater(was.value);
      expect(preExisting, `${label}: ROAD_ON_WATER at ${c.x},${c.y}`).toBe(true);
    }
  }
}

describe("generation mechanics audit (all recipes, real executor)", () => {
  for (const recipeId of Object.keys(RECIPES)) {
    for (const seed of SEEDS) {
      it(`${recipeId} seed=${seed}: no drowning / overlap / road-on-water`, async () => {
        const { ops, after } = await run(recipeId, seed);
        assertMechanics(recipeId, seed, ops, after);
      });
    }
  }

  it("wall_maze, sealed: every touched 2×2 block is built whole", async () => {
    // The maze is a scale-2 lattice. Sealed (the default), a straight block is one 2×2 piece and
    // a joint block is a tower with a piece of wall in each of its other cells — or four towers
    // in a mod with no one-cell walls. Either way a block that received anything has all four
    // cells taken: an unfilled cell would be a place to slip through.
    for (const seed of SEEDS) {
      const { ops } = await run("wall_maze", seed);
      const covered = new Set<string>();
      for (const op of ops) {
        if (op.kind !== "addObject" || op.object.type !== "landmark") continue;
        const bt = String((op.object as { baseType?: string }).baseType ?? "").toUpperCase();
        const [w, h] = landmarkSizes[bt] ?? [1, 1];
        const { x, y } = op.object.pos as { x: number; y: number };
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) covered.add(`${x + dx},${y + dy}`);
      }
      expect(covered.size, `seed=${seed}: placed no walls`).toBeGreaterThan(0);
      for (const k of covered) {
        const [x, y] = k.split(",").map(Number) as [number, number];
        const bx = x - (x % 2), by = y - (y % 2);
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          expect(covered.has(`${bx + dx},${by + dy}`), `seed=${seed}: GAP at ${bx + dx},${by + dy}`).toBe(true);
        }
      }
    }
  });

  it("wall_maze, for looks: lighter joints, and still no way through a wall", async () => {
    // For looks a joint is towers alone, one inside each turn, and the rest of its block is open
    // ground. So the invariant is not "every touched block is full" but what that stands for: a
    // walker, stepping in all eight directions, gets no further than if every block WERE full.
    for (const seed of SEEDS) {
      const sealedCount = (await run("wall_maze", seed)).ops.length;
      const { ops } = await run("wall_maze", seed, REGION, false);
      expect(ops.length, `seed=${seed}: not lighter than the sealed one`).toBeLessThan(sealedCount);
      const placed = ops.filter(
        (o): o is Extract<EditOp, { kind: "addObject" }> => o.kind === "addObject" && o.object.type === "landmark",
      );
      expect(placed.length, `seed=${seed}: placed no walls`).toBeGreaterThan(0);
      // union of every placed piece's footprint
      const covered = new Set<string>();
      for (const op of placed) {
        const bt = String((op.object as { baseType?: string }).baseType ?? "").toUpperCase();
        const [w, h] = landmarkSizes[bt] ?? [1, 1];
        const { x, y } = op.object.pos as { x: number; y: number };
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) covered.add(`${x + dx},${y + dy}`);
      }
      // the same with every touched 2×2 block filled whole
      const full = new Set<string>();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const k of covered) {
        const [x, y] = k.split(",").map(Number) as [number, number];
        const bx = x - (x % 2), by = y - (y % 2);
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) full.add(`${bx + dx},${by + dy}`);
        minX = Math.min(minX, bx); minY = Math.min(minY, by); maxX = Math.max(maxX, bx + 1); maxY = Math.max(maxY, by + 1);
      }
      const box = [minX - 1, minY - 1, maxX + 1, maxY + 1] as const;
      /** component id of every free cell of the box, for a set of blocked cells */
      const components = (blocked: ReadonlySet<string>): Map<string, number> => {
        const comp = new Map<string, number>();
        let id = 0;
        for (let y0 = box[1]; y0 <= box[3]; y0++) for (let x0 = box[0]; x0 <= box[2]; x0++) {
          const k0 = `${x0},${y0}`;
          if (blocked.has(k0) || comp.has(k0)) continue;
          id++;
          comp.set(k0, id);
          const queue: [number, number][] = [[x0, y0]];
          while (queue.length) {
            const [x, y] = queue.pop()!;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
              if (nx < box[0] || ny < box[1] || nx > box[2] || ny > box[3] || blocked.has(k) || comp.has(k)) continue;
              comp.set(k, id);
              queue.push([nx, ny]);
            }
          }
        }
        return comp;
      };
      const whenFull = components(full);
      const asBuilt = components(covered);
      // two cells joined in the maze as built must be joined with full blocks too
      const seen = new Map<number, number>();
      for (const [k, built] of asBuilt) {
        const ref = whenFull.get(k);
        if (ref === undefined) continue; // a cell left free inside a joint block
        const first = seen.get(built);
        if (first === undefined) seen.set(built, ref);
        else expect(ref, `seed=${seed}: a way through a wall near ${k}`).toBe(first);
      }
      // and a straight block is always whole: its piece is 2×2
      for (const op of placed) {
        const bt = String((op.object as { baseType?: string }).baseType ?? "").toUpperCase();
        const [w] = landmarkSizes[bt] ?? [1, 1];
        if (w === 2) expect(op.object.pos.x % 2 === 0 && op.object.pos.y % 2 === 0, `seed=${seed}: a 2×2 piece off the lattice`).toBe(true);
      }
    }
  });

  it("river / road_path / relief_ridge cross the zone (span over many seeds)", async () => {
    for (const recipeId of ["river", "road_path", "relief_ridge"]) {
      for (const seed of [1, 7, 13, 21, 42]) {
        const { ops, after } = await run(recipeId, seed);
        expect(ops.length, `${recipeId} seed=${seed} produced nothing`).toBeGreaterThan(0);
        // collect the generated ribbon cells (water / road / mountain-stamp)
        const cells = new Set<string>();
        for (const op of ops) {
          if (op.kind === "setCell") cells.add(`${op.x},${op.y}`);
          if (op.kind === "addObject" && op.object.type === "mountains") {
            for (const k of footprint(op.object as never)) cells.add(k);
          }
        }
        const touches = (pred: (x: number, y: number) => boolean): boolean =>
          [...cells].some((k) => { const [x, y] = k.split(",").map(Number) as [number, number]; return pred(x, y); });
        // tolerance 3: the occupancy guard may legitimately eat the ribbon's edge cells
        // (a 3×3 site at the border) — a few cells shy of the border still "crosses".
        // OPPOSITE edges required: «two ANY edges» let a corner arc (top+left) ship as the
        // «river across the zone» — the exact bug of the v1 span check.
        const top = touches((_, y) => y <= REGION.y + 3);
        const bottom = touches((_, y) => y >= REGION.y + REGION.h - 4);
        const left = touches((x) => x <= REGION.x + 3);
        const right = touches((x) => x >= REGION.x + REGION.w - 4);
        expect((top && bottom) || (left && right), `${recipeId} seed=${seed}: ribbon does not CROSS the zone (corner arc?)`).toBe(true);
        void after;
      }
    }
  });

  it("water_isles produces water even on a small zone (deterministic seeding)", async () => {
    const { ops } = await run("water_isles", 3, { x: 30, y: 30, w: 10, h: 8 });
    expect(ops.filter((o) => o.kind === "setCell").length).toBeGreaterThan(4);
  });

  it("water_islands floods PART of the zone but leaves dry land islands inside", async () => {
    // «острова» = суша среди воды: real water must land, yet a real INNER dry area must
    // survive — the inverse of water_isles. Bounds are deliberately loose: the region sits
    // on live Riders content, so the occupancy guard legitimately eats many wet cells (the
    // SHAPE itself is asserted by the pure-grid audit in tools; here we prove decode+guard).
    for (const seed of SEEDS) {
      const region = { x: 20, y: 20, w: 20, h: 16 };
      const { ops } = await run("water_islands", seed, region);
      const wet = new Set(
        ops.filter((o): o is Extract<EditOp, { kind: "setCell" }> => o.kind === "setCell").map((o) => `${o.x},${o.y}`),
      );
      expect(wet.size, `seed=${seed}: no water at all`).toBeGreaterThan((region.w * region.h) / 8);
      // a real INNER dry area = islands (not just the border)
      let innerDry = 0;
      for (let y = region.y + 2; y < region.y + region.h - 2; y++)
        for (let x = region.x + 2; x < region.x + region.w - 2; x++)
          if (!wet.has(`${x},${y}`)) innerDry++;
      expect(innerDry, `seed=${seed}: no dry islands survived`).toBeGreaterThan(4);
    }
  });

  it("mountain_blob is an ORGANIC massif — fills part of the zone, not the full rectangle", async () => {
    for (const seed of SEEDS) {
      const region = { x: 20, y: 20, w: 18, h: 14 };
      const { ops } = await run("mountain_blob", seed, region);
      const cells = new Set<string>();
      for (const op of ops) {
        if (op.kind === "addObject" && op.object.type === "mountains") {
          for (const k of footprint(op.object as never)) cells.add(k);
        }
      }
      const area = region.w * region.h;
      // loose lower bound (the guard skips occupied/water cells of the live map); the key
      // assertion is the UPPER one — a fill would cover ~everything, a blob must not
      expect(cells.size, `seed=${seed}: produced no mountains`).toBeGreaterThan(area * 0.08);
      expect(cells.size, `seed=${seed}: covered the whole rectangle (that's mountain_fill)`).toBeLessThan(area * 0.85);
    }
  });

  it("mazeLatticeSide: the largest 4m+3 side whose widened maze fits", () => {
    expect([2, 3, 6, 7, 10, 11, 12, 18].map((u) => mazeLatticeSide(u, 1))).toEqual([0, 3, 3, 7, 7, 11, 11, 15]);
    // corridors two cells wide: a side n takes (n+1)/2 wall lines and (n−1) corridor cells
    expect([3, 4, 9, 10, 16, 22, 26].map((u) => mazeLatticeSide(u, 2))).toEqual([0, 3, 3, 7, 11, 15, 15]);
    expect(mazeLatticeSide(100, 3)).toBe(47); // 24 + 23·3 = 93 ≤ 100 < 26 + 25·3
  });

  it("widenMazeGrid keeps a wall line one cell thick and makes a corridor line wider", () => {
    const lattice = { width: 3, height: 3, rows: ["BAB", "BWB", "BBB"] };
    expect(widenMazeGrid(lattice, 1)).toBe(lattice);
    expect(widenMazeGrid(lattice, 2)).toEqual({ width: 4, height: 4, rows: ["BAAB", "BWWB", "BWWB", "BBBB"] });
    expect(widenMazeGrid(lattice, 3).rows).toEqual(["BAAAB", "BWWWB", "BWWWB", "BWWWB", "BBBBB"]);
  });

  it("a maze is whole: a sealed perimeter with two entrances, walls one line thick, every corridor reachable", async () => {
    for (const [recipeId, corridor] of [["wall_maze", 1], ["wall_maze_thin", 2], ["wall_maze_fence", 2]] as const) {
      for (const seed of [1, 2, 3, 7, 13, 21, 42]) {
        const plan = await recipePreview(recipeId, { width: 36, height: 28, seed });
        expect(plan, recipeId).toBeTruthy();
        const { width: w, height: h, rows } = plan!;
        const label = `${recipeId} seed=${seed}`;
        const wall = (x: number, y: number): boolean => rows[y]?.[x] === "B";
        // the size is that of the lattice: both outer lines are wall lines
        const side = (n: number): number => (n + 1) / 2 + ((n - 1) / 2) * corridor;
        expect([side(mazeLatticeSide(Math.floor(36 / plan!.scale), corridor)), side(mazeLatticeSide(Math.floor(28 / plan!.scale), corridor))], label).toEqual([w, h]);
        // the perimeter: wall everywhere but two entrances, each as wide as a corridor
        const ring: boolean[] = [];
        for (let x = 0; x < w; x++) ring.push(wall(x, 0));
        for (let y = 1; y < h; y++) ring.push(wall(w - 1, y));
        for (let x = w - 2; x >= 0; x--) ring.push(wall(x, h - 1));
        for (let y = h - 2; y >= 1; y--) ring.push(wall(0, y));
        const gaps: number[] = [];
        for (let i = 0; i < ring.length; i++) {
          if (ring[i]) continue;
          if (i > 0 && !ring[i - 1]) gaps[gaps.length - 1]!++;
          else gaps.push(1);
        }
        expect(gaps, `${label}: entrances`).toEqual([corridor, corridor]);
        // no doubled wall: nowhere four wall cells in a square
        for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
          expect(wall(x, y) && wall(x + 1, y) && wall(x, y + 1) && wall(x + 1, y + 1), `${label}: doubled wall at ${x},${y}`).toBe(false);
        }
        // one maze: every open cell is reached from any other without crossing a wall
        const open: [number, number][] = [];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!wall(x, y)) open.push([x, y]);
        const seen = new Set<string>([open[0]!.join()]);
        const queue = [open[0]!];
        while (queue.length) {
          const [x, y] = queue.pop()!;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || wall(nx, ny) || seen.has(k)) continue;
            seen.add(k);
            queue.push([nx, ny]);
          }
        }
        expect(seen.size, `${label}: unreachable corridors`).toBe(open.length);
      }
    }
  });

  it("a zone too small for one room gives no maze instead of a stub", async () => {
    const { ops } = await run("wall_maze", 3, { x: 30, y: 30, w: 4, h: 4 });
    expect(ops).toEqual([]);
  });

  it("sealMazeGrid seals the perimeter and cuts 1–2 doors into corridors", () => {
    const grid = {
      width: 8,
      height: 6,
      rows: ["AWABABAB", "BBBABABA", "ABABABAB", "BABABABA", "ABABABAB", "BABAABAB"],
    };
    const sealed = sealMazeGrid(grid, 5);
    let doors = 0;
    const at = (x: number, y: number): string => sealed.rows[y]![x]!;
    for (let x = 0; x < 8; x++) {
      if (at(x, 0) !== "B") { doors++; expect("AW").toContain(sealed.rows[1]![x]!); }
      if (at(x, 5) !== "B") { doors++; expect("AW").toContain(sealed.rows[4]![x]!); }
    }
    for (let y = 1; y < 5; y++) {
      if (at(0, y) !== "B") { doors++; expect("AW").toContain(sealed.rows[y]![1]!); }
      if (at(7, y) !== "B") { doors++; expect("AW").toContain(sealed.rows[y]![6]!); }
    }
    expect(doors).toBeGreaterThanOrEqual(1);
    expect(doors).toBeLessThanOrEqual(2);
  });
});
