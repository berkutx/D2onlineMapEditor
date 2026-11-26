/**
 * The maze in its three looks — a coarse fortress of 2×2 walls, a fine maze of one-cell stone
 * walls, a palisade — and its joints: ONE tower per joint, never a walk-through gap.
 */
import { describe, it, expect } from "vitest";
import { createBlankMap, parseScenario } from "@d2/sg-parser";
// the sources, not the built package
import { DECODE_TABLES, buildWallSet, decodeGrid, pickWallStyle, recipeLacks, type EditOp } from "../src/index";

const piece = (id: string, shape: string, orient: string, size = 1) => ({ id, shape, cx: size, cy: size, iso: { orient } });
const tower = (id: string) => ({ id, shape: "tower", cx: 1, cy: 1, tone: "neutral", tags: [] });
/** A mod with everything: fortress walls, thin stone walls of another family, a palisade. */
const CATALOG = [
  piece("G000MG0046", "wall", "corner", 2), piece("G000MG0047", "wall", "NE-SW", 2), piece("G000MG0048", "wall", "NW-SE", 2),
  piece("G003MG0009", "wall", "NW-SE"), piece("G003MG0010", "wall", "NE-SW"), piece("G003MG0011", "wall", "corner"), piece("G003MG0012", "wall", "corner"),
  piece("G000MG8296", "fence", "NW-SE"), piece("G000MG8297", "fence", "NE-SW"), piece("G000MG8298", "fence", "corner"), piece("G000MG8299", "fence", "corner"),
  tower("G000MG0149"),
];
const FORTRESS = new Set(["G000MG0046", "G000MG0047", "G000MG0048"]);
const THIN = new Set(["G003MG0009", "G003MG0010", "G003MG0011", "G003MG0012"]);
const FENCE = new Set(["G000MG8296", "G000MG8297", "G000MG8298", "G000MG8299"]);
const TOWER = "G000MG0149";

const doc = parseScenario(createBlankMap({ size: 48 }));
/** A wall plan: `B` = wall, `.` = passage. */
const grid = (rows: string[]) => ({ width: rows[0]!.length, height: rows.length, rows: rows.map((r) => r.replace(/\./g, "W")) });
type Placed = { id: string; x: number; y: number };
function decode(recipeId: string, rows: string[], catalog: object[] = CATALOG, scale = recipeId === "wall_maze" ? 2 : 1): Placed[] {
  const ops = decodeGrid(doc, grid(rows), DECODE_TABLES[recipeId]!, { x: 10, y: 10, w: rows[0]!.length * scale, h: rows.length * scale },
    buildWallSet(catalog as never), undefined, false, undefined, scale);
  return ops
    .filter((o): o is Extract<EditOp, { kind: "addObject" }> => o.kind === "addObject")
    .map((o) => ({ id: String((o.object as { baseType?: string }).baseType), x: o.object.pos.x, y: o.object.pos.y }));
}
const SIZE: Record<string, number> = { G000MG0046: 2, G000MG0047: 2, G000MG0048: 2 };
const covered = (placed: Placed[]): Set<string> => {
  const out = new Set<string>();
  for (const p of placed) {
    const s = SIZE[p.id] ?? 1;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) out.add(`${p.x + dx},${p.y + dy}`);
  }
  return out;
};

// corners, tees, straight runs and a free end in one plan
const PLAN = [
  "BBBBB",
  "B.B.B",
  "BBBBB",
  "B....",
  "B....",
];

describe("the fortress maze (2×2 walls)", () => {
  const placed = decode("wall_maze", PLAN);

  it("builds straight runs from 2×2 pieces and puts ONE tower on each joint", () => {
    const joints = 6; // the wall cells of the plan with a turn or a branch (3 corners, 3 tees)
    expect(placed.filter((p) => p.id === TOWER)).toHaveLength(joints);
    expect(placed.some((p) => FORTRESS.has(p.id))).toBe(true);
    // the rest of a joint block is closed with one-cell walls of the stone family
    expect(placed.filter((p) => THIN.has(p.id))).toHaveLength(joints * 3);
    expect(placed.every((p) => p.id === TOWER || FORTRESS.has(p.id) || THIN.has(p.id))).toBe(true);
  });

  it("stands the tower in the front cell of its block", () => {
    for (const t of placed.filter((p) => p.id === TOWER)) {
      expect([(t.x - 10) % 2, (t.y - 10) % 2]).toEqual([1, 1]);
    }
  });

  it("leaves no cell of a wall block open", () => {
    const cells = covered(placed);
    PLAN.forEach((row, gy) => [...row].forEach((ch, gx) => {
      if (ch !== "B") return;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        expect(cells.has(`${10 + gx * 2 + dx},${10 + gy * 2 + dy}`), `gap in block ${gx},${gy}`).toBe(true);
      }
    }));
    // and nothing is put on a passage
    expect(cells.size).toBe(PLAN.join("").split("B").length - 1 << 2);
  });

  it("falls back to a block of towers when the mod has no one-cell walls", () => {
    const only2x2 = CATALOG.filter((e) => !THIN.has(e.id) && !FENCE.has(e.id));
    const heavy = decode("wall_maze", PLAN, only2x2);
    expect(heavy.filter((p) => p.id === TOWER)).toHaveLength(6 * 4);
    expect(covered(heavy).size).toBe(covered(placed).size); // sealed all the same
  });
});

