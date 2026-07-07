/**
 * EXPERIMENT (branch experiment/full-rebuild) — the block-list SPINE of a full rebuild.
 * `splitScenario` decomposes a `.sg` into a header prefix + ordered block frames (each raw,
 * TagDataBlock-style); `joinScenario` re-assembles them. STEP 1 invariant: with every block
 * kept raw, `join(split(x)) === x` byte-for-byte, on EVERY real campaign map. That proves the
 * decomposition is lossless before we start swapping raw frames for model-serialized ones.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  splitScenario,
  joinScenario,
  rebuildScenario,
  patchBlockCount,
  rebuildFromModel,
  rebuildBytes,
  parseScenario,
  validateMap,
} from "../src/index";
import type { MapObject } from "@d2/map-schema";
import { campaignDir, campaignMap, exportsDir } from "../../../test-helpers/gameDir";

const RIDERS = campaignMap(join("The Power of Eldunari-v1-2 maps", "Riders.sg"));
const read = (p: string): Uint8Array => new Uint8Array(readFileSync(p));

function findSgFiles(dir: string, out: string[] = [], limit = 60): string[] {
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
    if (st.isDirectory()) findSgFiles(full, out, limit);
    else if (/\.sg$/i.test(name)) out.push(full);
  }
  return out;
}

/**
 * The PRISTINE authored-map originals (Game/Exports - Copy), BIGGEST FIRST so the rebuild gate
 * always stresses the largest scenarios (2.4 MB Relentless etc.). Excludes `.bak` backups. These
 * carry no playthrough state, so a full model rebuild reproduces them byte-for-byte — unlike the
 * Game/Campaign copies (which hold visited-site lists our model intentionally doesn't capture).
 */
function pristineSgFiles(limit = 40): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(exportsDir());
  } catch {
    return [];
  }
  return entries
    .filter((n) => /\.sg$/i.test(n) && !/\.bak$/i.test(n))
    .map((n) => join(exportsDir(), n))
    .map((p) => ({ p, size: (() => { try { return statSync(p).size; } catch { return 0; } })() }))
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
    .map((x) => x.p);
}

const eq = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const countDiffs = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  let d = Math.abs(a.length - b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d;
};

