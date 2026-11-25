import { describe, it, expect } from "vitest";
import {
  AMOUNT_MAX, AMOUNT_MIN, RECIPES, RECIPE_GROUPS,
  getRecipe, isTunable, recipeCatalog, runRecipe, tuneRecipe,
} from "../src/index";

const all = Object.values(RECIPES);

describe("the recipe library as a palette lists it", () => {
  it("every recipe has a name and a known group", () => {
    for (const r of all) {
      expect(r.title.trim().length, r.id).toBeGreaterThan(0);
      expect(RECIPE_GROUPS, r.id).toContain(r.group);
      expect(RECIPES[r.id]).toBe(r); // the key is the id
    }
    expect(new Set(all.map((r) => r.title)).size).toBe(all.length); // no two under one name
  });

  it("says what 'more' means exactly for the recipes whose amount can be tuned", () => {
    for (const r of all) {
      expect(r.amountLabel !== undefined, `${r.id}: amountLabel vs a knob to turn`).toBe(isTunable(r));
    }
    // a river, a ridge, a road, a maze and the solid fills have nothing to turn
    for (const id of ["river", "relief_ridge", "road_path", "wall_maze", "mountain_fill", "forest_fill", "snow_overlay", "grass_fill"]) {
      expect(isTunable(getRecipe(id)!), id).toBe(false);
    }
  });

  it("a recipe offered for drawing can follow a stroke: it stamps a symbol or is a fill", () => {
    const drawable = all.filter((r) => r.stroke);
    expect(drawable.map((r) => r.id)).toEqual(expect.arrayContaining(["river", "road_path", "relief_ridge", "mountain_fill", "forest_fill", "relief_hills"]));
    for (const r of drawable) {
      expect(r.kind === "fill" || typeof r.maskSymbol === "string", r.id).toBe(true);
      expect([1, 3, 5], r.id).toContain(r.strokeWidth);
    }
    // a path is drawn as a line; the line IS a road or a river, three cells make a ridge
    expect(getRecipe("road_path")).toMatchObject({ stroke: "line", strokeWidth: 1 });
    expect(getRecipe("relief_ridge")).toMatchObject({ stroke: "line", strokeWidth: 3 });
  });

  it("lists the catalogue group by group, with only what a client needs", () => {
    const cat = recipeCatalog();
    expect(cat).toHaveLength(all.length);
    expect(new Set(cat.map((c) => c.id)).size).toBe(all.length);
    const groupOrder = cat.map((c) => RECIPE_GROUPS.indexOf(c.group));
    expect(groupOrder).toEqual([...groupOrder].sort((a, b) => a - b));
    expect(cat.find((c) => c.id === "water_lake")).toEqual({
      id: "water_lake", title: "Озеро", group: "water", amountLabel: "размер озера", varies: true, strokeVaries: true,
    });
    // a river varies in a zone, but a river DRAWN as a line is that line whatever the seed
    expect(cat.find((c) => c.id === "river")).toEqual({
      id: "river", title: "Река", group: "water", stroke: "line", strokeWidth: 1, varies: true, strokeVaries: false,
    });
    // a fill is the same picture every time; rocks sprinkled along a stroke are not
    expect(cat.find((c) => c.id === "mountain_fill")).toMatchObject({ varies: false, strokeVaries: false });
    expect(cat.find((c) => c.id === "decor_rocks")).toMatchObject({ varies: true, strokeVaries: true });
  });
});

describe("tuneRecipe", () => {
  it("returns the recipe itself at 1 and for a recipe with nothing to turn", () => {
    const lake = getRecipe("water_lake")!;
    expect(tuneRecipe(lake, 1)).toBe(lake);
    expect(tuneRecipe(getRecipe("river")!, 2)).toBe(getRecipe("river"));
    expect(tuneRecipe(lake, Number.NaN)).toBe(lake);
  });

  it("scales growth, seeds, scatter probabilities and stroke density — and nothing else", () => {
    const isles = getRecipe("water_isles")!;
    const more = tuneRecipe(isles, 2);
    expect(more).not.toBe(isles);
    expect(more.fillFrac).toBeCloseTo(isles.fillFrac! * 2);
    expect(more.seedsFrac).toBeCloseTo(isles.seedsFrac! * 2);
    expect(more.xml).toBe(isles.xml); // no p= in it: the program text is untouched
    expect(isles.fillFrac).toBe(0.22); // the library entry is not modified

    const rocks = getRecipe("decor_rocks")!;
    const fewer = tuneRecipe(rocks, 0.5);
    expect(fewer.xml).toContain('p="0.02"');
    expect(fewer.maskDensity).toBeCloseTo(0.25);
    expect(fewer.xml.replace('p="0.02"', 'p="0.04"')).toBe(rocks.xml);
  });

  it("keeps the amount and the results inside what a program can do", () => {
    const lake = getRecipe("water_lake")!; // fillFrac 0.5
    expect(tuneRecipe(lake, 100).fillFrac).toBe(0.95); // 0.5 * AMOUNT_MAX, capped
    expect(tuneRecipe(lake, 100)).toEqual(tuneRecipe(lake, AMOUNT_MAX));
    expect(tuneRecipe(lake, 0).fillFrac).toBeCloseTo(0.5 * AMOUNT_MIN);
    expect(tuneRecipe(getRecipe("decor_rocks")!, 3).maskDensity).toBe(1);
  });

  it("more really is more: a lake grown from the same seed covers more cells", async () => {
    const water = async (amount: number): Promise<number> => {
      const r = tuneRecipe(getRecipe("water_lake")!, amount);
      const steps = Math.max(1, Math.round(24 * 24 * r.fillFrac!));
      const grid = await runRecipe(r.xml.split("STEPS").join(String(steps)), 24, 24, 7);
      return grid.rows.join("").split("W").length - 1;
    };
    const [less, stock, more] = [await water(0.5), await water(1), await water(1.6)];
    expect(less).toBeLessThan(stock);
    expect(stock).toBeLessThan(more);
  });
});
