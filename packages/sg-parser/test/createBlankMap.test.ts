import { describe, it, expect } from "vitest";
import { MapDocument } from "@d2/map-schema";
import {
  parseScenario,
  parseScenarioRaw,
  createBlankMap,
  validateMap,
  roundTripIdentity,
  FILL_VALUE,
  TERRAIN_FILLS,
  MOUNTAIN_CELL,
} from "../src/index";

const SIZES = [48, 72] as const;
const FILLS = TERRAIN_FILLS;

describe("@d2/sg-parser createBlankMap — structural validity", () => {
  it("rejects non-multiple-of-8 sizes (fail loud)", () => {
    expect(() => createBlankMap({ size: 50 })).toThrow();
    expect(() => createBlankMap({ size: 0 })).toThrow();
  });

  for (const size of SIZES) {
    for (const fill of FILLS) {
      it(`size ${size}, fill ${fill}: parses back to a dense, uniform grid + passes validateMap`, () => {
        const bytes = createBlankMap({ size, fill, name: "Blank Test" });
        // begins with the magic
        expect(new TextDecoder("latin1").decode(bytes.subarray(0, 10))).toBe("D2EESFISIG");

        const doc = parseScenario(bytes);
        expect(doc.size).toBe(size);
        expect(doc.header.size).toBe(size);
        expect(doc.terrain.cells.length).toBe(size * size);
        // every cell is the requested fill value
        const want = FILL_VALUE[fill];
        expect(doc.terrain.cells.every((c) => c.value === want)).toBe(true);
        // water fill => isWater everywhere; default/snow => not water
        expect(doc.terrain.cells.every((c) => c.isWater === (fill === "water"))).toBe(true);
        // exactly one (neutral) player, no roads
        expect(doc.players.length).toBe(1);
        expect(doc.players[0]!.name).toBe("Нейтралы");
        expect(doc.players[0]!.race).toBe(4);
        expect(doc.terrain.cells.some((c) => c.roadType >= 0)).toBe(false);

        // schema + semantic validator both clean
        expect(() => MapDocument.parse(doc)).not.toThrow();
        const v = validateMap(doc);
        expect(v.errors).toEqual([]);
        expect(v.ok).toBe(true);
      });
    }
  }

  it("the generated map round-trips byte-exact through the writer (offset index sound)", () => {
    const bytes = createBlankMap({ size: 72, fill: "default" });
    expect(roundTripIdentity(bytes)).toBe(true);
    const { doc, raw } = parseScenarioRaw(bytes);
    // chunk count = ceil(N/8)*ceil(N/4); offset index must read back every cell
    expect(raw.blocks.length).toBe((72 / 8) * (72 / 4));
    expect(doc.terrain.cells.length).toBe(72 * 72);
  });
});

describe("@d2/sg-parser createBlankMap — mountains", () => {
  it("stamps mountain footprint cells to 37 and emits a MidMountains object", () => {
    const bytes = createBlankMap({
      size: 48,
      fill: "default",
      mountains: [{ x: 10, y: 12, w: 2, h: 3, image: 5 }],
    });
    const doc = parseScenario(bytes);
    // footprint cells (cols 10..11, rows 12..14) are mountain (37)
    for (let x = 10; x < 12; x++) {
      for (let y = 12; y < 15; y++) {
        expect(doc.terrain.cells[y * 48 + x]!.value).toBe(MOUNTAIN_CELL);
      }
    }
    // a non-footprint cell stays default
    expect(doc.terrain.cells[0]!.value).toBe(FILL_VALUE.default);
    // the mountain object is present
    const mtns = doc.objects.filter((o) => o.type === "mountains");
    expect(mtns.length).toBe(1);
    expect(mtns[0]!.pos).toEqual({ x: 10, y: 12 });
    expect(validateMap(doc).ok).toBe(true);
  });
});
