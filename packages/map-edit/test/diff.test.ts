/**
 * diffDocs — the revert linchpin. Its contract: applyOps(a, diffDocs(a, b)) is structurally
 * equal to b, for any b reachable from a by EditOps. Tested on a REAL parsed map (Riders) so
 * objects/events/terrain are realistic, across every op kind. Plus opKeys sanity.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseScenario } from "@d2/sg-parser";
import { applyOps, diffDocs, opKeys, type EditOp } from "@d2/map-edit";
import type { MapDocument } from "@d2/map-schema";
import { campaignMap } from "../../../test-helpers/gameDir";

const RIDERS = campaignMap(join("The Power of Eldunari-v1-2 maps", "Riders.sg"));
const doc: MapDocument = parseScenario(new Uint8Array(readFileSync(RIDERS)));

/** JSON-structural equality, matching diffDocs' own comparison (wire round-trip). */
const eq = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);

describe("diffDocs", () => {
  it("empty diff when the docs are identical", () => {
    expect(diffDocs(doc, doc)).toEqual([]);
  });

  it("applyOps(a, diffDocs(a, b)) === b for a mix of terrain + object edits", () => {
    const firstObj = doc.objects[0]!;
    const b = applyOps(doc, [
      { kind: "setCell", x: 3, y: 4, value: 9, roadType: 2, roadVar: 1 },
      { kind: "setCell", x: 5, y: 5, value: 0 },
      { kind: "moveObject", id: firstObj.id, x: firstObj.pos.x + 1, y: firstObj.pos.y + 2 },
      { kind: "patchObject", id: firstObj.id, fields: { name: "diff-test-name" } },
    ]);
    const d = diffDocs(doc, b);
    expect(d.length).toBeGreaterThan(0);
    // the diff reproduces b exactly
    expect(eq(applyOps(doc, d), b)).toBe(true);
    // and it is minimal: only the two changed cells + the one object
    const cellOps = d.filter((o) => o.kind === "setCell");
    expect(cellOps).toHaveLength(2);
  });

  it("handles object add + delete", () => {
    const victim = doc.objects[0]!;
    const clone = { ...victim, id: "OBFFFFFF" } as (typeof doc.objects)[number]; // a fresh id
    // b = original minus victim, plus a clone under a new id
    const b: MapDocument = { ...doc, objects: doc.objects.slice(1).concat(clone) };
    const d = diffDocs(doc, b);
    expect(d.some((o) => o.kind === "deleteObject" && o.id === victim.id)).toBe(true);
    expect(d.some((o) => o.kind === "addObject" && o.object.id === "OBFFFFFF")).toBe(true);
    expect(eq(applyOps(doc, d), b)).toBe(true);
  });

  it("round-trips a whole-list block (variables)", () => {
    const b = applyOps(doc, [
      { kind: "setVariables", variables: [{ id: 0, name: "V0", type: 0, value: 1 } as never] },
    ]);
    const d = diffDocs(doc, b);
    expect(d.some((o) => o.kind === "setVariables")).toBe(true);
    expect(eq(applyOps(doc, d), b)).toBe(true);
  });

  // Simulate the wire/journal: ops are JSON-serialized (dropping `undefined`) before apply.
  const wire = (ops: EditOp[]): EditOp[] => ops.map((o) => JSON.parse(JSON.stringify(o)) as EditOp);
  const docWith = (objects: unknown[]): MapDocument =>
    ({ name: "t", size: 0, players: 0, terrain: { size: 0, cells: [] }, objects, version: "S143" } as unknown as MapDocument);

  it("clearing an optional field round-trips OVER JSON (delete+add, not a dropped-undefined patch)", () => {
    const a = docWith([{ id: "RU01", type: "ruin", pos: { x: 1, y: 1 }, name: "X", looted: false, desc: "lore" }]);
    const b = docWith([{ id: "RU01", type: "ruin", pos: { x: 1, y: 1 }, name: "X", looted: false }]);
    const d = diffDocs(a, b);
    // NOT a bare {desc:undefined} patch (that vanishes over the wire) — a whole-object replace
    expect(d.some((o) => o.kind === "deleteObject" && o.id === "RU01")).toBe(true);
    expect(d.some((o) => o.kind === "addObject")).toBe(true);
    expect(eq(applyOps(a, wire(d)), b)).toBe(true); // survives JSON serialization
  });

  it("an object TYPE change round-trips (delete+add, not a type-preserving patch)", () => {
    const a = docWith([{ id: "OB1", type: "ruin", pos: { x: 2, y: 2 }, name: "X", looted: false }]);
    const b = docWith([{ id: "OB1", type: "landmark", pos: { x: 2, y: 2 }, baseType: "G000MG0149", image: 0 }]);
    const d = diffDocs(a, b);
    expect(d.some((o) => o.kind === "deleteObject" && o.id === "OB1")).toBe(true);
    expect(eq(applyOps(a, wire(d)), b)).toBe(true);
    expect((applyOps(a, wire(d)).objects[0] as { type: string }).type).toBe("landmark");
  });

  it("opKeys namespaces cells / objects / events distinctly", () => {
    expect(opKeys({ kind: "setCell", x: 2, y: 3, value: 0 })).toEqual(["2,3"]);
    expect(opKeys({ kind: "moveObject", id: "OB000123", x: 0, y: 0 })).toEqual(["O:OB000123"]);
    expect(opKeys({ kind: "deleteObject", id: "OB000123" })).toEqual(["O:OB000123"]);
    expect(opKeys({ kind: "deleteEvent", id: "EV1" })).toEqual(["E:EV1"]);
    expect(opKeys({ kind: "setDiplomacy", diplomacy: [] })).toEqual(["DIPLOMACY"]);
    // an object op and a template op with the same raw id do NOT collide
    const a = opKeys({ kind: "deleteObject", id: "X" })[0];
    const t = opKeys({ kind: "deleteTemplate", id: "X" })[0];
    expect(a).not.toBe(t);
  });
});
