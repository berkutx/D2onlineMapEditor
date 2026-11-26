/**
 * The map passport counts what is in the document — sides, objects, land — and nothing else.
 */
import { describe, it, expect } from "vitest";
import { createBlankMap, parseScenario } from "@d2/sg-parser";
import type { MapDocument, MapObject } from "@d2/map-schema";
// the sources, not the built package
import { applyOps, fogFillOps, mapPassport, setWater, setForest, type EditOp } from "../src/index";

const SIZE = 48;
const base = parseScenario(createBlankMap({ size: SIZE, name: "Passport", author: "tester", races: ["empire", "undead"] }));

describe("mapPassport", () => {
  it("describes a new two-race map", () => {
    const p = mapPassport(base);
    expect(p).toMatchObject({ name: "Passport", author: "tester", size: SIZE, cells: SIZE * SIZE, sides: 2 });
    expect(p.players).toHaveLength(3); // the neutral player is a player too
    const [empire, undead] = p.players.filter((x) => !x.neutral);
    expect(empire).toMatchObject({ race: 0, cities: 0, parties: 1 });
    expect(undead).toMatchObject({ race: 3, parties: 1 });
    expect(empire!.capital).toBeDefined();
    expect(empire!.units).toBeGreaterThanOrEqual(2); // the capital guardian and the starting leader
    expect(p.objects).toMatchObject({ capitals: 2, cities: 0, ruins: 0, neutralParties: 0 });
    expect(p.terrain.water).toBe(0);
    expect(p.terrain.land.reduce((a, b) => a + b, 0)).toBe(SIZE * SIZE);
    // a new map's fog is in the file but nobody set it: every cell open
    expect(empire!.fog).toEqual({ hidden: 0, total: SIZE * SIZE });
  });

  it("measures the distance between the closest capitals in steps", () => {
    const p = mapPassport(base);
    const [a, b] = p.players.filter((x) => !x.neutral);
    const dx = Math.abs(a!.capital!.x - b!.capital!.x);
    const dy = Math.abs(a!.capital!.y - b!.capital!.y);
    expect(p.closestCapitals).toEqual({ a: a!.id, b: b!.id, distance: Math.max(dx, dy) });
    // one side alone has nobody to be close to
    const solo = mapPassport(parseScenario(createBlankMap({ size: SIZE, races: ["elves"] })));
    expect(solo.closestCapitals).toBeNull();
    expect(solo.sides).toBe(1);
  });

  it("counts what is put on the map, by kind, and splits owned from neutral", () => {
    const empire = base.players.find((p) => p.race === 0)!;
    const add = (object: Record<string, unknown>): EditOp => ({ kind: "addObject", object: object as unknown as MapObject });
    const unit = (id: string) => ({ unit: id, level: 1, hp: 10 });
    const ops: EditOp[] = [
      add({ type: "village", id: "S143FT0010", pos: { x: 20, y: 20 }, name: "A", tier: 2, garrison: [unit("G000UU0001"), null, unit("G000UU0002"), null, null, null] }),
      add({ type: "village", id: "S143FT0011", pos: { x: 30, y: 20 }, name: "B", tier: 2, owner: empire.id, garrison: [unit("G000UU0001"), null, null, null, null, null] }),
      add({ type: "village", id: "S143FT0012", pos: { x: 20, y: 30 }, name: "C", tier: 5 }),
      add({ type: "ruin", id: "S143RU0000", pos: { x: 10, y: 30 }, name: "R", garrison: [unit("G000UU0003"), unit("G000UU0003"), null, null, null, null] }),
      add({ type: "stack", id: "S143KC0010", pos: { x: 25, y: 25 }, garrison: [unit("G000UU0004"), null, null, null, null, null] }),
      add({ type: "treasure", id: "S143BG0000", pos: { x: 12, y: 12 }, items: ["G000IG0001", "G000IG0002", "G000IG0003"] }),
      add({ type: "crystal", id: "S143CR0000", pos: { x: 14, y: 14 }, resource: 0 }),
      add({ type: "crystal", id: "S143CR0001", pos: { x: 15, y: 14 }, resource: 2 }),
      add({ type: "crystal", id: "S143CR0002", pos: { x: 16, y: 14 }, resource: 2 }),
      add({ type: "merchant", id: "S143SI0000", pos: { x: 5, y: 40 } }),
      add({ type: "mountains", id: "S143ML0000#0", pos: { x: 40, y: 5 }, w: 3, h: 3, image: 0 }),
      add({ type: "mountains", id: "S143ML0000#1", pos: { x: 44, y: 5 }, w: 1, h: 1, image: 0 }),
    ];
    const p = mapPassport(applyOps(base, ops));
    expect(p.objects).toMatchObject({
      cities: 3, citiesByTier: [0, 2, 0, 0, 1], ruins: 1, merchants: 1, chests: 1, chestItems: 3,
      neutralParties: 1, mountains: 2, crystals: [1, 0, 2, 0, 0, 0],
    });
    expect(p.objects.neutralUnits).toBe(2 + 2 + 1); // the neutral city, the ruin guards, the neutral party
    expect(p.terrain.mountainCells).toBe(10);
    const side = p.players.find((x) => x.id === empire.id)!;
    expect(side.cities).toBe(1);
    expect(side.units).toBe(mapPassport(base).players.find((x) => x.id === empire.id)!.units + 1);
  });

  it("splits the land into water, forest and roads from the cells themselves", () => {
    const doc: MapDocument = { ...base, terrain: { ...base.terrain, cells: base.terrain.cells.slice() } };
    const paint = (x: number, y: number, value: (v: number) => number, roadType?: number): void => {
      const i = y * SIZE + x;
      const c = doc.terrain.cells[i]!;
      doc.terrain.cells[i] = { ...c, value: value(c.value), roadType: roadType ?? c.roadType };
    };
    for (let x = 0; x < 10; x++) paint(x, 0, setWater);
    for (let x = 0; x < 6; x++) paint(x, 1, (v) => setForest(v, 3));
    for (let x = 0; x < 4; x++) paint(x, 2, (v) => v, 1);
    const p = mapPassport(doc);
    expect(p.terrain).toMatchObject({ water: 10, forest: 6, roads: 4 });
    expect(p.terrain.land.reduce((a, b) => a + b, 0)).toBe(SIZE * SIZE - 10);
  });

  it("reports each side's fog as the file has it", () => {
    const empire = base.players.find((p) => p.race === 0)!;
    const hidden = applyOps(base, fogFillOps(base, empire.fogId!, true));
    const p = mapPassport(hidden);
    expect(p.players.find((x) => x.id === empire.id)!.fog).toEqual({ hidden: SIZE * SIZE, total: SIZE * SIZE });
    expect(p.players.find((x) => x.race === 3)!.fog).toEqual({ hidden: 0, total: SIZE * SIZE });
  });
});
