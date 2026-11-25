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
  readVariable,
  setRule,
  summaryOf,
  tableOf,
  unsupportedVariables,
  variableIssues,
  variableForms,
  writeVariable,
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

  it("lists the names a definition is read under", () => {
    const build = catalog.variables[0]!;
    expect(variableForms(catalog, build)).toEqual([
      { name: "MULTIPLE_BUILD_CAPITAL", race: null },
      { name: "EMPIRE_MULTIPLE_BUILD_CAPITAL", race: "empire" },
      { name: "ELVES_MULTIPLE_BUILD_CAPITAL", race: "elves" },
    ]);
    expect(variableForms(catalog, catalog.variables[3]!)).toEqual([{ name: "PERK_LVL_SPECIAL", race: null }]);
    expect(variableForms(catalog, catalog.variables[2]!)).toEqual([]); // a prefix has no fixed names
  });
});

describe("reading and writing a map's scenario variables", () => {
  const vars = [
    { id: 1, name: "COUNTER", value: 5 },
    { id: 4, name: "MULTIPLE_BUILD_CAPITAL", value: -1 },
  ];

  it("reads a value, or null when the map has no such variable", () => {
    expect(readVariable(vars, "MULTIPLE_BUILD_CAPITAL")).toBe(-1);
    expect(readVariable(vars, "HIRE_UNIT_ANY_RACE")).toBeNull();
  });

  it("changes a value in place, keeping the id events refer to", () => {
    const next = writeVariable(vars, "MULTIPLE_BUILD_CAPITAL", 1);
    expect(next).toEqual([vars[0], { id: 4, name: "MULTIPLE_BUILD_CAPITAL", value: 1 }]);
    expect(vars[1]!.value).toBe(-1); // the input is not modified
  });

  it("adds a new variable under the next free id", () => {
    expect(writeVariable(vars, "EMPIRE_MULTIPLE_BUILD_CAPITAL", -1)).toEqual([
      ...vars,
      { id: 5, name: "EMPIRE_MULTIPLE_BUILD_CAPITAL", value: -1 },
    ]);
    expect(writeVariable([], "HIRE_UNIT_ANY_RACE", 1)).toEqual([{ id: 1, name: "HIRE_UNIT_ANY_RACE", value: 1 }]);
  });

  it("removes a variable with null and returns the same list when nothing changes", () => {
    expect(writeVariable(vars, "MULTIPLE_BUILD_CAPITAL", null)).toEqual([vars[0]]);
    expect(writeVariable(vars, "NOPE", null)).toBe(vars);
    expect(writeVariable(vars, "COUNTER", 5)).toBe(vars);
  });
});

describe("rules a mod does not read", () => {
  const catalog = ScenVariableCatalog.parse({
    schemaVersion: 1,
    racePrefixes: { empire: "EMPIRE_", elves: "ELVES_" },
    variables: [{ name: "MULTIPLE_BUILD_CAPITAL", scope: "perRace", source: "mss32" }],
    unsupported: [
      { name: "START_LEADER_CHANGE_MODE", source: "mss32", title: "Starting stack" },
      { name: "HIRE_UNIT_TIER_MAX", scope: "perRace", source: "mss32" },
      { name: "PERK_LVL_", prefix: true, source: "lua" },
      { name: "MULTIPLE_BUILD_CAPITAL", source: "lua" }, // the mod reads it: never reported
    ],
  });
  const vars = [
    { id: 1, name: "COUNTER", value: 3 }, // the map's own: nobody's business
    { id: 2, name: "START_LEADER_CHANGE_MODE", value: 1 },
    { id: 3, name: "ELVES_HIRE_UNIT_TIER_MAX", value: 4 },
    { id: 4, name: "PERK_LVL_EMPIRE_G201UM0001", value: 2 },
    { id: 5, name: "EMPIRE_MULTIPLE_BUILD_CAPITAL", value: -1 },
  ];

  it("finds exactly the variables that expect an effect this mod will not give", () => {
    expect(unsupportedVariables(catalog, vars).map((u) => u.name)).toEqual([
      "START_LEADER_CHANGE_MODE", "ELVES_HIRE_UNIT_TIER_MAX", "PERK_LVL_EMPIRE_G201UM0001",
    ]);
    expect(unsupportedVariables(ScenVariableCatalog.parse({ schemaVersion: 1 }), vars)).toEqual([]);
  });

  it("reports them as warnings of a compatibility report", () => {
    const issues = variableIssues(catalog, vars);
    expect(issues.map((i) => [i.code, i.severity])).toEqual([
      ["UNKNOWN_SCEN_VARIABLE", "warning"], ["UNKNOWN_SCEN_VARIABLE", "warning"], ["UNKNOWN_SCEN_VARIABLE", "warning"],
    ]);
    expect(issues[0]!.message).toBe("variable START_LEADER_CHANGE_MODE = 1 sets a rule this mod does not read (Starting stack)");
  });
});

