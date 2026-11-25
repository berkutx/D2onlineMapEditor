/**
 * Map ↔ mod compatibility and mod detection, on synthetic id sets shaped like the real
 * mods: three families (smns, legacy, semga) that share a base-game core and each add their
 * own ids, and two semga versions where the newer one is a superset of the older.
 */
import { describe, it, expect } from "vitest";
import {
  detectMod,
  indexIdSets,
  scoreCompatibility,
  CompatibilityReport,
  ModDetection,
  UNRESOLVED_GLOBAL_ID,
  UNRESOLVED_SCRIPT_ID,
  type IdSets,
  type ModCandidateInput,
} from "../src/index";

const ids = (prefix: string, table: string, from: number, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `G${prefix}${table}${String(from + i).padStart(4, "0")}`);

/** Ids every mod has (the base game). */
const CORE = {
  UU: ids("000", "UU", 1, 40),
  IG: ids("000", "IG", 1, 30),
  SS: ids("000", "SS", 1, 20),
  MG: ids("000", "MG", 1, 20),
  LR: ids("000", "LR", 1, 6),
  RR: ids("000", "RR", 0, 6),
};
const sets = (extra: Record<string, string[]>): IdSets => {
  const tables: Record<string, string[]> = {};
  for (const [t, v] of Object.entries(CORE)) tables[t] = [...v];
  for (const [t, v] of Object.entries(extra)) tables[t] = [...(tables[t] ?? []), ...v];
  return { schemaVersion: 1, tables };
};

const SEMGA_ONLY = { IG: ids("000", "IG", 7000, 30), MG: ids("000", "MG", 8000, 20), UM: ids("201", "UM", 9000, 30) };
const SEMGA2_ONLY = { IG: ids("001", "IG", 800, 10), SS: ids("000", "SS", 225, 5), UM: ids("121", "UM", 1, 20) };
const SMNS_ONLY = { UU: ids("070", "UU", 9000, 4), IG: ids("002", "IG", 1, 10), UM: ids("070", "UM", 1, 40) };
const LEGACY_ONLY = { UU: ids("000", "UU", 9150, 40), IG: ids("000", "IG", 9100, 20), UM: ids("000", "UM", 9000, 30) };

const merge = (...parts: Record<string, string[]>[]): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const p of parts) for (const [t, v] of Object.entries(p)) out[t] = [...(out[t] ?? []), ...v];
  return out;
};

const MODS: (ModCandidateInput & { idSets: IdSets })[] = [
  { id: "smns3", family: "smns", familyOrder: 3, idSets: sets(SMNS_ONLY) },
  { id: "nazar-legacy", family: "legacy", familyOrder: 1, idSets: sets(LEGACY_ONLY) },
  { id: "semga", family: "semga", familyOrder: 1, idSets: sets(SEMGA_ONLY) },
  { id: "semga-2", family: "semga", familyOrder: 2, idSets: sets(merge(SEMGA_ONLY, SEMGA2_ONLY)) },
];

/** A map: a slice of the core plus some ids of its own mod. */
const mapOf = (own: Record<string, string[]>, take = 12): Record<string, string[]> =>
  merge(
    Object.fromEntries(Object.entries(CORE).map(([t, v]) => [t, v.slice(0, 5)])),
    Object.fromEntries(Object.entries(own).map(([t, v]) => [t, v.slice(0, take)])),
  );

describe("scoreCompatibility", () => {
  it("reports nothing for a map whose ids the mod defines", () => {
    const r = scoreCompatibility(mapOf(SEMGA_ONLY), indexIdSets(MODS[2]!.idSets));
    expect(r.missing).toBe(0);
    expect(r.checked).toBe(5 * 6 + 12 * 3);
    expect(r.report).toEqual({ playable: true, issues: [], capabilities: [] });
    expect(CompatibilityReport.safeParse(r.report).success).toBe(true);
  });

  it("lists unresolved ids per table as one error issue each", () => {
    const r = scoreCompatibility(mapOf(LEGACY_ONLY), indexIdSets(MODS[0]!.idSets));
    expect(r.missing).toBe(36);
    expect(Object.keys(r.missingByTable)).toEqual(["IG", "UM", "UU"]);
    expect(r.missingByTable["UU"]![0]).toBe("G000UU9150");
    expect(r.report.playable).toBe(false);
    expect(r.report.issues.map((i) => [i.code, i.severity])).toEqual([
      [UNRESOLVED_GLOBAL_ID, "error"],
      [UNRESOLVED_GLOBAL_ID, "error"],
      [UNRESOLVED_GLOBAL_ID, "error"],
    ]);
    expect(r.report.issues[0]!.message).toContain("12 IG id(s)");
    expect(r.report.issues[0]!.message).toContain("(+4)");
  });

  it("checks only tables the mod indexes and matches ids case-insensitively", () => {
    const defined = indexIdSets({ schemaVersion: 1, tables: { UU: ["G000UU0001"] } });
    const r = scoreCompatibility({ UU: ["g000uu0001", "G000UU0002"], BB: ["G000BB0001"] }, defined);
    expect(r.checked).toBe(2);
    expect(r.missingByTable).toEqual({ UU: ["G000UU0002"] });
  });

  it("treats ids quoted in script text as warnings: the map stays playable", () => {
    const r = scoreCompatibility(mapOf({}), indexIdSets(MODS[2]!.idSets), { UM: ["G070UM0001", "G201UM9000"] });
    expect(r.missing).toBe(0);
    expect(r.scriptChecked).toBe(2);
    expect(r.scriptMissingByTable).toEqual({ UM: ["G070UM0001"] });
    expect(r.report.playable).toBe(true);
    expect(r.report.issues).toHaveLength(1);
    expect(r.report.issues[0]).toMatchObject({ code: UNRESOLVED_SCRIPT_ID, severity: "warning" });
  });
});

