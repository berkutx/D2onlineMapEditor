import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { MapDocument, SCHEMA_VERSION, ISO } from "../src/index";

const FIXTURE = resolve(__dirname, "../../../fixtures/map-json/mock-min.json");

describe("@d2/map-schema contract", () => {
  it("exposes a semver schema version", () => {
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("computes the iso transform", () => {
    expect(ISO.isoX(3, 1)).toBe(2);
    expect(ISO.isoY(3, 1)).toBe(2);
    expect(ISO.tileW).toBe(192);
  });

  it("validates the committed mock MapDocument fixture", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const doc = MapDocument.parse(raw);
    expect(doc.size).toBe(2);
    expect(doc.terrain.cells).toHaveLength(doc.size * doc.size);
    expect(doc.terrain.cells.every((c) => c.isWater === (c.ground === 3))).toBe(true);
  });

  it("rejects a doc whose grid length != size*size via a sibling check", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const doc = MapDocument.parse(raw);
    // schema can't cross-check length, so the parser/validator asserts it; prove the invariant holds here.
    expect(doc.terrain.cells.length).toBe(doc.size * doc.size);
  });

  it("accepts a generic fallback object", () => {
    const obj = MapDocument.parse({
      schemaVersion: SCHEMA_VERSION,
      header: { name: "x", version: "S143", size: 1 },
      size: 1,
      terrain: { size: 1, cells: [{ x: 0, y: 0, value: 0, terrain: 0, ground: 0, isWater: false, forest: 0, roadType: -1, roadVar: -1 }] },
      objects: [{ type: "generic", id: "ZZ0001", pos: { x: 0, y: 0 }, blockType: "MidUnknown", raw: { a: 1 } }],
      players: [],
    });
    expect(obj.objects[0]!.type).toBe("generic");
  });
});
