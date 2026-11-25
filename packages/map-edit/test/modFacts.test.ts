/**
 * Facts that belong to the map's MOD and are handed in by the caller (from the mod's profile)
 * instead of being read from the editor's reference tables.
 */
import { describe, it, expect } from "vitest";
import { buildWallSet, diplomacyRaceCategory } from "../src/index";

describe("diplomacyRaceCategory", () => {
  it("uses the reference table of the stock factions when no mod table is given", () => {
    expect(diplomacyRaceCategory({ raceId: "g000rr0000" })).toBe(0); // Empire
    expect(diplomacyRaceCategory({ raceId: "G000RR0004" })).toBe(4); // neutrals
    expect(diplomacyRaceCategory({ raceId: "G070RR0009" })).toBeNull();
    expect(diplomacyRaceCategory({ raceId: "G000RR0000" }, {})).toBe(0); // an empty table = none
  });

  it("uses the mod's own table when there is one — and only it", () => {
    const mod = { G000RR0000: 0, G070RR0009: 7 };
    expect(diplomacyRaceCategory({ raceId: "g070rr0009" }, mod)).toBe(7); // a race the reference lacks
    expect(diplomacyRaceCategory({ raceId: "G000RR0000" }, mod)).toBe(0);
    // the reference knows the Clans, this mod does not: the mod is what the game will read
    expect(diplomacyRaceCategory({ raceId: "G000RR0001" }, mod)).toBeNull();
  });
});

describe("buildWallSet: the tower at maze junctions", () => {
  const wall = (id: string, orient: string) => ({ id, shape: "wall", cx: 1, cy: 1, iso: { orient } });
  const tower = (id: string, tone = "neutral") => ({ id, shape: "tower", cx: 1, cy: 1, tone, tags: [] });
  const catalog = [
    wall("G000MG0201", "NE-SW"), wall("G000MG0202", "NW-SE"), wall("G000MG0203", "corner"),
    tower("G000MG0100"), tower("G000MG0149", "dark"), tower("G000MG0777", "dark"),
  ];
  const towerOf = (set: ReturnType<typeof buildWallSet>): string | undefined => set.styles[0]?.tower;

  it("prefers the stock tower when the mod names none", () => {
    expect(towerOf(buildWallSet(catalog as never))).toBe("G000MG0149");
  });

  it("prefers the tower the mod's profile names", () => {
    expect(towerOf(buildWallSet(catalog as never, { preferredTower: "g000mg0777" }))).toBe("G000MG0777");
  });

  it("falls back to a neutral turret when the preferred one is not in the catalog", () => {
    const without = catalog.filter((e) => e.id !== "G000MG0149");
    expect(towerOf(buildWallSet(without as never))).toBe("G000MG0100");
  });
});
