/**
 * exportModel — the model-completion step that makes an edited MapDocument self-sufficient for a
 * model-rebuild export (no byte writer for payloads). Covers the two derivations applyOp does NOT
 * maintain: MidgardPlan occupancy (object footprints) and MidRoad index/var (from terrain cells).
 * A no-op edit must leave both byte-identical (roads' `…RA…` plan entries kept, not purged).
 */

import { describe, it, expect } from "vitest";
import type { MapDocument, MapObject } from "@d2/map-schema";
import { deriveExportPlan, objectPlanEntries, completeExportModel } from "@d2/map-edit";

function doc(partial: Partial<MapDocument>): MapDocument {
  const n = partial.size ?? 8;
  const cells = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      cells.push({ x, y, value: 0, terrain: 0, ground: 0, isWater: false, forest: 0, roadType: -1, roadVar: -1 });
  return {
    name: "t", size: n, players: 0, version: "S143",
    terrain: { size: n, cells }, objects: [], events: [], templates: [],
    ...partial,
  } as unknown as MapDocument;
}

const landmark = (id: string, x: number, y: number, baseType = "G000MG0001"): MapObject =>
  ({ id, type: "landmark", pos: { x, y }, baseType } as unknown as MapObject);
const village = (id: string, x: number, y: number): MapObject =>
  ({ id, type: "village", pos: { x, y } } as unknown as MapObject);

describe("objectPlanEntries (footprint sizes)", () => {
  it("village = 4×4 = 16 cells", () => {
    expect(objectPlanEntries(village("S143FT0001", 0, 0), 8)).toHaveLength(16);
  });
  it("landmark uses the injected catalog size (2×2), else 1×1", () => {
    const sz = (bt: string) => (bt === "G000MG0047" ? ([2, 2] as const) : undefined);
    expect(objectPlanEntries(landmark("S143MM0001", 1, 1, "G000MG0047"), 8, sz)).toHaveLength(4);
    expect(objectPlanEntries(landmark("S143MM0002", 1, 1, "G000MG9999"), 8, sz)).toHaveLength(1);
  });
  it("mountains contribute NO plan entries", () => {
    const m = { id: "S143ML0001#0", type: "mountains", pos: { x: 0, y: 0 }, w: 2, h: 2 } as unknown as MapObject;
    expect(objectPlanEntries(m, 8)).toEqual([]);
  });
  it("in-bounds guarded (a footprint clipped at the map edge)", () => {
    // a 4×4 village at (7,7) on an 8-map: only cell (7,7) is in bounds
    expect(objectPlanEntries(village("S143FT0001", 7, 7), 8)).toEqual([{ x: 7, y: 7, element: "S143FT0001" }]);
  });
  it("element is the object's own id", () => {
    expect(objectPlanEntries(landmark("S143MM00ab", 2, 3), 8)[0]!.element).toBe("S143MM00ab");
  });
});

describe("deriveExportPlan", () => {
  const base = doc({
    objects: [landmark("S143MM0001", 1, 1)],
    plan: { id: "S143PN0000", size: 8, entries: [
      { x: 1, y: 1, element: "S143MM0001" },   // the landmark
      { x: 3, y: 3, element: "S143RA0005" },   // a ROAD entry (not an object)
    ] } as never,
  });

  it("no-op keeps every entry incl. non-object (road) entries", () => {
    const out = deriveExportPlan(base, base);
    expect(out).toEqual(base.plan!.entries);
  });

  it("a deleted object drops ONLY its entries; road entries survive", () => {
    const edited = doc({ objects: [], plan: base.plan });
    const out = deriveExportPlan(base, edited);
    expect(out).toEqual([{ x: 3, y: 3, element: "S143RA0005" }]); // landmark gone, road kept
  });

  it("an added object appends its footprint", () => {
    const edited = doc({ objects: [...base.objects, village("S143FT0002", 4, 4)], plan: base.plan });
    const out = deriveExportPlan(base, edited);
    expect(out.filter((e) => e.element === "S143FT0002")).toHaveLength(16);
    expect(out.filter((e) => e.element === "S143RA0005")).toHaveLength(1); // road still there
  });
});

describe("completeExportModel — road reconciliation", () => {
  function withRoad(cellRoadType: number, roadIndex: number): MapDocument {
    const d = doc({
      roads: [{ id: "S143RA0001", x: 2, y: 2, index: roadIndex, variant: 4 }] as never,
      plan: { id: "S143PN0000", size: 8, entries: [] } as never,
    });
    d.terrain.cells[2 * 8 + 2]!.roadType = cellRoadType;
    d.terrain.cells[2 * 8 + 2]!.roadVar = cellRoadType < 0 ? -1 : 4;
    return d;
  }

  it("a washed road (cell roadType −1) syncs doc.roads to index −1", () => {
    const out = completeExportModel(doc({}), withRoad(-1, 13));
    expect(out.roads![0]).toMatchObject({ index: -1, variant: -1 });
  });

  it("an unchanged road stays put (same object identity)", () => {
    const d = withRoad(13, 13);
    const out = completeExportModel(doc({}), d);
    expect(out.roads![0]).toBe(d.roads![0]); // untouched → same reference
  });

  it("a retuned road picks up the cell's new index", () => {
    const out = completeExportModel(doc({}), withRoad(7, 13));
    expect(out.roads![0]).toMatchObject({ index: 7, variant: 4 });
  });

  it("never mutates the input doc", () => {
    const d = withRoad(-1, 13);
    const before = JSON.stringify(d.roads);
    completeExportModel(doc({}), d);
    expect(JSON.stringify(d.roads)).toBe(before);
  });
});