describe("the fine mazes (one-cell walls)", () => {
  it("uses thin stone walls, with towers only on the outer corners of the figure", () => {
    const placed = decode("wall_maze_thin", PLAN);
    expect(placed).toHaveLength(PLAN.join("").split("B").length - 1); // one piece per wall cell
    // the plan's wall cells at the corners of its bounding box: (0,0), (4,0) and (0,4)
    expect(placed.filter((p) => p.id === TOWER).map((p) => [p.x - 10, p.y - 10]).sort()).toEqual([[0, 0], [0, 4], [4, 0]]);
    expect(placed.every((p) => p.id === TOWER || THIN.has(p.id))).toBe(true);
    // the inner joints turn with the family's corner pieces
    expect(placed.filter((p) => p.id === "G003MG0011" || p.id === "G003MG0012").length).toBeGreaterThanOrEqual(4);
  });

  it("puts a tower on a lone post", () => {
    expect(decode("wall_maze_thin", ["...", ".B.", "..."]).map((p) => p.id)).toEqual([TOWER]);
  });

  it("builds a palisade from its own pieces only — no stone tower on a wooden corner", () => {
    const placed = decode("wall_maze_fence", PLAN);
    expect(placed).toHaveLength(PLAN.join("").split("B").length - 1);
    expect(placed.every((p) => FENCE.has(p.id))).toBe(true);
  });

  it("turns a straight piece along its run", () => {
    // (the two ends of a free-standing wall are the corners of its figure: towers cap them)
    const walls = (rows: string[]) => decode("wall_maze_thin", rows).filter((p) => p.id !== TOWER);
    const run = walls(["BBBBB"]); // a run along x
    const col = walls(["B", "B", "B", "B", "B"]); // a run along y
    expect(run).toHaveLength(3);
    expect(new Set(run.map((p) => p.id)).size).toBe(1);
    expect(new Set(col.map((p) => p.id)).size).toBe(1);
    expect(run[0]!.id).not.toBe(col[0]!.id);
  });
});

describe("what a mod needs for each maze", () => {
  const sets = (catalog: object[]) => ({ walls: buildWallSet(catalog as never), decor: {} });
  const LACKS = "в этом моде нет стен для лабиринта";

  it("has all three with the full catalogue", () => {
    for (const id of ["wall_maze", "wall_maze_thin", "wall_maze_fence"]) expect(recipeLacks(id, sets(CATALOG)), id).toBeUndefined();
  });

  it("offers only the fortress to a mod with nothing but 2×2 walls (Nazar's Legacy)", () => {
    const legacy = CATALOG.filter((e) => FORTRESS.has(e.id) || e.id === TOWER);
    expect(recipeLacks("wall_maze", sets(legacy))).toBeUndefined();
    expect(recipeLacks("wall_maze_thin", sets(legacy))).toBe(LACKS);
    expect(recipeLacks("wall_maze_fence", sets(legacy))).toBe(LACKS);
  });

  it("offers no palisade to a mod without one (SMNS)", () => {
    const smns = CATALOG.filter((e) => !FENCE.has(e.id));
    expect(recipeLacks("wall_maze_thin", sets(smns))).toBeUndefined();
    expect(recipeLacks("wall_maze_fence", sets(smns))).toBe(LACKS);
  });

  it("picks the art by shape and piece size", () => {
    const walls = buildWallSet(CATALOG as never);
    expect(pickWallStyle(walls, "wall", 2)?.s2["NE-SW"]).toEqual(["G000MG0047"]);
    expect(pickWallStyle(walls, "wall", 1)?.s1["NE-SW"]).toEqual(["G003MG0010"]);
    expect(pickWallStyle(walls, "fence", 1)?.s1["NE-SW"]).toEqual(["G000MG8297"]);
    expect(pickWallStyle(walls, "fence", 2)).toBeUndefined();
  });
});
