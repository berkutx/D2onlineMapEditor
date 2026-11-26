import { describe, expect, it } from "vitest";
import {
  composeGuard,
  composeLoot,
  composeRuinReward,
  guardBudgetRange,
  guardRole,
  unitAtLevel,
  type GuardMember,
  type GuardResult,
  type GuardUnitInfo,
  type LootItemInfo,
} from "../src/guard.js";

/** A small mod: two races with a full roster each, a race with a leader only, the odd ones. */
function roster(): GuardUnitInfo[] {
  const out: GuardUnitInfo[] = [];
  const unit = (id: string, over: Partial<GuardUnitInfo>): void => {
    out.push({ id, level: 1, catKey: "L_SOLDIER", subraceId: 1, hp: 100, xp: 20, branch: "L_FIGHTER", dyn: [10, 10, 2, 5, 1], ...over });
  };
  for (const sub of [1, 2]) {
    const p = `S${sub}`;
    // leaders: a melee one, a mage, a big one
    unit(`${p}L1`, { subraceId: sub, catKey: "L_LEADER", leaderKey: "L_FIGHTER", branch: "L_HERO", melee: true, xp: 60, hp: 150, leadership: 6 });
    unit(`${p}L2`, { subraceId: sub, catKey: "L_LEADER", leaderKey: "L_MAGE", branch: "L_HERO", area: true, xp: 70, hp: 90, leadership: 6 });
    unit(`${p}L3`, { subraceId: sub, catKey: "L_LEADER", leaderKey: "L_FIGHTER", branch: "L_HERO", melee: true, large: true, xp: 300, hp: 500, leadership: 6 });
    unit(`${p}L4`, { subraceId: sub, catKey: "L_LEADER", leaderKey: "L_ROD", branch: "L_HERO", xp: 30, hp: 60, leadership: 2 });
    // soldiers of four strengths in each role
    [20, 45, 90, 180].forEach((xp, i) => {
      unit(`${p}F${i}`, { subraceId: sub, melee: true, xp, hp: 100 + xp, level: i + 1 });
      unit(`${p}A${i}`, { subraceId: sub, branch: "L_ARCHER", xp: xp - 2, hp: 40 + xp, level: i + 1 });
      unit(`${p}M${i}`, { subraceId: sub, branch: "L_MAGE", area: true, xp: xp - 4, hp: 35 + xp, level: i + 1 });
    });
    unit(`${p}H0`, { subraceId: sub, branch: "L_SPECIAL", atk: "L_HEAL", area: true, xp: 25, hp: 60 });
    unit(`${p}B0`, { subraceId: sub, melee: true, large: true, xp: 160, hp: 400, level: 2 });
    unit(`${p}B1`, { subraceId: sub, large: true, area: true, xp: 220, hp: 350, level: 3 });
  }
  // a race whose only unit is a leader with a short leadership
  unit("S3L1", { subraceId: 3, catKey: "L_LEADER", leaderKey: "L_FIGHTER", branch: "L_HERO", melee: true, xp: 50, hp: 120, leadership: 3 });
  for (let i = 0; i < 4; i++) unit(`S3F${i}`, { subraceId: 3, melee: true, xp: 20 + i, hp: 90 });
  for (let i = 0; i < 4; i++) unit(`S3A${i}`, { subraceId: 3, branch: "L_ARCHER", xp: 18 + i, hp: 50 });
  // never to be taken
  unit("X-THIEF", { catKey: "L_NOBLE", leaderKey: "L_NOBLE", branch: "L_NOBLE", melee: true, xp: 24, leadership: 1 });
  unit("X-GUARDIAN", { catKey: "L_GUARDIAN", branch: "L_HERO", xp: 9000, hp: 3000 });
  unit("X-SUMMON", { catKey: "L_SUMMON", branch: "L_SUMMON", melee: true, xp: 45 });
  unit("X-HEROCOPY", { catKey: "L_SOLDIER", branch: "L_SUMMON", leaderKey: "L_FIGHTER", melee: true, xp: 60 });
  unit("X-NOXP", { melee: true, xp: 0 });
  unit("X-CONJURED", { melee: true, xp: 1, hp: 150 }); // a summoned one: no experience for it
  unit("X-KRAKEN", { melee: true, large: true, water: true, xp: 150, hp: 400 });
  unit("X-SEALEAD", { catKey: "L_LEADER", leaderKey: "L_FIGHTER", branch: "L_HERO", melee: true, water: true, xp: 40, leadership: 6 });
  return out;
}

