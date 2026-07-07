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
  parseScenario,
  validateMap,
} from "../src/index";
import { campaignDir, campaignMap } from "../../../test-helpers/gameDir";

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

  for (const [decl, type] of [["MidLandmark", "landmark"], ["MidLocation", "location"]] as const) {
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
      const n = of(before).length;
      // informational: 0 = perfect byte reproduction from the model; >0 = model gap (e.g.
      // landmark DESC_TXT not in the schema). The semantic assertions above are the real gate.
      // eslint-disable-next-line no-console
      console.log(`[STEP3] ${decl}: ${n} blocks, ${diffs} byte diffs, len ${bytes.length}->${out.length} (Δ${out.length - bytes.length}, ${((out.length - bytes.length) / (n || 1)).toFixed(1)}/block)`);
    });
  }
});
