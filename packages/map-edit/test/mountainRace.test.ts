/**
 * A mountain's RACE is neutral (4) — the only value the game's data has. The game's own editor
 * rewrites anything else when it loads a map and then asks to save a map nobody touched, which
 * is how this was found: mountains placed by this editor (by hand and by the generator) used
 * to be written with RACE 0.
 */
import { describe, it, expect } from "vitest";
import { createBlankMap, parseScenario, serializeMapFromModelBytes, validateMap } from "@d2/sg-parser";
import {
  MOUNTAIN_RACE, applyOps, materializeForExport, placeMountainOps, type EditOp,
} from "@d2/map-edit";

const base = createBlankMap({ size: 48, name: "Mountain race" });
const doc = parseScenario(base);
const mountainsOf = (bytes: Uint8Array) => parseScenario(bytes).objects.filter((o) => o.type === "mountains");
const exported = (ops: readonly EditOp[]): Uint8Array => serializeMapFromModelBytes(base, materializeForExport(doc, ops));

describe("a mountain's RACE", () => {
  it("is neutral for a mountain placed now, in the document and in the exported bytes", () => {
    const ops = placeMountainOps(doc, 20, 20, 2, 2, 3);
    expect(ops[0]).toMatchObject({ kind: "addObject", object: { type: "mountains", race: MOUNTAIN_RACE } });
    const live = applyOps(doc, ops);
    expect(live.objects.filter((o) => o.type === "mountains")).toMatchObject([{ race: 4 }]);
    const out = exported(ops);
    expect(mountainsOf(out)).toMatchObject([{ pos: { x: 20, y: 20 }, w: 2, h: 2, image: 3, race: 4 }]);
    expect(validateMap(parseScenario(out)).ok).toBe(true);
  });

  it("is repaired for a mountain an old journal placed with race 0 (or none)", () => {
    const old: EditOp[] = [
      { kind: "addObject", object: { type: "mountains", id: "S143ML0000#0", pos: { x: 8, y: 8 }, w: 1, h: 1, image: 0, race: 0 } },
      { kind: "addObject", object: { type: "mountains", id: "S143ML0000#1", pos: { x: 12, y: 8 }, w: 1, h: 1, image: 1 } },
    ];
    const live = applyOps(doc, old);
    expect(live.objects.filter((o) => o.type === "mountains").map((o) => (o as { race?: number }).race)).toEqual([4, 4]);
    // …and the document agrees with what the export writes (the semantic check compares them)
    expect(mountainsOf(exported(old)).map((o) => (o as { race?: number }).race)).toEqual([4, 4]);
  });

  it("leaves a mountain of the base map alone, and an explicit other race too", () => {
    const withMountain = createBlankMap({ size: 48, mountains: [{ x: 5, y: 5, w: 1, h: 1, image: 2, race: 2 }] });
    expect(mountainsOf(withMountain)).toMatchObject([{ race: 2 }]);
    const d = parseScenario(withMountain);
    const out = serializeMapFromModelBytes(withMountain, materializeForExport(d, []));
    expect(out).toEqual(withMountain); // untouched map: byte-identical, race and all
    const live = applyOps(doc, [{ kind: "addObject", object: { type: "mountains", id: "S143ML0000#0", pos: { x: 9, y: 9 }, w: 1, h: 1, image: 0, race: 3 } }]);
    expect(live.objects.filter((o) => o.type === "mountains")).toMatchObject([{ race: 3 }]);
  });
});