const units = roster();
const byId = new Map(units.map((u) => [u.id, u]));
const info = (m: GuardMember): GuardUnitInfo => byId.get(m.unit) as GuardUnitInfo;
const members = (g: GuardResult): GuardMember[] => [...new Set(g.cells.filter((c): c is GuardMember => !!c))];
const compose = (opts: Parameters<typeof composeGuard>[1]): GuardResult => {
  const g = composeGuard(units, opts);
  if (!g) throw new Error("no guard");
  return g;
};
const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7 + 1);
const BUDGETS = [60, 120, 250, 400, 700, 900];

describe("guardRole", () => {
  it("tells the four roles apart", () => {
    expect(guardRole(byId.get("S1F0")!)).toBe("fighter");
    expect(guardRole(byId.get("S1A0")!)).toBe("archer");
    expect(guardRole(byId.get("S1M0")!)).toBe("mage");
    expect(guardRole(byId.get("S1H0")!)).toBe("support");
    expect(guardRole(byId.get("S1L2")!)).toBe("mage"); // a mage leader
  });
  it("a monster of no archer / mage branch goes by its attack", () => {
    const base: GuardUnitInfo = { id: "m", level: 1, catKey: "L_SOLDIER", subraceId: 9, hp: 1, branch: "L_FIGHTER" };
    expect(guardRole({ ...base, area: true })).toBe("mage");
    expect(guardRole(base)).toBe("archer");
    expect(guardRole({ ...base, melee: true, area: true })).toBe("fighter");
  });
});

describe("unitAtLevel", () => {
  const u: GuardUnitInfo = { id: "u", level: 2, catKey: "L_SOLDIER", subraceId: 1, hp: 100, xp: 40, dyn: [4, 10, 3, 5, 1] };
  it("keeps the base level when no level is asked, or a lower one", () => {
    expect(unitAtLevel(u, undefined)).toEqual({ level: 2, hp: 100, xp: 40 });
    expect(unitAtLevel(u, 1)).toEqual({ level: 2, hp: 100, xp: 40 });
    expect(unitAtLevel(u, 2)).toEqual({ level: 2, hp: 100, xp: 40 });
  });
  it("adds the first growth up to DYN_UPG_LV and the second after it", () => {
    expect(unitAtLevel(u, 3)).toEqual({ level: 3, hp: 110, xp: 43 });
    expect(unitAtLevel(u, 4)).toEqual({ level: 4, hp: 120, xp: 46 });
    expect(unitAtLevel(u, 5)).toEqual({ level: 5, hp: 125, xp: 47 });
    expect(unitAtLevel(u, 7)).toEqual({ level: 7, hp: 135, xp: 49 });
  });
  it("a unit with no growth data stays at its base level", () => {
    expect(unitAtLevel({ ...u, dyn: undefined }, 9)).toEqual({ level: 2, hp: 100, xp: 40 });
  });
  it("hit points stop at the game's cap", () => {
    expect(unitAtLevel({ ...u, hp: 9990 }, 9).hp).toBe(9999);
  });
});

