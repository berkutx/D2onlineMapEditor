import { describe, expect, it } from "vitest";
import { formatRoleBadges, sumRoleCounts } from "../src/services/scenarioRoles";

describe("zone role summaries", () => {
  it("includes target roles from every location and skips locations without roles", () => {
    const total = sumRoleCounts([
      { trigger: 1, target: 2, spawn: 0, destination: 1, env: 0 },
      undefined,
      { trigger: 0, target: 1, spawn: 2, destination: 0, env: 1 },
    ]);
    expect(total).toEqual({ trigger: 1, target: 3, spawn: 2, destination: 1, env: 1 });
    expect(formatRoleBadges(total)).toBe("⚡ 🎯3 ✨2 ➜ ☁");
  });

  it("returns a complete empty count without sharing mutable totals", () => {
    const total = sumRoleCounts([]);
    expect(total).toEqual({ trigger: 0, target: 0, spawn: 0, destination: 0, env: 0 });
    total.trigger = 7;
    expect(formatRoleBadges(sumRoleCounts([]))).toBe("");
  });
});
