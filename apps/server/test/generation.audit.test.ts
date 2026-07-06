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
import { runGenerationSteps, sealMazeGrid } from "../src/maps/generation";
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

async function run(recipeId: string, seed: number, region = REGION): Promise<{ ops: EditOp[]; after: MapDocument }> {
  const ops = await runGenerationSteps(doc, [{ recipeId, region, seed }], walls, seed, undefined, false, decor, landmarkSizes);
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

  it("wall_maze: every wall AND junction column is 2×2 — no 1×1 tower leaves a walk-through gap", async () => {
    // The maze was passable through corners: a 1×1 tower filled only ¼ of the 2×2 junction
    // block, so the other 3 cells stayed open. Every placed piece must now be a full 2×2
    // (straight, corner, or a 2×2 column) so each junction block is sealed and the arms connect.
    for (const seed of SEEDS) {
      const { ops } = await run("wall_maze", seed);
      const walls = ops.filter(
        (o): o is Extract<EditOp, { kind: "addObject" }> => o.kind === "addObject" && o.object.type === "landmark",
      );
      expect(walls.length, `seed=${seed}: maze placed no walls`).toBeGreaterThan(0);
      for (const op of walls) {
        const bt = String((op.object as { baseType?: string }).baseType ?? "").toUpperCase();
        const [w, h] = landmarkSizes[bt] ?? [1, 1];
        expect(`${w}×${h}`, `seed=${seed}: piece ${bt} is ${w}×${h}, not 2×2 (1×1 = gap)`).toBe("2×2");
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
        let edges = 0;
        const touches = (pred: (x: number, y: number) => boolean): boolean =>
          [...cells].some((k) => { const [x, y] = k.split(",").map(Number) as [number, number]; return pred(x, y); });
        // tolerance 3: the occupancy guard may legitimately eat the ribbon's edge cells
        // (a 3×3 site at the border) — a few cells shy of the border still "crosses"
        if (touches((_, y) => y <= REGION.y + 3)) edges++;
        if (touches((_, y) => y >= REGION.y + REGION.h - 4)) edges++;
        if (touches((x) => x <= REGION.x + 3)) edges++;
        if (touches((x) => x >= REGION.x + REGION.w - 4)) edges++;
        expect(edges, `${recipeId} seed=${seed}: ribbon does not cross the zone`).toBeGreaterThanOrEqual(2);
        void after;
      }
    }
  });

  it("water_isles produces water even on a small zone (deterministic seeding)", async () => {
    const { ops } = await run("water_isles", 3, { x: 30, y: 30, w: 10, h: 8 });
    expect(ops.filter((o) => o.kind === "setCell").length).toBeGreaterThan(4);
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
