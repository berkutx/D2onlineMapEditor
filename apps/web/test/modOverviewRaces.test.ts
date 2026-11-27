// The overview's races block lists every race the Races tile counts, not only the rebuilt ones.
import { describe, expect, it } from "vitest";
import type { RaceChange, RaceMembers } from "@d2/mod-diff";
import { overviewRaces, raceChangeCount } from "../src/mods/raceRows";

const ref = (id: string) => ({ section: "units" as const, id, name: null });
function members(added = 0, removed = 0, changed = 0, viaShared = 0): RaceMembers {
  return {
    countA: 10,
    countB: 10 + added - removed,
    added: Array.from({ length: added }, (_, i) => ref(`G000UU1${i}`)),
    removed: Array.from({ length: removed }, (_, i) => ref(`G000UU2${i}`)),
    changed: [
      ...Array.from({ length: changed }, (_, i) => ({ ...ref(`G000UU3${i}`), status: "changed" as const })),
      ...Array.from({ length: viaShared }, (_, i) => ({ ...ref(`G000UU4${i}`), status: "via-shared" as const })),
    ],
    copies: [],
  };
}
function race(id: string, o: { score?: number; units?: RaceMembers; presence?: RaceChange["presence"] } = {}): RaceChange {
  return {
    id,
    nameA: id,
    nameB: id,
    presence: o.presence ?? "both",
    status: null,
    raceType: null,
    lrace: null,
    capitalSection: null,
    code: null,
    slots: [],
    units: o.units ?? members(),
    buildings: members(),
    lords: members(),
    owned: [],
    lists: [],
    capital: null,
    pictures: [],
    redesign: { score: o.score ?? 0, redesigned: (o.score ?? 0) >= 0.5, parts: { units: 0, buildings: 0, capital: 0, slots: 0 } },
  };
}

describe("overviewRaces", () => {
  it("lists a race whose units only changed (score 0), after the rebuilt ones, the most changed first", () => {
    const races = [
      race("EMPIRE", { units: members(2, 0, 33) }),
      race("ELVES", { units: members(1, 0, 25) }),
      race("UNDEAD", { score: 0.01, units: members(2, 0, 25) }),
      race("NEUTRAL", { score: 0.001, units: members(2, 5, 205) }),
      race("UNCHANGED"),
    ];
    const ids = overviewRaces(races, ["EMPIRE", "ELVES", "UNDEAD", "NEUTRAL"]).map((r) => r.id);
    expect(ids).toEqual(["UNDEAD", "NEUTRAL", "EMPIRE", "ELVES"]);
  });

  it("keeps a race only one mod has, and leaves out an unchanged one", () => {
    const ids = overviewRaces([race("SAME"), race("NEW", { presence: "onlyB" })], []).map((r) => r.id);
    expect(ids).toEqual(["NEW"]);
  });

  it("counts a member changed only through a shared row as no change of its own", () => {
    expect(raceChangeCount(race("X", { units: members(1, 2, 3, 40) }))).toBe(6);
  });
});
