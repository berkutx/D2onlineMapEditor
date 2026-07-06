/**
 * Brush mechanics guards + validateMechanics: ручная кисть соблюдает те же
 * игромеханические инварианты, что и генерация (вода не топит объекты, дороги не по
 * воде), а валидатор ловит нарушения, откуда бы они ни пришли.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseScenario } from "@d2/sg-parser";
import type { MapDocument } from "@d2/map-schema";
import {
  terrainBrush,
  roadBrush,
  buildOccupiedSet,
  validateMechanics,
  applyOps,
} from "../src/index.js";
import { campaignMap } from "../../../test-helpers/gameDir.js";

let doc: MapDocument;
let occupied: Set<string>;
let village: { pos: { x: number; y: number } };

const isWater = (v: number): boolean => ((v >> 3) & 7) === 3;

beforeAll(async () => {
  const bytes = await readFile(campaignMap(join("The Power of Eldunari-v1-2 maps", "Riders.sg")));
  doc = parseScenario(new Uint8Array(bytes));
  occupied = buildOccupiedSet(doc);
  village = doc.objects.find((o) => o.type === "village") as never;
  expect(village).toBeTruthy();
});

describe("brush mechanics guards", () => {
  it("water brush skips a village footprint entirely (no drowning by hand)", () => {
    // a 5×5 water stroke centred on the village anchor
    const ops = terrainBrush(doc, village.pos.x + 1, village.pos.y + 1, 5, { type: "water" }, occupied);
    for (const op of ops) {
      if (op.kind !== "setCell") continue;
      expect(
        occupied.has(`${op.x},${op.y}`),
        `water painted occupied cell ${op.x},${op.y}`,
      ).toBe(false);
    }
  });

  it("water brush washes away the road on painted cells (-1/-1 erase idiom)", () => {
    const roadCell = doc.terrain.cells.find(
      (c) => c.roadType !== -1 && !isWater(c.value) && !occupied.has(`${c.x},${c.y}`),
    )!;
    expect(roadCell).toBeTruthy();
    const ops = terrainBrush(doc, roadCell.x, roadCell.y, 1, { type: "water" }, occupied);
    const op = ops.find((o) => o.kind === "setCell" && o.x === roadCell.x && o.y === roadCell.y);
    expect(op).toBeTruthy();
    expect((op as { roadType?: number }).roadType).toBe(-1);
    expect((op as { roadVar?: number }).roadVar).toBe(-1);
  });

  it("terrain brush still recolors land UNDER objects (biome washes stay legal)", () => {
    // snow over the village anchor cell: allowed (only water/forest are blocked on land)
    const ops = terrainBrush(doc, village.pos.x, village.pos.y, 1, { type: "terrain", terrain: 2 }, occupied);
    expect(ops.length).toBe(1);
  });

  it("road brush refuses to paint on water", () => {
    const waterCell = doc.terrain.cells.find((c) => isWater(c.value))!;
    expect(waterCell).toBeTruthy();
    expect(roadBrush(doc, waterCell.x, waterCell.y)).toEqual([]);
  });
});

describe("validateMechanics (calibrated: silent on shipped maps)", () => {
  it("Riders is clean", () => {
    expect(validateMechanics(doc)).toEqual([]);
  });

  it("flags a city put on water and a road under water", () => {
    // force water under the village anchor + keep a road under water
    const n = doc.size;
    const anchor = doc.terrain.cells[village.pos.y * n + village.pos.x]!;
    const roadCell = doc.terrain.cells.find((c) => c.roadType !== -1)!;
    const bad = applyOps(doc, [
      { kind: "setCell", x: anchor.x, y: anchor.y, value: (anchor.value & ~(7 << 3)) | (3 << 3) },
      { kind: "setCell", x: roadCell.x, y: roadCell.y, value: (roadCell.value & ~(7 << 3)) | (3 << 3) },
    ]);
    const warns = validateMechanics(bad);
    expect(warns.some((w) => w.includes("village") && w.includes("на воде"))).toBe(true);
    expect(warns.some((w) => w.includes("дорога под водой"))).toBe(true);
  });
});

describe("validateMechanics occupancy (no overlapping footprints — the original's rule)", () => {
  // G000MG0047 = a 2×2 wall piece; byte-verified footprint from the original's walltest.sg
  // (G000MG8022=1×1, G000MG0047=2×2, G000MG0003=4×4). The resolver stands in for decorCatalog.
  const LM = "G000MG0047";
  const size = (b: string): readonly [number, number] | undefined =>
    b === LM ? [2, 2] : undefined;

  /** First 2×2 spot free of any object cell (buildOccupiedSet) — no overlap possible there. */
  function freeSpot(): { x: number; y: number } {
    const n = doc.size;
    for (let y = 0; y + 1 < n; y++)
      for (let x = 0; x + 1 < n; x++) {
        let ok = true;
        for (let dy = 0; dy < 2 && ok; dy++)
          for (let dx = 0; dx < 2; dx++) if (occupied.has(`${x + dx},${y + dy}`)) { ok = false; break; }
        if (ok) return { x, y };
      }
    throw new Error("no free 2×2 spot on Riders");
  }

  it("flags a landmark overlapping a village footprint", () => {
    const lm = { type: "landmark" as const, id: "S143MM9000", pos: { ...village.pos }, baseType: LM };
    const bad = applyOps(doc, [{ kind: "addObject", object: lm }]);
    const warns = validateMechanics(bad, { landmarkSize: size });
    expect(warns.some((w) => w.includes("перекрывает") && w.includes("S143MM9000"))).toBe(true);
  });

  it("does NOT flag the same landmark on free ground", () => {
    const lm = { type: "landmark" as const, id: "S143MM9001", pos: freeSpot(), baseType: LM };
    const bad = applyOps(doc, [{ kind: "addObject", object: lm }]);
    const warns = validateMechanics(bad, { landmarkSize: size });
    expect(warns.some((w) => w.includes("S143MM9001"))).toBe(false);
  });

  it("Riders stays clean with real landmark footprints (calibration)", () => {
    // every landmark at a plausible size — the shipped map must still produce zero overlaps.
    const all = (b: string): readonly [number, number] => (b === LM ? [2, 2] : [1, 1]);
    expect(validateMechanics(doc, { landmarkSize: all })).toEqual([]);
  });
});
