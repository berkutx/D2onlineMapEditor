import { describe, expect, it } from "vitest";
import { createBlankMap, parseScenario, parseScenarioRaw, serializeMapFromModelBytes } from "@d2/sg-parser";
import { decodeDiplomacyRelation, readDiplomacyRelation, setDiplomacyCurrent, diplomacyRaceCategory } from "../src/diplomacy.js";
import { applyEditsToBytes } from "../src/applyBytes.js";
import type { DiplomacyEntry } from "@d2/map-schema";

const packed = (0x80000001 | (7123 << 15) | (83 << 8) | (19 << 1)) | 0;
const entries = (): DiplomacyEntry[] => [{ race1: 3, race2: 0, relation: packed },
  { race1: 0, race2: 3, relation: (0x40000000 | (7 << 1)) | 0 }, { race1: 1, race2: 5, relation: -1 }];

describe("packed editor diplomacy", () => {
  it("decodes meter independently of alliance and high flags, including signed SG words", () => {
    expect(decodeDiplomacyRelation(packed)).toEqual({ current: 19, previous: 83, alliance: true, alwaysWar: false, unbreakable: true });
    expect(decodeDiplomacyRelation(-1)).toEqual({ current: 127, previous: 127, alliance: true, alwaysWar: true, unbreakable: true });
    expect(readDiplomacyRelation([], 0, 3)).toEqual({ current: 0, previous: 0, alliance: false, alwaysWar: false, unbreakable: false });
  });
  it("updates only the first undirected pair, retaining raw flags, orientation, duplicates and order", () => {
    const input = entries(), before = structuredClone(input), updated = setDiplomacyCurrent(input, 0, 3, 49);
    expect(updated[0]).toEqual({ race1: 3, race2: 0, relation: ((packed & 0xffffff01) | 98) | 0 });
    expect(updated[0]!.relation & ~254).toBe(packed & ~254);
    expect(updated[1]).toBe(input[1]); expect(updated[2]).toBe(input[2]); expect(input).toEqual(before);
    expect(setDiplomacyCurrent(updated, 3, 0, 49)).toBe(updated);
  });
  it("locks a first always-war entry and appends a missing entry with zero-initialized flags", () => {
    const input = [entries()[1]!, entries()[0]!];
    expect(setDiplomacyCurrent(input, 0, 3, 100)).toBe(input);
    const next = setDiplomacyCurrent(input, 2, 5, 49);
    expect(next.slice(0, 2)).toEqual(input); expect(next[2]).toEqual({ race1: 2, race2: 5, relation: 98 });
    expect(decodeDiplomacyRelation(next[2]!.relation).alliance).toBe(false);
    expect(setDiplomacyCurrent([], 5, 4, 0)).toEqual([{ race1: 5, race2: 4, relation: 0 }]);
  });
  it.each([-1, 101, 0.5, NaN, Infinity])("rejects invalid meter %s without clamping or mutation", meter => {
    const input = entries(), before = structuredClone(input); expect(() => setDiplomacyCurrent(input, 0, 3, meter)).toThrow(RangeError); expect(input).toEqual(before);
  });
  it("resolves supported RACE_ID categories rather than Grace indices", () => {
    expect([0,1,2,3,4,5].map(index => diplomacyRaceCategory({ raceId: 'G000RR000' + index }))).toEqual([0,3,2,1,4,5]);
    expect(diplomacyRaceCategory({})).toBeNull(); expect(diplomacyRaceCategory({ raceId: 'G000RR0099' })).toBeNull();
  });
  it.each([0, 49, 100])("keeps signed flags and every other entry through both SG export paths at meter %i", meter => {
    const blank = createBlankMap({ size: 24, name: 'Synthetic packed diplomacy', races: ['empire', 'clans'] });
    const initial = parseScenario(blank); initial.diplomacy = entries();
    const base = serializeMapFromModelBytes(blank, initial), parsed = parseScenarioRaw(base);
    expect(parsed.doc.diplomacy).toEqual(entries());
    const next = [...setDiplomacyCurrent(parsed.doc.diplomacy, 0, 3, meter)];
    const op = { kind: 'setDiplomacy' as const, diplomacy: next };
    const patched = applyEditsToBytes(parsed.raw, [op]);
    const rebuilt = serializeMapFromModelBytes(base, { ...parsed.doc, diplomacy: next });
    for (const output of [patched, rebuilt]) {
      const actual = parseScenario(output); expect(actual.diplomacy).toEqual(next);
      expect(actual.players).toEqual(parsed.doc.players); expect(actual.objects).toEqual(parsed.doc.objects); expect(actual.header).toEqual(parsed.doc.header);
      expect(actual.diplomacy.slice(1)).toEqual(entries().slice(1)); expect(actual.diplomacy[0]!.relation).toBeLessThan(0);
    }
    // Same list size: patch changes only the meter-containing byte in the first word.
    const differences = [...base.keys()].filter(index => base[index] !== patched[index]);
    expect(patched.length).toBe(base.length); expect(differences).toHaveLength(1);
  });
});