describe("setRule", () => {
  const catalog = ScenVariableCatalog.parse({
    schemaVersion: 1,
    racePrefixes: { empire: "EMPIRE_", elves: "ELVES_" },
    groups: [{ id: "cityGold", title: "City income: gold" }],
    variables: [
      { name: "MULTIPLE_BUILD_CAPITAL", scope: "perRace", source: "mss32" },
      { name: "TIER_1_CITY_GOLD_INCOME", scope: "perRace", raceMode: "add", group: "cityGold", source: "mss32" },
      { name: "ITEM_CAN_STEAL_LESS_COST_SUM", absentValue: null, source: "mss32" },
      {
        name: "TRANSF_COOLDOWN_MOD",
        absentValue: -1,
        source: "mss32",
        companions: ["TRANSF_COOLDOWN_HU", "TRANSF_COOLDOWN_EL"],
      },
    ],
  });
  const [build, income, steal, cooldown] = catalog.variables as [
    (typeof catalog.variables)[0], (typeof catalog.variables)[0], (typeof catalog.variables)[0], (typeof catalog.variables)[0],
  ];
  const names = (list: readonly { name: string; value: number }[]): string[] => list.map((v) => `${v.name}=${v.value}`);

  it("defaults: a race form overrides, absence reads as 0", () => {
    expect(build.raceMode).toBe("override");
    expect(build.absentValue).toBe(0);
    expect(catalog.groups).toEqual([{ id: "cityGold", title: "City income: gold" }]);
  });

  it("sets and removes a variable no event refers to", () => {
    const set = setRule(catalog, [], build, "EMPIRE_MULTIPLE_BUILD_CAPITAL", -1);
    expect(set).toEqual({ variables: [{ id: 1, name: "EMPIRE_MULTIPLE_BUILD_CAPITAL", value: -1 }], blocked: false });
    expect(setRule(catalog, set.variables, build, "EMPIRE_MULTIPLE_BUILD_CAPITAL", null).variables).toEqual([]);
  });

  it("keeps a variable an event refers to, giving it the value its absence means", () => {
    const vars = [{ id: 7, name: "MULTIPLE_BUILD_CAPITAL", value: 3 }];
    const out = setRule(catalog, vars, build, "MULTIPLE_BUILD_CAPITAL", null, new Set([7]));
    expect(out).toEqual({ variables: [{ id: 7, name: "MULTIPLE_BUILD_CAPITAL", value: 0 }], blocked: false });
  });

  it("does not pretend a race override can be switched off by a number", () => {
    // EMPIRE_…=0 would still replace the common rule for the Empire: nothing equals "no variable"
    const vars = [{ id: 7, name: "EMPIRE_MULTIPLE_BUILD_CAPITAL", value: -1 }];
    const out = setRule(catalog, vars, build, "EMPIRE_MULTIPLE_BUILD_CAPITAL", null, new Set([7]));
    expect(out.blocked).toBe(true);
    expect(out.variables).toBe(vars);
    // a race value that is ADDED to the common one is switched off by 0
    const inc = [{ id: 2, name: "ELVES_TIER_1_CITY_GOLD_INCOME", value: 40 }];
    expect(setRule(catalog, inc, income, "ELVES_TIER_1_CITY_GOLD_INCOME", null, new Set([2]))).toEqual({
      variables: [{ id: 2, name: "ELVES_TIER_1_CITY_GOLD_INCOME", value: 0 }],
      blocked: false,
    });
  });

  it("blocks when absence means something no number says", () => {
    const vars = [{ id: 3, name: "ITEM_CAN_STEAL_LESS_COST_SUM", value: 500 }];
    expect(setRule(catalog, vars, steal, "ITEM_CAN_STEAL_LESS_COST_SUM", null, new Set([3])).blocked).toBe(true);
    expect(setRule(catalog, vars, steal, "ITEM_CAN_STEAL_LESS_COST_SUM", null).variables).toEqual([]);
  });

  it("creates the game's state variables with the rule and removes them with it", () => {
    const on = setRule(catalog, [{ id: 4, name: "COUNTER", value: 1 }], cooldown, "TRANSF_COOLDOWN_MOD", 2);
    expect(names(on.variables)).toEqual([
      "COUNTER=1", "TRANSF_COOLDOWN_MOD=2", "TRANSF_COOLDOWN_HU=0", "TRANSF_COOLDOWN_EL=0",
    ]);
    // changing the value leaves the state variables (and whatever the game stored) alone
    const changed = setRule(catalog, on.variables.map((v) => (v.name === "TRANSF_COOLDOWN_HU" ? { ...v, value: 9 } : v)), cooldown, "TRANSF_COOLDOWN_MOD", 5);
    expect(names(changed.variables)).toContain("TRANSF_COOLDOWN_HU=9");
    // the absent value switches the rule off just like removing it
    expect(names(setRule(catalog, on.variables, cooldown, "TRANSF_COOLDOWN_MOD", -1).variables)).toEqual([
      "COUNTER=1", "TRANSF_COOLDOWN_MOD=-1",
    ]);
    const hu = on.variables.find((v) => v.name === "TRANSF_COOLDOWN_HU")!;
    const off = setRule(catalog, on.variables, cooldown, "TRANSF_COOLDOWN_MOD", null, new Set([hu.id]));
    expect(names(off.variables)).toEqual(["COUNTER=1", "TRANSF_COOLDOWN_HU=0"]); // an event still uses HU
  });
});
