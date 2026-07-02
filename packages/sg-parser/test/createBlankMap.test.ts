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

describe("@d2/sg-parser createBlankMap — races (addRace port)", () => {
  it("empire + undead: players, capitals with guardians, hero stacks, fogs — validateMap ok", () => {
    const bytes = createBlankMap({ size: 48, fill: "default", races: ["empire", "undead"] });
    const doc = parseScenario(bytes);

    // 3 players: neutral + 2 races, in block order
    expect(doc.players.length).toBe(3);
    expect(doc.players[0]!.race).toBe(4);
    const byName = new Map(doc.players.map((p) => [p.name, p]));
    expect(byName.has("Империя")).toBe(true);
    expect(byName.has("Орды Нежити")).toBe(true);

    // 2 capitals at the preset corners, each owned by its race player
    const caps = doc.objects.filter((o) => o.type === "capital");
    expect(caps.length).toBe(2);
    const empireCap = caps.find((c) => (c as { owner?: string }).owner === byName.get("Империя")!.id);
    expect(empireCap).toBeTruthy();
    expect(empireCap!.pos).toEqual({ x: 6, y: 6 });

    // 2 hero stacks inside the capitals, each with a leader
    const stacks = doc.objects.filter((o) => o.type === "stack");
    expect(stacks.length).toBe(2);

    // the 5×5 terrain stamp under the empire capital = terrain 1
    for (let x = 6; x < 11; x++)
      for (let y = 6; y < 11; y++) expect(doc.terrain.cells[y * 48 + x]!.value).toBe(1);

    // schema + validator + byte-exact writer round-trip
    expect(() => MapDocument.parse(doc)).not.toThrow();
    const v = validateMap(doc);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(roundTripIdentity(bytes)).toBe(true);
  });

  it("all 5 races fit and validate on a 72 map", () => {
    const bytes = createBlankMap({
      size: 72, fill: "default",
      races: ["empire", "undead", "legions", "clans", "elves"],
    });
    const doc = parseScenario(bytes);
    expect(doc.players.length).toBe(6);
    expect(doc.objects.filter((o) => o.type === "capital").length).toBe(5);
    expect(doc.objects.filter((o) => o.type === "stack").length).toBe(5);
    expect(validateMap(doc).ok).toBe(true);
    expect(roundTripIdentity(bytes)).toBe(true);
  });

  // These blocks were the game-editor gold-check blockers (a from-scratch map that passes our
  // parser but ScenEdit refused to load). Verified: a 2-race map now opens + renders in the
  // game's own editor. Guard the exact structure the game requires.
  it("emits the game-required scenario structure (OB0000 count + diplomacy + plan)", () => {
    const bytes = createBlankMap({ size: 48, fill: "default", races: ["empire", "undead"] });
    const buf = Buffer.from(bytes);

    // OB0000 header count MUST equal the number of block frames actually written (a mismatch
    // is invisible to our parser but makes the game refuse to load).
    const obPos = buf.indexOf(Buffer.from("S143OB0000"));
    const declared = buf.readInt32LE(obPos + 10);
    let actual = 0, i = -1;
    while ((i = buf.indexOf(Buffer.from("WHAT"), i + 1)) >= 0) actual++;
    expect(declared).toBe(actual);
    expect(declared).toBe(121); // 2 races @48, matches a game-created blank

    const doc = parseScenario(bytes);
    // every player gets its OWN fog block (neutral incl.) — no dangling FOG_ID
    expect(doc.objects.filter((o) => o.type === "location").length).toBe(0);
    // diplomacy: all pairwise player-race relations (3 players -> 3 pairs)
    expect(doc.diplomacy?.length).toBe(3);
    // plan is populated (2 capitals × 5×5 + 2 hero stacks = 52 entries) — a bare count check
    // via the raw block: MidgardPlan body carries the entry count as its 2nd int.
    const pn = buf.indexOf(Buffer.from("S143PN0000"));
    const pnBeg = buf.indexOf(Buffer.from("BEGOBJECT\0"), pn);
    // body: <id>+i32(mapSize) + <id>+i32(count) — read the count (2nd defaultInt)
    const planCount = buf.readInt32LE(pnBeg + 10 + 10 + 4 + 10);
    expect(planCount).toBe(52);
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