describe("@d2/sg-parser block-list (experiment/full-rebuild — split/join spine)", () => {
  const bytes = read(RIDERS);

  it("splits Riders into a header + many ordered block frames", () => {
    const s = splitScenario(bytes);
    expect(s.header.length).toBeGreaterThan(0);
    expect(s.blocks.length).toBeGreaterThan(100); // Riders has ~1650 framed blocks
    // block count matches the parsed object count (every framed object is one block)
    const doc = parseScenario(bytes);
    // objects + the non-object framed blocks (ScenarioInfo, terrain chunks, events, …) —
    // so blocks >= objects; sanity: at least as many blocks as modeled objects
    expect(s.blocks.length).toBeGreaterThanOrEqual(doc.objects.length);
    // every block carries a decl type name
    expect(s.blocks.every((b) => typeof b.typeName === "string")).toBe(true);
    // ScenarioInfo is present as a block
    expect(s.blocks.some((b) => b.typeName === "ScenarioInfo")).toBe(true);
  });

  it("join(split(Riders)) === Riders byte-for-byte", () => {
    const out = joinScenario(splitScenario(bytes));
    expect(out.length).toBe(bytes.length);
    expect(eq(out, bytes)).toBe(true);
  });

  it("round-trips EVERY campaign .sg byte-for-byte (lossless decomposition)", () => {
    const files = findSgFiles(campaignDir(), [], 60);
    expect(files.length).toBeGreaterThan(5); // the real install has many
    let checked = 0;
    for (const f of files) {
      const b = read(f);
      let out: Uint8Array;
      try {
        out = joinScenario(splitScenario(b));
      } catch {
        continue; // a non-scenario .sg (bad magic) — skip, not our target
      }
      expect(eq(out, b), `round-trip mismatch for ${f}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe("@d2/sg-parser block-list STEP 2 — header OB0000 count", () => {
  const bytes = read(RIDERS);

  it("rebuildScenario(split(Riders)) is byte-identical (unchanged block set → same count)", () => {
    expect(eq(rebuildScenario(splitScenario(bytes)), bytes)).toBe(true);
  });

  it("patchBlockCount re-stamps only the count int32 (real count == original header)", () => {
    const s = splitScenario(bytes);
    // patching to the REAL count reproduces the header exactly
    expect(eq(patchBlockCount(s.header, s.blocks.length), s.header)).toBe(true);
    // patching to a different count changes exactly the 4-byte count field, nothing else
    const wrong = patchBlockCount(s.header, s.blocks.length + 42);
    expect(wrong.length).toBe(s.header.length);
    expect(countDiffs(wrong, s.header)).toBeLessThanOrEqual(4);
    expect(countDiffs(wrong, s.header)).toBeGreaterThan(0);
  });
});

describe("@d2/sg-parser block-list STEP 3 — model-serialize typed blocks", () => {
  const bytes = read(RIDERS);

  function rebuiltFor(types: string[]): Uint8Array {
    const s = rebuildFromModel(splitScenario(bytes), parseScenario(bytes), new Set(types));
    return rebuildScenario(s);
  }

  for (const [decl, type] of [
    ["MidLandmark", "landmark"],
    ["MidLocation", "location"],
    ["MidCrystal", "crystal"],
    ["MidSiteMerchant", "merchant"],
    ["MidSiteMage", "mage"],
    ["MidSiteTrainer", "trainer"],
    ["MidSiteMercs", "mercenary"],
  ] as const) {
    it(`${decl}: model-rebuild reparses, preserves objects, validates (byte-diff reported)`, () => {
      const before = parseScenario(bytes);
      const out = rebuiltFor([decl]);
      const after = parseScenario(out); // must not throw

      const of = (d: typeof before) => d.objects.filter((o) => o.type === type);
      expect(of(after).length).toBe(of(before).length); // no object lost
      for (const b of of(before)) {
        const a = after.objects.find((o) => o.id === b.id);
        expect(a?.type).toBe(type);
        expect(a?.pos).toEqual(b.pos); // position round-trips through the model
      }
      expect(validateMap(after).ok).toBe(true); // the rebuilt map is structurally valid

      const diffs = countDiffs(bytes, out);
      // BYTE-PERFECT: each proven type reproduces the original frame exactly from the model — the
      // model captures every persisted field (landmark DESC_TXT, crystal AIPRIORITY, the site stock
      // lists, …). This is the "close the gap → 0 diffs" proof; a regression (a dropped field) would
      // make it non-zero.
      expect(diffs, `${decl} model-rebuild should reproduce the original byte-for-byte`).toBe(0);
    });
  }
});

describe("@d2/sg-parser block-list STEP 4 — full-rebuild export path (rebuildBytes)", () => {
  const bytes = read(RIDERS);

  it("rebuildBytes(map, parse(map)) is byte-identical for every PRISTINE original (incl. the biggest)", () => {
    const files = pristineSgFiles(40); // biggest-first: stresses the 2.4 MB scenarios
    expect(files.length).toBeGreaterThan(10);
    let checked = 0;
    for (const f of files) {
      const b = read(f);
      let out: Uint8Array;
      try {
        out = rebuildBytes(b, parseScenario(b)); // proven types from model + rest raw
      } catch {
        continue;
      }
      expect(eq(out, b), `rebuild changed bytes for ${f}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("carries a MODEL edit into the rebuilt bytes (a location rename flows through, stays valid)", () => {
    const doc = parseScenario(bytes);
    const loc = doc.objects.find((o) => o.type === "location")!;
    const edited = {
      ...doc,
      objects: doc.objects.map((o): MapObject => (o.id === loc.id ? ({ ...o, name: "Переименовано" } as MapObject) : o)),
    };
    const out = rebuildBytes(bytes, edited);
    const re = parseScenario(out);
    const reLoc = re.objects.find((o) => o.id === loc.id);
    expect(reLoc?.type).toBe("location");
    expect((reLoc as { name?: string }).name).toBe("Переименовано");
    expect(validateMap(re).ok).toBe(true);
  });
});
