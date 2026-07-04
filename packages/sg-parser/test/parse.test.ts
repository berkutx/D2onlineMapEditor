import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { MapDocument } from "@d2/map-schema";
import { parseScenario, parseHeaderOnly } from "../src/index";
import { campaignDir, campaignMap } from "../../../test-helpers/gameDir";

const CAMPAIGN = campaignDir();
const RIDERS = campaignMap(join("The Power of Eldunari-v1-2 maps", "Riders.sg"));

function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/** Recursively collect .sg files under a directory. */
function findSgFiles(dir: string, out: string[] = [], limit = 200): string[] {
  if (out.length >= limit) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (out.length >= limit) break;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      findSgFiles(full, out, limit);
    } else if (/\.sg$/i.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function countNeedle(buf: Uint8Array, needle: string): number {
  const pat = new TextEncoder().encode(needle);
  let n = 0;
  let i = 0;
  const last = buf.length - pat.length;
  outer: for (; i <= last; i++) {
    for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
    n++;
    i += pat.length - 1;
  }
  return n;
}

describe("@d2/sg-parser parseScenario (Riders.sg fixture)", () => {
  const bytes = read(RIDERS);
  const doc = parseScenario(bytes);

  it("decodes the authoritative map size and format version", () => {
    expect(doc.size).toBe(72);
    expect(doc.header.size).toBe(72);
    expect(doc.header.version).toBe("S143");
  });

  it("builds a dense row-major terrain grid of size*size cells", () => {
    expect(doc.terrain.cells.length).toBe(5184);
    expect(doc.terrain.cells.length).toBe(doc.size * doc.size);
    // index === y*size + x
    const c = doc.terrain.cells[5 * 72 + 3]!;
    expect(c.x).toBe(3);
    expect(c.y).toBe(5);
    // bit invariants
    expect(doc.terrain.cells.every((cell) => cell.isWater === (cell.ground === 3))).toBe(true);
    expect(doc.terrain.cells.every((cell) => cell.terrain === (cell.value & 7))).toBe(true);
  });

  it("applies at least some MidRoad overlays onto cells", () => {
    const withRoad = doc.terrain.cells.filter((c) => c.roadType >= 0).length;
    expect(withRoad).toBeGreaterThan(0);
  });

  it("reads a readable CP1251 map name and description", () => {
    expect(doc.header.name).toBe("Riders");
    // DESC is Russian (Windows-1251) -> must contain Cyrillic, no replacement chars
    expect(doc.header.description.length).toBeGreaterThan(0);
    expect(doc.header.description).toMatch(/[Ѐ-ӿ]/);
    expect(doc.header.description).not.toContain("�");
  });

  it("reads players with readable names", () => {
    expect(doc.players.length).toBe(3);
    const neutral = doc.players.find((p) => p.id.includes("PL0000"));
    expect(neutral?.name).toBe("Нейтралы");
  });

  it("produces object counts matching the .?AVC framing counts", () => {
    const count = (t: keyof typeof expected) => doc.objects.filter((o) => o.type === t).length;
    const expected = {
      stack: countNeedle(bytes, "MidStack@@"),
      crystal: countNeedle(bytes, "MidCrystal@@"),
      village: countNeedle(bytes, "MidVillage@@"),
      location: countNeedle(bytes, "MidLocation@@"),
      landmark: countNeedle(bytes, "MidLandmark@@"),
    } as const;

    // sanity: the raw framing counts are what we expect from the spike
    expect(expected.stack).toBe(119);
    expect(expected.crystal).toBe(21);
    expect(expected.village).toBe(4);
    expect(expected.location).toBe(418);
    expect(expected.landmark).toBe(673);

    expect(count("stack")).toBe(expected.stack);
    expect(count("crystal")).toBe(expected.crystal);
    expect(count("village")).toBe(expected.village);
    expect(count("location")).toBe(expected.location);
    expect(count("landmark")).toBe(expected.landmark);
  });

  it("validates against the zod MapDocument schema", () => {
    const parsed = MapDocument.parse(doc);
    expect(parsed.schemaVersion).toBeTruthy();
    expect(parsed.terrain.cells.length).toBe(parsed.size * parsed.size);
  });

  it("parseHeaderOnly agrees with the full parse", () => {
    const h = parseHeaderOnly(bytes);
    expect(h.size).toBe(72);
    expect(h.header.name).toBe("Riders");
    expect(h.players.length).toBe(3);
  });
});

describe("@d2/sg-parser smoke parse over campaign .sg files", () => {
  const all = findSgFiles(CAMPAIGN);
  // pick a spread of files that are NOT Riders.sg
  const sample = all.filter((p) => !/Riders\.sg$/i.test(p)).slice(0, 8);

  it("found .sg fixtures to smoke-test", () => {
    expect(sample.length).toBeGreaterThanOrEqual(5);
  });

  for (const path of sample) {
    it(`parses ${path.split(/[\\/]/).pop()} without throwing and validates`, () => {
      const doc = parseScenario(read(path));
      expect(doc.terrain.cells.length).toBe(doc.size * doc.size);
      expect(doc.size).toBeGreaterThan(0);
      // schema validation must pass for every map
      expect(() => MapDocument.parse(doc)).not.toThrow();
    });
  }
});
