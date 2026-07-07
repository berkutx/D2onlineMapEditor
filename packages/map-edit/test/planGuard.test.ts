import { describe, it, expect } from "vitest";
import { planCoverageErrors, type PlanCell } from "../src/mechanics.js";
import type { MapDocument } from "@d2/map-schema";

// G000MG0047 = a 2×2 stone wall (byte-verified on walltest.sg); anything else ⇒ 1×1.
const LM = "G000MG0047";
const size2 = (b: string): readonly [number, number] | undefined => (b === LM ? [2, 2] : undefined);

function docWith(objects: MapDocument["objects"], n = 16): MapDocument {
  return { size: n, terrain: { cells: [] }, players: [], objects } as unknown as MapDocument;
}
const wall = (id: string, x: number, y: number): MapDocument["objects"][number] =>
  ({ type: "landmark", id, pos: { x, y }, baseType: LM }) as MapDocument["objects"][number];

const cells = (id: string, xs: [number, number][]): PlanCell[] =>
  xs.map(([x, y]) => ({ x, y, element: id }));

describe("planCoverageErrors — parity with the game's landmark isValid", () => {
  it("passes when the full 2×2 footprint is owned in the plan", () => {
    const doc = docWith([wall("S143MM0005", 12, 0)]);
    const plan = cells("S143MM0005", [[12, 0], [13, 0], [12, 1], [13, 1]]);
    expect(planCoverageErrors(doc, plan, { landmarkSize: size2 })).toEqual([]);
  });

  it("errors on a 2×2 wall registered as only its 1×1 anchor (THE pre-fix bug: S143MM0005)", () => {
    const doc = docWith([wall("S143MM0005", 12, 0)]);
    const plan = cells("S143MM0005", [[12, 0]]); // 1 of 4 cells
    const errs = planCoverageErrors(doc, plan, { landmarkSize: size2 });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("S143MM0005");
    expect(errs[0]).toContain("1/4");
    expect(errs[0]).toContain("isValid");
  });

  it("counts a cell owned by ANOTHER object as missing (game requires owner match)", () => {
    const doc = docWith([wall("S143MM0005", 12, 0)]);
    const plan: PlanCell[] = [
      ...cells("S143MM0005", [[12, 0], [13, 0], [12, 1]]),
      { x: 13, y: 1, element: "S143KC0001" }, // a stack owns this cell, not the wall
    ];
    const errs = planCoverageErrors(doc, plan, { landmarkSize: size2 });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("3/4");
  });

  it("allows a cell to ALSO carry another owner's entry (cross-type double-claim is legal)", () => {
    const doc = docWith([wall("S143MM0005", 12, 0)]);
    const plan: PlanCell[] = [
      ...cells("S143MM0005", [[12, 0], [13, 0], [12, 1], [13, 1]]),
      { x: 12, y: 0, element: "S143KC0001" }, // stack also standing on (12,0) — fine
    ];
    expect(planCoverageErrors(doc, plan, { landmarkSize: size2 })).toEqual([]);
  });

  it("flags an off-map plan entry", () => {
    const doc = docWith([], 16);
    const errs = planCoverageErrors(doc, [{ x: 20, y: 3, element: "S143MM0005" }], { landmarkSize: size2 });
    expect(errs.some((e) => e.includes("outside") && e.includes("(20,3)"))).toBe(true);
  });

  it("a 1×1 landmark (tower) needs only its anchor cell", () => {
    const doc = docWith([
      { type: "landmark", id: "S143MM0006", pos: { x: 5, y: 5 }, baseType: "G000MG0149" },
    ] as MapDocument["objects"]);
    expect(planCoverageErrors(doc, cells("S143MM0006", [[5, 5]]), { landmarkSize: size2 })).toEqual([]);
  });
});
