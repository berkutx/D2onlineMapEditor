import { describe, it, expect } from "vitest";
import { runRecipe } from "../src/runRecipe";
import { RECIPES } from "../src/recipes";

describe("@d2/mapgen runRecipe (headless MarkovJunior)", () => {
  it("runs MazeGrowth 25×25 to completion → a symbol grid", async () => {
    const g = await runRecipe(RECIPES.wall_maze!.xml, 25, 25, 1);
    expect(g.width).toBe(25);
    expect(g.height).toBe(25);
    expect(g.rows.length).toBe(25);
    expect(g.rows.every((r) => r.length === 25)).toBe(true);

    const all = g.rows.join("");
    // only alphabet symbols appear
    for (const s of new Set(all.split(""))) expect("BWA").toContain(s);
    // a real maze has BOTH walls (B) and carved passages (A/W)
    expect(all.includes("B")).toBe(true);
    expect(all.includes("A") || all.includes("W")).toBe(true);
    // not degenerate (not a single symbol)
    expect(new Set(all.split("")).size).toBeGreaterThan(1);
  });

  it("is deterministic for a fixed seed", async () => {
    const a = await runRecipe(RECIPES.wall_maze!.xml, 21, 21, 7);
    const b = await runRecipe(RECIPES.wall_maze!.xml, 21, 21, 7);
    expect(b.rows.join("")).toBe(a.rows.join(""));
  });

  it("respects the requested grid size", async () => {
    const g = await runRecipe(RECIPES.wall_maze!.xml, 12, 30, 1);
    expect(g.width).toBe(12);
    expect(g.height).toBe(30);
  });
});
