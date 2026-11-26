/**
 * Facts that belong to the map's MOD and are handed in by the caller (from the mod's profile)
 * instead of being read from the editor's reference tables.
 */
import { describe, it, expect } from "vitest";
import { DECODE_TABLES, buildDecorSet, buildWallSet, diplomacyRaceCategory, recipeLacks } from "../src/index";

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

describe("recipeLacks: what a mod has nothing to place for", () => {
  const wall = (id: string, orient: string) => ({ id, shape: "wall", cx: 1, cy: 1, iso: { orient } });
  const decor = (id: string, shape: string, cx = 1) => ({ id, shape, cx, cy: cx });
  const fence = (id: string, orient: string) => ({ id, shape: "fence", cx: 1, cy: 1, iso: { orient } });
  const full = [
    wall("G000MG0201", "NE-SW"), wall("G000MG0202", "NW-SE"), wall("G000MG0203", "corner"),
    fence("G000MG8297", "NE-SW"), fence("G000MG8296", "NW-SE"), fence("G000MG8298", "corner"),
    decor("G000MG8109", "rock"), decor("G000MG0136", "vegetation"),
    decor("G000MG0033", "ruin-building"), decor("G000MG0031", "grave"),
  ];
  const sets = (catalog: object[]) => ({
    walls: buildWallSet(catalog as never),
    decor: buildDecorSet(catalog as never),
  });

  it("is nothing for a mod that has every kind of decoration and a wall set", () => {
    for (const id of Object.keys(DECODE_TABLES)) expect(recipeLacks(id, sets(full)), id).toBeUndefined();
  });

  it("names the missing decorations: a mod without 1×1 rocks cannot scatter rocks", () => {
    // Nazar's Legacy has no rock at all; a big rock (3×3) is not something to scatter either
    const noRocks = [...full.filter((e) => e.shape !== "rock"), decor("G000MG9000", "rock", 3)];
    expect(recipeLacks("decor_rocks", sets(noRocks))).toBe("в этом моде нет таких украшений");
    expect(recipeLacks("decor_bushes", sets(noRocks))).toBeUndefined();
    // terrain recipes need nothing from the catalogue
    for (const id of ["mountain_blob", "relief_ridge", "water_lake", "forest_fill", "road_path", "snow_patches"]) {
      expect(recipeLacks(id, sets([])), id).toBeUndefined();
    }
  });

  it("names the missing walls for the maze, and says nothing about an unknown recipe", () => {
    expect(recipeLacks("wall_maze", sets(full.filter((e) => e.shape !== "wall")))).toBe("в этом моде нет стен для лабиринта");
    expect(recipeLacks("no_such_recipe", sets([]))).toBeUndefined();
  });
});