describe("detectMod", () => {
  it("detects the family whose tables resolve the map", () => {
    for (const [own, expected] of [
      [SMNS_ONLY, "smns3"],
      [LEGACY_ONLY, "nazar-legacy"],
    ] as const) {
      const d = detectMod(mapOf(own), MODS);
      expect(d.status).toBe("detected");
      expect(d.modId).toBe(expected);
      expect(d.candidates[0]!.missing).toBe(0);
      expect(d.margin).toBeGreaterThanOrEqual(20);
      expect(ModDetection.safeParse(d).success).toBe(true);
    }
  });

  it("opens a map that fits two versions of a family on the newer one", () => {
    const d = detectMod(mapOf(SEMGA_ONLY), MODS);
    expect(d.status).toBe("detected");
    expect(d.modId).toBe("semga-2");
    expect(d.candidates.slice(0, 2).map((c) => [c.modId, c.missing])).toEqual([
      ["semga-2", 0],
      ["semga", 0],
    ]);
  });

  it("a map using ids only the newer version has does not fit the older one", () => {
    const map = merge(mapOf(SEMGA_ONLY), { IG: SEMGA2_ONLY.IG, SS: SEMGA2_ONLY.SS });
    const d = detectMod(map, MODS);
    expect(d.modId).toBe("semga-2");
    expect(d.candidates[0]!.missing).toBe(0);
    const older = d.candidates.find((c) => c.modId === "semga")!;
    expect(older.missing).toBe(10 + 5);
    expect(older.missingByTable).toEqual({ IG: SEMGA2_ONLY.IG, SS: SEMGA2_ONLY.SS });
    expect(older.report.playable).toBe(false);
  });

  it("still detects the mod when the map references ids its own mod lacks", () => {
    // like the SMNS 3.0 sagas: 61 item types that are not in the mod's own GItem
    const map = merge(mapOf(SMNS_ONLY), { IG: ids("000", "IG", 5000, 61) });
    const d = detectMod(map, MODS);
    expect(d.status).toBe("detected");
    expect(d.modId).toBe("smns3");
    expect(d.candidates[0]!.missing).toBe(61);
    expect(d.candidates[0]!.report.playable).toBe(false);
    expect(d.margin).toBeGreaterThan(0);
  });

  it("is undetermined for a map that uses only ids every mod has", () => {
    const blank = { UU: CORE.UU.slice(0, 2), RR: CORE.RR.slice(0, 2), LR: CORE.LR.slice(0, 2) };
    const d = detectMod(blank, MODS);
    expect(d.status).toBe("undetermined");
    expect(d.modId).toBeNull();
    expect(d.margin).toBe(0);
    expect(d.candidates).toHaveLength(4);
    expect(detectMod({}, MODS).status).toBe("undetermined");
  });

  it("uses script-text ids as evidence too", () => {
    const blank = { UU: CORE.UU.slice(0, 2) };
    const d = detectMod(blank, MODS, { scriptRefs: { UM: SMNS_ONLY.UM.slice(0, 20) } });
    expect(d.status).toBe("detected");
    expect(d.modId).toBe("smns3");
    expect(d.candidates[0]!.scriptMissing).toBe(0);
    expect(d.candidates[1]!.scriptMissing).toBe(20);
  });

  it("does not offer data-only mods unless asked", () => {
    const mods = MODS.map((m) => (m.id === "semga-2" ? { ...m, status: "data-only" as const } : m));
    expect(detectMod(mapOf(SEMGA_ONLY), mods).modId).toBe("semga");
    expect(detectMod(mapOf(SEMGA_ONLY), mods, { includeDataOnly: true }).modId).toBe("semga-2");
    // a map that needs the data-only version is detected as the older one, with unresolved ids
    const d = detectMod(merge(mapOf(SEMGA_ONLY), { IG: SEMGA2_ONLY.IG }), mods);
    expect(d.modId).toBe("semga");
    expect(d.candidates[0]!.missing).toBe(SEMGA2_ONLY.IG.length);
  });

  it("with a single installed family any map resolves to its newest fitting version", () => {
    const semgaOnly = MODS.filter((m) => m.family === "semga");
    const d = detectMod({}, semgaOnly);
    expect(d).toMatchObject({ status: "detected", modId: "semga-2", margin: null });
  });

  it("returns undetermined when no mod is installed", () => {
    expect(detectMod(mapOf(SEMGA_ONLY), [])).toEqual({ status: "undetermined", modId: null, margin: null, candidates: [] });
  });

  it("accepts prebuilt id indexes in place of id sets", () => {
    const indexed: ModCandidateInput[] = MODS.map((m) => ({ ...m, idSets: indexIdSets(m.idSets) }));
    expect(detectMod(mapOf(LEGACY_ONLY), indexed)).toEqual(detectMod(mapOf(LEGACY_ONLY), MODS));
  });

  it("ranks deterministically regardless of input order", () => {
    const a = detectMod(mapOf(LEGACY_ONLY), MODS).candidates.map((c) => c.modId);
    const b = detectMod(mapOf(LEGACY_ONLY), [...MODS].reverse()).candidates.map((c) => c.modId);
    expect(b).toEqual(a);
    expect(a[0]).toBe("nazar-legacy");
  });
});
