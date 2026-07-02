import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseScenario,
  parseScenarioRaw,
  SgWriter,
  roundTripIdentity,
  verifyCellOffsets,
  validateMap,
  verifyBlockIntegrity,
} from "../src/index";

const CAMPAIGN = String.raw`C:\GOG Games\last_version\Game\Campaign`;
const RIDERS = join(CAMPAIGN, "The Power of Eldunari-v1-2 maps", "Riders.sg");

function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

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

function countDiffs(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let d = Math.abs(a.length - b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d;
}

describe("@d2/sg-parser writer — round-trip integrity", () => {
  const bytes = read(RIDERS);

  it("re-emits Riders.sg byte-for-byte with zero edits (BlockComparator equivalent)", () => {
    expect(roundTripIdentity(bytes)).toBe(true);
  });

  it("the cell offset index reads back every parsed value (setCell will land correctly)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    expect(verifyCellOffsets(raw, doc)).toBe(0);
  });

  it("validateMap passes a real, untouched map", () => {
    const { doc } = parseScenarioRaw(bytes);
    const res = validateMap(doc);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("a single setCell edit perturbs ONLY that cell (<=4 bytes) and nothing else", () => {
    const { doc: doc1, raw } = parseScenarioRaw(bytes);
    const size = doc1.size;
    const tx = 10;
    const ty = 10;
    const idx = ty * size + tx;
    const before = doc1.terrain.cells[idx]!;
    const newValue = (before.value ^ 0x7) | 0; // flip terrain bits -> guaranteed different

    const w = new SgWriter(raw);
    w.setCellValue(tx, ty, newValue);
    const out = w.toBytes();

    // exactly one int32 changed -> at most 4 differing bytes, at least 1
    const diffs = countDiffs(bytes, out);
    expect(diffs).toBeGreaterThan(0);
    expect(diffs).toBeLessThanOrEqual(4);

    // reparse: the target cell took the new value; every other cell is identical
    const doc2 = parseScenario(out);
    expect(doc2.terrain.cells[idx]!.value).toBe(newValue);
    expect(doc2.terrain.cells[idx]!.terrain).toBe(newValue & 7);
    for (let i = 0; i < doc2.terrain.cells.length; i++) {
      if (i === idx) continue;
      expect(doc2.terrain.cells[i]).toEqual(doc1.terrain.cells[i]);
    }
    // objects / players / header untouched
    expect(doc2.objects).toEqual(doc1.objects);
    expect(doc2.players).toEqual(doc1.players);
    expect(doc2.header).toEqual(doc1.header);
  });

  it("moveObject rewrites only POS_X/POS_Y (<=8 bytes) and leaves all else intact", () => {
    const { doc: doc1, raw } = parseScenarioRaw(bytes);
    // pick a 1:1, placed object (stack/village/crystal) present in the byte index,
    // not a multi-expanded MidMountains, whose move target stays on the map
    const target = doc1.objects.find(
      (o) =>
        (o.type === "stack" || o.type === "village" || o.type === "crystal") &&
        raw.objectById.has(o.id) &&
        o.pos.x >= 0 && o.pos.x < doc1.size - 5 && o.pos.y >= 0 && o.pos.y < doc1.size - 5,
    );
    expect(target).toBeTruthy();
    const id = target!.id;
    const nx = target!.pos.x + 3;
    const ny = target!.pos.y + 2;

    const w = new SgWriter(raw);
    w.setObjectPos(id, nx, ny);
    const out = w.toBytes();

    const diffs = countDiffs(bytes, out);
    expect(diffs).toBeGreaterThan(0);
    expect(diffs).toBeLessThanOrEqual(8);

    const doc2 = parseScenario(out);
    const moved = doc2.objects.find((o) => o.id === id)!;
    expect(moved.pos).toEqual({ x: nx, y: ny });
    // every other object identical; terrain identical
    for (const o of doc1.objects) {
      if (o.id === id) continue;
      expect(doc2.objects.find((x) => x.id === o.id)).toEqual(o);
    }
    expect(doc2.terrain).toEqual(doc1.terrain);
  });

  it("validateMap catches a corrupted document", () => {
    const { doc } = parseScenarioRaw(bytes);
    const broken = structuredClone(doc);
    broken.terrain.cells.pop(); // wrong cell count
    expect(validateMap(broken).ok).toBe(false);
  });
});

describe("@d2/sg-parser writer — round-trip across campaign maps", () => {
  const all = findSgFiles(CAMPAIGN);
  const sample = all.slice(0, 12);

  it("found .sg fixtures", () => {
    expect(sample.length).toBeGreaterThanOrEqual(5);
  });

  for (const path of sample) {
    const name = path.split(/[\\/]/).pop();
    it(`round-trips ${name} byte-exact + sound offsets + valid`, () => {
      const b = read(path);
      expect(roundTripIdentity(b)).toBe(true);
      const { doc, raw } = parseScenarioRaw(b);
      expect(verifyCellOffsets(raw, doc)).toBe(0);
      expect(validateMap(doc).errors).toEqual([]);
      // tier-3b byte integrity (OB0000 count + internal refs) must be CLEAN on every
      // real map — the false-positive guard for the new checker
      expect(verifyBlockIntegrity(b).errors).toEqual([]);
    });
  }
});
