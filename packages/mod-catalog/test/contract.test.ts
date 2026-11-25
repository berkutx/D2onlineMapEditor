import { describe, it, expect } from "vitest";
import {
  MOD_SCHEMA_VERSION,
  BlobPath,
  ModId,
  ModIndex,
  ModManifest,
  IdSets,
  ModProfile,
  ScenVariableCatalog,
  findScenVariable,
  raceFacts,
  summaryOf,
  tableOf,
} from "../src/index";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const blob = (sha: string, ext: string): string => `blobs/${sha.slice(0, 2)}/${sha}.${ext}`;

describe("@d2/mod-catalog manifest contract", () => {
  it("accepts mod ids that are lowercase slugs only", () => {
    for (const ok of ["smns3", "nazar-legacy", "semga-2", "default"]) expect(ModId.safeParse(ok).success).toBe(true);
    for (const bad of ["", "SMNS3", "semga 2", "-semga", "a/b", "мод"]) expect(ModId.safeParse(bad).success).toBe(false);
  });

  it("accepts a blob path only under its own two-hex directory", () => {
    expect(BlobPath.safeParse(blob(SHA_A, "png")).success).toBe(true);
    expect(BlobPath.safeParse(`blobs/bb/${SHA_A}.png`).success).toBe(false);
    expect(BlobPath.safeParse(`blobs/aa/${SHA_A}`).success).toBe(false);
    expect(BlobPath.safeParse(`../blobs/aa/${SHA_A}.png`).success).toBe(false);
  });

  it("applies defaults to a minimal manifest", () => {
    const m = ModManifest.parse({
      schemaVersion: MOD_SCHEMA_VERSION,
      id: "semga",
      name: "Сёмга",
      family: "semga",
      contentFingerprint: SHA_A,
      pipelineVersion: "2.0.0",
    });
    expect(m.familyOrder).toBe(0);
    expect(m.status).toBe("ready");
    expect(m.files).toEqual({});
    expect(m.capabilities).toEqual([]);
    expect(m.source).toEqual({});
    expect(m.parent).toBeUndefined();
  });

  it("validates logical file names and derives the index row", () => {
    const base = {
      schemaVersion: MOD_SCHEMA_VERSION,
      id: "semga-2",
      name: "Сёмга 2",
      family: "semga",
      familyOrder: 2,
      status: "data-only",
      contentFingerprint: SHA_B,
      pipelineVersion: "2.0.0",
      parent: { modId: "semga", contentFingerprint: SHA_A },
    } as const;
    const m = ModManifest.parse({
      ...base,
      files: { "unitCatalog.json": blob(SHA_A, "json"), "itemicons/g000ig0001.png": blob(SHA_B, "png") },
    });
    expect(summaryOf(m)).toEqual({
      id: "semga-2",
      name: "Сёмга 2",
      family: "semga",
      familyOrder: 2,
      status: "data-only",
      contentFingerprint: SHA_B,
    });
    for (const bad of ["/abs.json", "../up.json", "a/../b.json", "a\\b.json"]) {
      expect(ModManifest.safeParse({ ...base, files: { [bad]: blob(SHA_A, "json") } }).success, bad).toBe(false);
    }
  });

  it("parses an index with a default mod", () => {
    const idx = ModIndex.parse({
      schemaVersion: MOD_SCHEMA_VERSION,
      defaultModId: "semga",
      mods: [{ id: "semga", name: "Сёмга", family: "semga", contentFingerprint: SHA_A }],
    });
    expect(idx.mods[0]!.status).toBe("ready");
    expect(ModIndex.parse({ schemaVersion: MOD_SCHEMA_VERSION }).mods).toEqual([]);
  });
});