describe("composeGuard", () => {
  it("the same seed gives the same guard, other seeds give others", () => {
    const a = compose({ budget: 400, seed: 5 });
    expect(compose({ budget: 400, seed: 5 })).toEqual(a);
    const variants = new Set(SEEDS.map((seed) => JSON.stringify(compose({ budget: 400, seed }).cells.map((c) => c?.unit ?? null))));
    expect(variants.size).toBeGreaterThan(20);
  });

  it("never goes over the budget and spends most of it", () => {
    for (const budget of BUDGETS) {
      const spent: number[] = [];
      for (const seed of SEEDS) {
        const g = compose({ budget, seed });
        expect(g.overBudget).toBe(false);
        expect(g.strength).toBeLessThanOrEqual(budget);
        expect(g.strength).toBe(members(g).reduce((s, m) => s + m.xp, 0));
        expect(g.hp).toBe(members(g).reduce((s, m) => s + m.hp, 0));
        expect(g.count).toBe(members(g).length);
        spent.push(g.strength / budget);
      }
      spent.sort((x, y) => x - y);
      expect(spent[0]).toBeGreaterThan(0.8); // the worst variant
      expect(spent[Math.floor(spent.length / 2)]).toBeGreaterThan(0.93); // the usual one
    }
  });

  it("is led by a leader — never a soldier, a thief, a rod-bearer or a guardian", () => {
    for (const budget of BUDGETS) {
      for (const seed of SEEDS) {
        const g = compose({ budget, seed, subrace: "mixed" });
        const leader = g.cells[g.leaderCell];
        expect(leader).toBeTruthy();
        expect(info(leader!).catKey).toBe("L_LEADER");
        expect(["L_ROD", "L_NOBLE"]).not.toContain(info(leader!).leaderKey);
        const led = members(g).filter((m) => info(m).catKey === "L_LEADER");
        expect(led).toEqual([leader]); // one leader, the rest are soldiers
        for (const m of members(g)) {
          expect(["L_LEADER", "L_SOLDIER"]).toContain(info(m).catKey);
          expect(m.unit.startsWith("X-")).toBe(false);
        }
      }
    }
  });

  it("melee stands in front, the rest behind, a big unit takes a whole row", () => {
    for (const budget of BUDGETS) {
      for (const seed of SEEDS) {
        const g = compose({ budget, seed, subrace: "mixed" });
        expect(g.cells).toHaveLength(6);
        g.cells.forEach((m, cell) => {
          if (!m) return;
          const pair = g.cells[cell ^ 1];
          if (m.big) {
            expect(pair).toBe(m); // the same member in both cells of the row
            expect(info(m).large).toBe(true);
          } else {
            expect(pair).not.toBe(m);
            expect(cell % 2 === 0).toBe(!!info(m).melee);
          }
        });
      }
    }
  });

  it("with two units or more somebody stands in each line", () => {
    let checked = 0;
    for (const budget of BUDGETS) {
      for (const seed of SEEDS) {
        const g = compose({ budget, seed });
        if (g.count < 2) continue;
        checked++;
        expect(g.cells.some((m, cell) => m && cell % 2 === 0)).toBe(true);
        expect(g.cells.some((m, cell) => m && cell % 2 === 1)).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("a lonely line is allowed when the roles leave no choice", () => {
    const g = compose({ budget: 400, seed: 3, roles: ["fighter"] });
    for (const m of members(g)) expect(m.role).toBe("fighter");
    expect(g.count).toBeGreaterThan(1);
  });

  it("takes only the roles asked for", () => {
    for (const seed of SEEDS) {
      const g = compose({ budget: 500, seed, roles: ["fighter", "archer"] });
      for (const m of members(g)) expect(["fighter", "archer"]).toContain(m.role);
    }
    const mages = SEEDS.map((seed) => compose({ budget: 500, seed }));
    expect(mages.some((g) => members(g).some((m) => m.role === "mage"))).toBe(true);
    expect(mages.some((g) => members(g).some((m) => m.role === "support"))).toBe(true);
  });

  it("one subrace per stack by default, a given one when asked, any mix when allowed", () => {
    const seen = new Set<number>();
    for (const seed of SEEDS) {
      const g = compose({ budget: 400, seed });
      expect(g.subraces).toHaveLength(1);
      seen.add(g.subraces[0]!);
      expect(compose({ budget: 400, seed, subrace: 2 }).subraces).toEqual([2]);
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(SEEDS.some((seed) => compose({ budget: 600, seed, subrace: "mixed" }).subraces.length > 1)).toBe(true);
  });

  it("respects the leader's leadership: every slot counts, his own too, a big unit twice", () => {
    for (const seed of SEEDS) {
      const g = compose({ budget: 400, seed, subrace: 3 });
      expect(info(g.cells[g.leaderCell]!).id).toBe("S3L1");
      const slots = members(g).reduce((s, m) => s + (m.big ? 2 : 1), 0);
      expect(slots).toBeLessThanOrEqual(3);
    }
  });

  it("takes at most the number of units asked for", () => {
    for (const seed of SEEDS) {
      expect(compose({ budget: 900, seed, maxUnits: 3 }).count).toBeLessThanOrEqual(3);
      expect(compose({ budget: 900, seed, maxUnits: 1 }).count).toBe(1);
    }
  });

  it("brings the units to the level asked, with the hit points and strength of that level", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const g = compose({ budget: 600, seed, level: 4 });
      expect(g.strength).toBeLessThanOrEqual(600);
      for (const m of members(g)) {
        const at = unitAtLevel(info(m), 4);
        expect(m.level).toBe(Math.max(4, info(m).level));
        expect({ level: m.level, hp: m.hp, xp: m.xp }).toEqual(at);
      }
    }
    // and without the option everybody is at the base level
    for (const m of members(compose({ budget: 600, seed: 1 }))) expect(m.level).toBe(info(m).level);
  });

  it("a unit that lives on water serves only in a stack on water", () => {
    for (const seed of SEEDS) {
      for (const m of members(compose({ budget: 500, seed, subrace: "mixed" }))) expect(info(m).water).toBeFalsy();
    }
    expect(SEEDS.some((seed) => members(compose({ budget: 500, seed, subrace: "mixed", onWater: true })).some((m) => info(m).water))).toBe(true);
  });

  it("a budget below the cheapest leader gives that leader alone, flagged", () => {
    const g = compose({ budget: 10, seed: 1 });
    expect(g.overBudget).toBe(true);
    expect(g.count).toBe(1);
    expect(info(g.cells[g.leaderCell]!).catKey).toBe("L_LEADER");
    expect(g.strength).toBe(50); // S3L1, the cheapest one that may lead
  });

  it("returns null when nobody may lead", () => {
    expect(composeGuard(units.filter((u) => u.catKey !== "L_LEADER"), { budget: 400, seed: 1 })).toBeNull();
    expect(composeGuard(units, { budget: 400, seed: 1, subrace: 77 })).toBeNull();
    expect(composeGuard(units, { budget: 400, seed: 1, subrace: 3, roles: ["mage"] })).toBeNull();
  });

  it("keeps the leader the mapmaker chose and composes the rest around him", () => {
    for (const seed of SEEDS) {
      const g = compose({ budget: 500, seed, leader: "S2L2" });
      expect(g.cells[g.leaderCell]?.unit).toBe("S2L2");
      expect(g.subraces).toEqual([2]); // "one" subrace: the leader's
      expect(g.strength).toBeLessThanOrEqual(500);
      expect(g.count).toBeGreaterThan(1);
    }
    // the roles do not bind him, only the others
    const g = compose({ budget: 500, seed: 2, leader: "S2L2", roles: ["fighter"] });
    expect(g.cells[g.leaderCell]?.unit).toBe("S2L2");
    for (const m of members(g)) if (m.unit !== "S2L2") expect(m.role).toBe("fighter");
    // a thief may be kept too; he leads nobody (leadership 1)
    const thief = compose({ budget: 500, seed: 2, leader: "X-THIEF", subrace: "mixed" });
    expect(thief.cells[thief.leaderCell]?.unit).toBe("X-THIEF");
    expect(thief.count).toBe(1);
    // a leader dearer than the budget stays, alone and flagged
    const dear = compose({ budget: 100, seed: 2, leader: "S1L3" });
    expect(dear.overBudget).toBe(true);
    expect(members(dear).map((m) => m.unit)).toEqual(["S1L3"]);
    // a soldier is not a leader: the option is ignored
    expect(info(compose({ budget: 500, seed: 2, leader: "S1F0" }).cells[compose({ budget: 500, seed: 2, leader: "S1F0" }).leaderCell]!).catKey).toBe("L_LEADER");
  });

  it("never takes a unit that was struck out", () => {
    const struck = ["S1F0", "S1F1", "S1A0", "S2F0", "S2L1", "S1L1"];
    for (const seed of SEEDS) {
      for (const m of members(compose({ budget: 300, seed, exclude: struck }))) expect(struck).not.toContain(m.unit);
    }
  });

  it("does not depend on the order of the catalogue", () => {
    const shuffled = [...units].reverse();
    for (const seed of SEEDS.slice(0, 10)) {
      expect(composeGuard(shuffled, { budget: 400, seed })).toEqual(composeGuard(units, { budget: 400, seed }));
    }
  });
});

describe("guardBudgetRange", () => {
  it("names the cheapest leader and a ceiling", () => {
    expect(guardBudgetRange(units, {})).toEqual({ min: 50, max: 300 + 300 + 220 + 220 + 180 + 180 });
    expect(guardBudgetRange(units, { subrace: 3 })?.min).toBe(50);
    expect(guardBudgetRange(units, { subrace: 77 })).toBeNull();
  });
});

describe("composeLoot", () => {
  const items: LootItemInfo[] = [
    { id: "POT1", catKey: "L_POTION_HEAL", gold: 50 },
    { id: "POT2", catKey: "L_POTION_HEAL", gold: 150 },
    { id: "SCR1", catKey: "L_SCROLL", gold: 100 },
    { id: "SCR2", catKey: "L_SCROLL", gold: 250 },
    { id: "VAL1", catKey: "L_VALUABLE", gold: 200 },
    { id: "VAL2", catKey: "L_VALUABLE", gold: 500 },
    { id: "ART1", catKey: "L_ARMOR", gold: 800 },
    { id: "ART2", catKey: "L_WEAPON", gold: 1500 },
    { id: "QUEST", catKey: "L_SPECIAL", gold: 100 },
    { id: "FREE", catKey: "L_VALUABLE", gold: 0 },
  ];
  const gold = new Map(items.map((it) => [it.id, it.gold]));

  it("stays within the value asked and close to it", () => {
    for (const budget of [100, 300, 750, 1200, 3000]) {
      for (const seed of SEEDS) {
        const loot = composeLoot(items, { budget, seed });
        expect(loot.value).toBe(loot.items.reduce((s, id) => s + (gold.get(id) ?? 0), 0));
        expect(loot.value).toBeLessThanOrEqual(budget);
        expect(loot.value).toBeGreaterThanOrEqual(budget * 0.8);
        expect(loot.items.length).toBeGreaterThan(0);
        expect(loot.items.length).toBeLessThanOrEqual(5);
        expect(loot.items).not.toContain("QUEST");
        expect(loot.items).not.toContain("FREE");
      }
    }
  });
  it("is the same for the same seed and varies with it", () => {
    expect(composeLoot(items, { budget: 900, seed: 4 })).toEqual(composeLoot(items, { budget: 900, seed: 4 }));
    expect(new Set(SEEDS.map((seed) => composeLoot(items, { budget: 900, seed }).items.join())).size).toBeGreaterThan(5);
  });
  it("takes from the categories asked — a special one only by name", () => {
    for (const seed of SEEDS) {
      const loot = composeLoot(items, { budget: 400, seed, cats: ["L_POTION_HEAL"] });
      for (const id of loot.items) expect(id.startsWith("POT")).toBe(true);
    }
    expect(composeLoot(items, { budget: 100, seed: 1, cats: ["L_SPECIAL"] }).items).toEqual(["QUEST"]);
  });
  it("costliest first; nothing when nothing is that cheap", () => {
    const loot = composeLoot(items, { budget: 1200, seed: 2 });
    const values = loot.items.map((id) => gold.get(id) ?? 0);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(composeLoot(items, { budget: 20, seed: 1 })).toEqual({ items: [], value: 0 });
    expect(composeLoot([], { budget: 500, seed: 1 })).toEqual({ items: [], value: 0 });
  });
  it("respects the number of items asked for", () => {
    for (const seed of SEEDS) expect(composeLoot(items, { budget: 3000, seed, maxItems: 2 }).items.length).toBeLessThanOrEqual(2);
  });

  describe("composeRuinReward", () => {
    it("one item and gold for the rest: together exactly the value asked", () => {
      for (const budget of [300, 750, 1200, 3000]) {
        for (const seed of SEEDS) {
          const r = composeRuinReward(items, { budget, seed });
          expect(r.value).toBe(budget);
          expect(r.gold).toBeGreaterThanOrEqual(0);
          expect(r.item).not.toBeNull();
          expect(r.value).toBe((gold.get(r.item!) ?? 0) + r.gold);
          expect(["QUEST", "FREE"]).not.toContain(r.item);
        }
      }
    });
    it("varies with the seed: other items, other shares of gold", () => {
      const seen = new Set(SEEDS.map((seed) => composeRuinReward(items, { budget: 1200, seed }).item));
      expect(seen.size).toBeGreaterThan(2);
      expect(composeRuinReward(items, { budget: 1200, seed: 9 })).toEqual(composeRuinReward(items, { budget: 1200, seed: 9 }));
    });
    it("gold alone when no item is that cheap, and never more than four digits of it", () => {
      expect(composeRuinReward(items, { budget: 40, seed: 1 })).toEqual({ item: null, gold: 40, value: 40 });
      const rich = composeRuinReward([{ id: "TRINKET", catKey: "L_VALUABLE", gold: 100 }], { budget: 50000, seed: 1 });
      expect(rich).toEqual({ item: "TRINKET", gold: 9999, value: 10099 });
    });
    it("takes the item from the categories asked", () => {
      let taken = 0;
      for (const seed of SEEDS) {
        const item = composeRuinReward(items, { budget: 2000, seed, cats: ["L_ARMOR", "L_WEAPON"] }).item;
        if (item === null) continue; // the share of this variant was below the cheapest of them
        taken++;
        expect(item.startsWith("ART")).toBe(true);
      }
      expect(taken).toBeGreaterThan(SEEDS.length / 2);
    });
  });
});

describe("composeGuard for a garrison (nobody leads)", () => {
  const garrison = (opts: Omit<Parameters<typeof composeGuard>[1], "leaderless">): GuardResult => compose({ ...opts, leaderless: true });

  it("is soldiers only, with no leader cell", () => {
    for (const budget of BUDGETS) {
      for (const seed of SEEDS) {
        const g = garrison({ budget, seed, subrace: "mixed" });
        expect(g.leaderCell).toBe(-1);
        expect(g.count).toBeGreaterThan(0);
        for (const m of members(g)) {
          expect(info(m).catKey).toBe("L_SOLDIER");
          expect(m.unit.startsWith("X-")).toBe(false);
        }
      }
    }
  });

  it("stays within the budget, spends most of it and varies with the seed", () => {
    for (const budget of [120, 250, 400, 700]) {
      const spent: number[] = [];
      for (const seed of SEEDS) {
        const g = garrison({ budget, seed });
        expect(g.overBudget).toBe(false);
        expect(g.strength).toBeLessThanOrEqual(budget);
        spent.push(g.strength / budget);
      }
      spent.sort((x, y) => x - y);
      expect(spent[0]).toBeGreaterThan(0.8);
      expect(spent[Math.floor(spent.length / 2)]).toBeGreaterThan(0.93);
    }
    expect(garrison({ budget: 400, seed: 5 })).toEqual(garrison({ budget: 400, seed: 5 }));
    expect(new Set(SEEDS.map((seed) => JSON.stringify(garrison({ budget: 400, seed }).cells.map((c) => c?.unit ?? null)))).size).toBeGreaterThan(20);
  });

  it("keeps the lines: melee in front, the rest behind, somebody in each, a big unit across", () => {
    let pairs = 0;
    for (const budget of BUDGETS) {
      for (const seed of SEEDS) {
        const g = garrison({ budget, seed });
        g.cells.forEach((m, cell) => {
          if (!m) return;
          if (m.big) expect(g.cells[cell ^ 1]).toBe(m);
          else expect(cell % 2 === 0).toBe(!!info(m).melee);
        });
        if (g.count < 2) continue;
        pairs++;
        expect(g.cells.some((m, cell) => m && cell % 2 === 0)).toBe(true);
        expect(g.cells.some((m, cell) => m && cell % 2 === 1)).toBe(true);
      }
    }
    expect(pairs).toBeGreaterThan(200);
  });

  it("may fill all six cells — no leadership holds it back — and no more than asked", () => {
    expect(SEEDS.some((seed) => garrison({ budget: 300, seed, subrace: 3 }).count > 3)).toBe(true); // a leader of race 3 leads three
    for (const seed of SEEDS) {
      const slots = members(garrison({ budget: 900, seed, subrace: "mixed" })).reduce((s, m) => s + (m.big ? 2 : 1), 0);
      expect(slots).toBeLessThanOrEqual(6);
      expect(garrison({ budget: 900, seed, maxUnits: 2 }).count).toBeLessThanOrEqual(2);
    }
  });

  it("honours the level, the roles, the subrace and the struck-out units like a led guard", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      for (const m of members(garrison({ budget: 500, seed, level: 4 }))) expect(m.level).toBe(Math.max(4, info(m).level));
      for (const m of members(garrison({ budget: 500, seed, roles: ["archer", "mage"] }))) expect(["archer", "mage"]).toContain(m.role);
      expect(garrison({ budget: 300, seed, subrace: 2 }).subraces).toEqual([2]);
      expect(garrison({ budget: 300, seed }).subraces).toHaveLength(1);
      for (const m of members(garrison({ budget: 300, seed, exclude: ["S1F0", "S2F0", "S3F0"] }))) expect(["S1F0", "S2F0", "S3F0"]).not.toContain(m.unit);
    }
  });

  it("ignores a kept leader, and a budget below the cheapest soldier gives that soldier, flagged", () => {
    const g = garrison({ budget: 300, seed: 4, leader: "S1L1" });
    expect(g.leaderCell).toBe(-1);
    expect(members(g).some((m) => m.unit === "S1L1")).toBe(false);
    const poor = garrison({ budget: 5, seed: 1 });
    expect(poor.overBudget).toBe(true);
    expect(poor.count).toBe(1);
    expect(poor.strength).toBe(16); // S1M0 / S2M0: the cheapest soldiers of the roster
  });

  it("returns null when there is no soldier to take", () => {
    expect(composeGuard(units.filter((u) => u.catKey !== "L_SOLDIER"), { budget: 400, seed: 1, leaderless: true })).toBeNull();
    expect(composeGuard(units, { budget: 400, seed: 1, leaderless: true, subrace: 77 })).toBeNull();
  });

  it("guardBudgetRange starts at the cheapest soldier", () => {
    expect(guardBudgetRange(units, { leaderless: true })).toEqual({ min: 16, max: 220 + 220 + 180 + 180 + 178 + 178 });
  });
});
