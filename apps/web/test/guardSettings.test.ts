/** What the «Охрана по бюджету» window remembers: stored settings come back safe, whatever is in the storage. */
import { describe, expect, it } from "vitest";
import { GUARD_PRESETS, defaultGuardSettings, normalizeGuardSettings } from "../src/services/guardSettings";

describe("normalizeGuardSettings", () => {
  it("gives the defaults for nothing, and for something that is not an object", () => {
    expect(normalizeGuardSettings(null)).toEqual(defaultGuardSettings());
    expect(normalizeGuardSettings("450")).toEqual(defaultGuardSettings());
    expect(normalizeGuardSettings(undefined)).toEqual(defaultGuardSettings());
  });

  it("keeps a valid entry as it is", () => {
    const stored = {
      budget: 900, subrace: 6, roles: ["fighter", "mage"], maxUnits: 4, levelOn: true, level: 7, keepLeader: true,
      lootOn: true, lootBudget: 1200, lootCats: ["L_SCROLL", "L_VALUABLE"], lootMax: 3,
    };
    expect(normalizeGuardSettings(stored)).toEqual(stored);
    expect(normalizeGuardSettings({ ...stored, subrace: "mixed" }).subrace).toBe("mixed");
  });

  it("brings numbers into range and replaces what is broken", () => {
    const s = normalizeGuardSettings({
      budget: -5, subrace: "elves", roles: ["wizard"], maxUnits: 60, levelOn: "yes", level: 0, keepLeader: 1,
      lootOn: "on", lootBudget: "many", lootCats: ["L_ORB", 7, null], lootMax: 0,
    });
    const d = defaultGuardSettings();
    expect(s.budget).toBe(1);
    expect(s.subrace).toBe("one");
    expect(s.roles).toEqual(d.roles); // no known role left: all of them
    expect(s.maxUnits).toBe(6);
    expect(s.levelOn).toBe(false);
    expect(s.level).toBe(1);
    expect(s.keepLeader).toBe(false);
    expect(s.lootOn).toBe(false);
    expect(s.lootBudget).toBe(d.lootBudget);
    expect(s.lootCats).toEqual(["L_ORB"]);
    expect(s.lootMax).toBe(1);
  });

  it("keeps the roles in their own order and drops unknown ones", () => {
    expect(normalizeGuardSettings({ roles: ["support", "ninja", "fighter"] }).roles).toEqual(["fighter", "support"]);
  });

  it("the default strength is one of the presets", () => {
    expect(GUARD_PRESETS).toContain(defaultGuardSettings().budget);
  });
});