describe("@d2/mod-catalog data contracts", () => {
  it("id sets hold uppercase global ids keyed by table code", () => {
    expect(IdSets.safeParse({ schemaVersion: 1, tables: { UU: ["G000UU0001"], IG: [] } }).success).toBe(true);
    expect(IdSets.safeParse({ schemaVersion: 1, tables: { UU: ["g000uu0001"] } }).success).toBe(false);
    expect(IdSets.safeParse({ schemaVersion: 1, tables: { units: ["G000UU0001"] } }).success).toBe(false);
    expect(tableOf("g201um9378")).toBe("UM");
  });

  it("a profile carries what adding a race needs", () => {
    const p = ModProfile.parse({
      schemaVersion: 1,
      capitalItem: "G000IG0006",
      unitCount: 860,
      races: [
        { key: "empire", raceId: "G000RR0000", raceType: 0, name: "Империя", playable: true, guardian: "G000UU3001", guardianHp: 900, leader: "G000UU0019", leaderHp: 135, lord: "G000LR0003", terrain: 1 },
        { key: "neutral", raceId: "G000RR0004", raceType: 4, name: "Нейтралы", playable: false },
      ],
    });
    expect(p.races.filter((r) => r.playable).map((r) => r.key)).toEqual(["empire"]);
  });

  it("raceFacts keeps the playable races that are complete enough to create a player from", () => {
    const facts = raceFacts(
      ModProfile.parse({
        schemaVersion: 1,
        races: [
          { key: "empire", raceId: "G000RR0000", raceType: 0, name: "Империя", playable: true, guardian: "G000UU3001", guardianHp: 250, leader: "G000UU0019", leaderHp: 150, lord: "G000LR0003", terrain: 1 },
          { key: "neutral", raceId: "G000RR0004", raceType: 4, name: "Нейтралы", playable: false, lord: "G000LR0015", terrain: 5 },
          // playable, but the tables lack its leader's hit points: left to the caller's fallback
          { key: "elves", raceId: "G000RR0005", raceType: 5, name: "Эльфы", playable: true, guardian: "G000UU8040", guardianHp: 250, leader: "G000UU8009", lord: "G000LR0018", terrain: 6 },
        ],
      }),
    );
    expect(Object.keys(facts)).toEqual(["empire"]);
    expect(facts["empire"]).toEqual({
      raceId: "G000RR0000", raceType: 0, guardian: "G000UU3001", guardianHp: 250,
      leader: "G000UU0019", leaderHp: 150, lord: "G000LR0003", terrain: 1, name: "Империя",
    });
  });
});

describe("findScenVariable", () => {
  const catalog = ScenVariableCatalog.parse({
    schemaVersion: 1,
    racePrefixes: { empire: "EMPIRE_", elves: "ELVES_" },
    variables: [
      {
        name: "MULTIPLE_BUILD_CAPITAL",
        scope: "perRace",
        source: "mss32",
        presets: [
          { value: null, label: "one building per day" },
          { value: 1, label: "several buildings per day" },
          { value: -1, label: "building forbidden" },
        ],
      },
      { name: "HIRE_UNIT_ANY_RACE", kind: "flag", scope: "perRace", source: "mss32" },
      { name: "PERK_LVL_", prefix: true, source: "lua", origin: "modules/GroupInfo.lua" },
      { name: "PERK_LVL_SPECIAL", source: "lua" },
    ],
  });

  it("matches exact names and race-prefixed forms of per-race variables", () => {
    expect(findScenVariable(catalog, "MULTIPLE_BUILD_CAPITAL")?.name).toBe("MULTIPLE_BUILD_CAPITAL");
    expect(findScenVariable(catalog, "ELVES_MULTIPLE_BUILD_CAPITAL")?.name).toBe("MULTIPLE_BUILD_CAPITAL");
    expect(findScenVariable(catalog, "ORCS_MULTIPLE_BUILD_CAPITAL")).toBeUndefined();
  });

  it("matches prefix definitions, but an exact definition wins", () => {
    expect(findScenVariable(catalog, "PERK_LVL_EMPIRE_G201UM0001")?.origin).toBe("modules/GroupInfo.lua");
    expect(findScenVariable(catalog, "PERK_LVL_SPECIAL")?.prefix).toBe(false);
    expect(findScenVariable(catalog, "PERK_LVL_")).toBeUndefined(); // the bare prefix names nothing
  });

  it("returns undefined for names the mod gives no meaning to, case-sensitively", () => {
    expect(findScenVariable(catalog, "SMNS_INFO_TURN")).toBeUndefined();
    expect(findScenVariable(catalog, "hire_unit_any_race")).toBeUndefined();
  });
});
