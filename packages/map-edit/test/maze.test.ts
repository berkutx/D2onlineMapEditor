/**
 * The maze in its three looks — a fortress of 2×2 walls, ruined one-cell stone walls, a
 * palisade — and what stands on its joints: a tower, a column, a watchtower, a bastion; never
 * a walk-through gap. The art sets and the buildings come from the mod's catalogue.
 */
import { describe, it, expect } from "vitest";
import { createBlankMap, parseScenario } from "@d2/sg-parser";
// the sources, not the built package
import { DECODE_TABLES, buildWallSet, decodeGrid, pickWallStyle, recipeLacks, wallStylesFor, type EditOp } from "../src/index";

type Iso = { orient: string; dx?: number; base?: number };
const piece = (id: string, shape: string, orient: string, size = 1, more: { tone?: string; dx?: number; base?: number } = {}) => {
  const iso: Iso = { orient };
  if (more.dx !== undefined) iso.dx = more.dx;
  if (more.base !== undefined) iso.base = more.base;
  return { id, shape, cx: size, cy: size, iso, tone: more.tone ?? "neutral" };
};
const building = (id: string, shape: string, kind: string, tone = "neutral", size = 1) =>
  ({ id, shape, cx: size, cy: size, tone, tags: [], desc_en: kind });

/** A small mod with everything: fortress walls, ruined stone walls of another series, a palisade, one tower. */
const CATALOG = [
  piece("G000MG0046", "wall", "corner", 2), piece("G000MG0047", "wall", "NE-SW", 2), piece("G000MG0048", "wall", "NW-SE", 2),
  piece("G003MG0009", "wall", "NW-SE"), piece("G003MG0010", "wall", "NE-SW"), piece("G003MG0011", "wall", "corner"), piece("G003MG0012", "wall", "corner"),
  piece("G000MG8296", "fence", "NW-SE"), piece("G000MG8297", "fence", "NE-SW"), piece("G000MG8298", "fence", "corner"), piece("G000MG8299", "fence", "corner"),
  building("G000MG0149", "tower", "Tower"),
];
const FORTRESS = new Set(["G000MG0046", "G000MG0047", "G000MG0048"]);
const THIN = new Set(["G003MG0009", "G003MG0010", "G003MG0011", "G003MG0012"]);
const FENCE = new Set(["G000MG8296", "G000MG8297", "G000MG8298", "G000MG8299"]);
const TOWER = "G000MG0149";

/**
 * The same with what the real tables add (the numbers are those of the catalogue the editor
 * builds for the stock art): a mossy twin of the fortress wall with its own dark towers, a
 * second round tower, a 2×2 lighthouse, wooden watchtowers, columns, a handful of wreckage that
 * is also called a wall, and the geometry that tells a palisade's four corners and the half
 * walls of the ruined set apart.
 */
const RICH = [
  piece("G000MG0046", "wall", "corner", 2), piece("G000MG0047", "wall", "NE-SW", 2), piece("G000MG0048", "wall", "NW-SE", 2, { tone: "dark" }),
  piece("G000MG8134", "wall", "corner", 2, { tone: "dark" }), piece("G000MG8135", "wall", "NE-SW", 2, { tone: "dark" }), piece("G000MG8136", "wall", "NW-SE", 2, { tone: "dark" }),
  // wreckage of a wooden barricade: four pieces
  piece("G000MG8087", "wall", "corner", 1, { dx: -0.04, base: 12 }), piece("G000MG8088", "wall", "NW-SE", 1, { dx: -0.07, base: 6 }),
  piece("G000MG8089", "wall", "corner", 1, { dx: -0.07, base: 12 }), piece("G000MG8090", "wall", "NE-SW", 1, { dx: 0.07, base: 9 }),
  // ruined stone walls: a whole piece, three half walls, two corner blocks
  piece("G003MG0009", "wall", "NW-SE", 1, { dx: -0.13, base: 16 }), piece("G003MG0010", "wall", "NE-SW", 1, { dx: 0.35, base: 13 }),
  piece("G003MG0011", "wall", "corner", 1, { dx: 0.27, base: 8, tone: "dark" }), piece("G003MG0012", "wall", "corner", 1, { dx: -0.11, base: -1 }),
  piece("G003MG0013", "wall", "NW-SE", 1, { dx: 0.82, base: 8, tone: "dark" }), piece("G003MG0014", "wall", "NE-SW", 1, { dx: -0.9, base: 17 }),
  // the palisade: two straights and its four corners
  piece("G000MG8296", "fence", "NW-SE", 1, { dx: -0.03, base: 10, tone: "dark" }), piece("G000MG8297", "fence", "NE-SW", 1, { dx: 0.03, base: 10, tone: "dark" }),
  piece("G000MG8298", "fence", "corner", 1, { dx: -0.06, base: 4, tone: "dark" }), piece("G000MG8299", "fence", "corner", 1, { dx: 0.79, base: 12, tone: "dark" }),
  piece("G000MG8300", "fence", "corner", 1, { dx: -0.88, base: 10, tone: "dark" }), piece("G000MG8301", "fence", "corner", 1, { dx: 0.05, base: 12, tone: "dark" }),
  building("G000MG0149", "tower", "Tower"), building("G000MG0150", "tower", "Tower"),
  building("G000MG8132", "tower", "Tower", "dark"), building("G000MG8133", "tower", "Tower", "dark"),
  building("G000MG8019", "tower", "Watchtower", "earth"), building("G000MG8131", "tower", "Watchtower", "dark"),
  building("G000MG8022", "tower", "Small tower"), building("G000MG8221", "tower", "Small tower"),
  building("G000MG8262", "tower", "Lighthouse", "earth", 2), building("G000MG8263", "tower", "Lighthouse", "neutral", 2),
  building("G000MG8128", "standing-stone", "Column"), building("G000MG8129", "obelisk", "Obelisk", "dark"),
];
const WATCH = new Set(["G000MG8019", "G000MG8131"]);
const PILLARS = new Set(["G000MG8128", "G000MG8129"]);
const SMALL = new Set(["G000MG8022", "G000MG8221"]);

const doc = parseScenario(createBlankMap({ size: 48 }));
/** A wall plan: `B` = wall, `.` = passage. */
const grid = (rows: string[]) => ({ width: rows[0]!.length, height: rows.length, rows: rows.map((r) => r.replace(/\./g, "W")) });
type Placed = { id: string; x: number; y: number };
function decode(recipeId: string, rows: string[], catalog: object[] = CATALOG, variant = 0, scale = recipeId === "wall_maze" ? 2 : 1): Placed[] {
  const ops = decodeGrid(doc, grid(rows), DECODE_TABLES[recipeId]!, { x: 10, y: 10, w: rows[0]!.length * scale, h: rows.length * scale },
    buildWallSet(catalog as never), undefined, false, undefined, scale, undefined, 0, variant);
  return ops
    .filter((o): o is Extract<EditOp, { kind: "addObject" }> => o.kind === "addObject")
    .map((o) => ({ id: String((o.object as { baseType?: string }).baseType), x: o.object.pos.x, y: o.object.pos.y }));
}
const TWO = new Set(["G000MG0046", "G000MG0047", "G000MG0048", "G000MG8134", "G000MG8135", "G000MG8136", "G000MG8262", "G000MG8263"]);
const covered = (placed: Placed[]): Set<string> => {
  const out = new Set<string>();
  for (const p of placed) {
    const s = TWO.has(p.id) ? 2 : 1;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) out.add(`${p.x + dx},${p.y + dy}`);
  }
  return out;
};
/** the cells a walker reaches from `start`, stepping in all eight directions over free cells */
function reach(blocked: Set<string>, start: [number, number], box: [number, number, number, number]): Set<string> {
  const seen = new Set<string>([`${start[0]},${start[1]}`]);
  const queue = [start];
  while (queue.length) {
    const [x, y] = queue.pop()!;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if ((!dx && !dy) || seen.has(k) || blocked.has(k) || nx < box[0] || ny < box[1] || nx > box[2] || ny > box[3]) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return seen;
}
const at = (placed: Placed[], gx: number, gy: number, scale = 1): string | undefined =>
  placed.find((p) => p.x === 10 + gx * scale && p.y === 10 + gy * scale)?.id;

// corners, tees, straight runs and a wall that stops on the edge (one side of an entrance)
const PLAN = [
  "BBBBB",
  "B.B.B",
  "BBBBB",
  "B....",
  "B....",
];
const JOINTS = 7; // 3 corners, 3 tees, and the wall that stops on the edge of the figure

describe("the fortress maze (2×2 walls)", () => {
  const placed = decode("wall_maze", PLAN);

  it("builds straight runs from 2×2 pieces and puts ONE tower on each joint", () => {
    expect(placed.filter((p) => p.id === TOWER)).toHaveLength(JOINTS);
    expect(placed.some((p) => FORTRESS.has(p.id))).toBe(true);
    expect(placed.every((p) => p.id === TOWER || FORTRESS.has(p.id) || THIN.has(p.id))).toBe(true);
    // a straight block is one piece, turned along its run
    expect(at(placed, 1, 0, 2)).toBe("G000MG0048"); // a run along x
    expect(at(placed, 0, 1, 2)).toBe("G000MG0047"); // a run along y
  });

  it("stands the tower in the front cell of its block", () => {
    for (const t of placed.filter((p) => p.id === TOWER)) {
      expect([(t.x - 10) % 2, (t.y - 10) % 2]).toEqual([1, 1]);
    }
  });

  it("closes a joint with one-cell walls where an arm runs in — and only there", () => {
    // 2 beside a corner or a wall tip, 3 in a tee: no stray block on the outside of a corner
    expect(placed.filter((p) => THIN.has(p.id))).toHaveLength(2 + 3 + 2 + 3 + 3 + 3 + 2);
    // the top-left corner block joins a wall to the east and one to the south: its far cell stays free
    expect(covered(placed).has("10,10")).toBe(false);
    expect(covered(placed).has("11,10")).toBe(true);
    expect(covered(placed).has("10,11")).toBe(true);
  });

  it("leaves no way through a wall — not even diagonally", () => {
    const blocked = covered(placed);
    // the two rooms of the plan are 2×2 cells each, walled all round
    for (const room of [[12, 12], [16, 12]] as [number, number][]) {
      expect(reach(blocked, room, [6, 6, 24, 24]).size).toBe(4);
    }
    // every straight block is covered whole, and nothing is put on a passage
    PLAN.forEach((row, gy) => [...row].forEach((ch, gx) => {
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        if (ch !== "B") expect(blocked.has(`${10 + gx * 2 + dx},${10 + gy * 2 + dy}`), `passage ${gx},${gy}`).toBe(false);
      }
    }));
  });

  it("closes a joint with towers alone when the mod has no one-cell walls: one inside every turn", () => {
    const only2x2 = CATALOG.filter((e) => !THIN.has(e.id) && !FENCE.has(e.id));
    const bare = decode("wall_maze", PLAN, only2x2);
    // a corner has one turn, a tee two, a tip none (it gets a single tower all the same)
    expect(bare.filter((p) => p.id === TOWER)).toHaveLength(3 * 1 + 3 * 2 + 1);
    expect(bare.every((p) => p.id === TOWER || FORTRESS.has(p.id))).toBe(true);
    // the top-left corner turns from east to south: its tower stands in the cell between them
    expect(bare.filter((p) => p.x < 12 && p.y < 12).map((p) => [p.x, p.y])).toEqual([[11, 11]]);
    for (const room of [[12, 12], [16, 12]] as [number, number][]) expect(reach(covered(bare), room, [6, 6, 24, 24]).size).toBe(4);
    // a crossing closes all four of its turns
    const cross = decode("wall_maze", ["BBBBB", "B.B.B", "BBBBB", "B.B.B", "BBBBB"], only2x2);
    expect(cross.filter((p) => p.id === TOWER && p.x >= 14 && p.x < 16 && p.y >= 14 && p.y < 16)).toHaveLength(4);
    for (const room of [[12, 12], [16, 12], [12, 16], [16, 16]] as [number, number][]) expect(reach(covered(cross), room, [6, 6, 24, 24]).size).toBe(4);
  });

  it("the inner tip of a wall is a plain piece, not a tower", () => {
    // a wall that stops INSIDE the figure (the frame around it makes the edge)
    const tip = decode("wall_maze", ["BBBBB", "B...B", "B.B.B", "B.B.B", "BBBBB"]);
    expect(at(tip, 2, 2, 2)).toBe("G000MG0047");
    expect(tip.filter((p) => p.id === TOWER)).toHaveLength(4 + 1); // the four corners and the tee at the bottom
  });
});

describe("the fortress in its other dresses", () => {
  it("takes the stone or its mossy twin by the variant — never a mix of the two", () => {
    const light = new Set(decode("wall_maze", PLAN, RICH, 0).map((p) => p.id));
    const mossy = new Set(decode("wall_maze", PLAN, RICH, 1).map((p) => p.id));
    expect([...light].some((id) => id === "G000MG0047" || id === "G000MG0048")).toBe(true);
    expect([...light].some((id) => id.startsWith("G000MG813"))).toBe(false);
    expect([...mossy].some((id) => id === "G000MG8135" || id === "G000MG8136")).toBe(true);
    expect([...mossy].some((id) => id === "G000MG0047" || id === "G000MG0048")).toBe(false);
  });

  it("stands towers of the set's own stone on the joints, two kinds taking turns", () => {
    const light = decode("wall_maze", PLAN, RICH, 0).map((p) => p.id);
    expect(light.filter((id) => id === "G000MG0149").length).toBeGreaterThan(0);
    expect(light.filter((id) => id === "G000MG0150").length).toBeGreaterThan(0);
    expect(light.some((id) => id === "G000MG8132" || id === "G000MG8133")).toBe(false);
    const mossy = decode("wall_maze", PLAN, RICH, 1).map((p) => p.id);
    expect(mossy.filter((id) => id === "G000MG8132" || id === "G000MG8133")).toHaveLength(JOINTS);
    expect(mossy.some((id) => id === "G000MG0149" || id === "G000MG0150")).toBe(false);
  });

  it("every third variant puts a 2×2 bastion on the outer corners", () => {
    const frame = ["BBBBB", "B...B", "B...B", "B...B", "BBBBB"];
    const plain = decode("wall_maze", frame, RICH, 0);
    const grand = decode("wall_maze", frame, RICH, 2);
    expect(plain.some((p) => p.id === "G000MG8262" || p.id === "G000MG8263")).toBe(false);
    expect(grand.filter((p) => p.id === "G000MG8262").map((p) => [p.x - 10, p.y - 10]).sort()).toEqual([[0, 0], [0, 8], [8, 0], [8, 8]]);
    expect(grand.some((p) => p.id === "G000MG8263")).toBe(false); // the earth-toned one of the two
    expect(reach(covered(grand), [14, 14], [6, 6, 24, 24]).size).toBe(36); // the yard, and no way out
  });
});

describe("the ruined stone walls (one-cell)", () => {
  it("uses the ruined set, with towers only on the outer corners of the figure", () => {
    const placed = decode("wall_maze_thin", PLAN);
    expect(placed).toHaveLength(PLAN.join("").split("B").length - 1); // one piece per wall cell
    // the plan's wall cells at the corners of its bounding box: (0,0), (4,0) and (0,4)
    expect(placed.filter((p) => p.id === TOWER).map((p) => [p.x - 10, p.y - 10]).sort()).toEqual([[0, 0], [0, 4], [4, 0]]);
    expect(placed.every((p) => p.id === TOWER || THIN.has(p.id))).toBe(true);
    // with no columns in the mod the inner joints turn with the set's own corner blocks
    expect(placed.filter((p) => p.id === "G003MG0011" || p.id === "G003MG0012").length).toBeGreaterThanOrEqual(4);
  });

  it("puts a tower on a lone post", () => {
    expect(decode("wall_maze_thin", ["...", ".B.", "..."]).map((p) => p.id)).toEqual([TOWER]);
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

  it("stands a column on every inner joint and a turret on the outer corners", () => {
    const placed = decode("wall_maze_thin", PLAN, RICH, 0);
    const inner = [[2, 0], [0, 2], [2, 2], [4, 2]] as const; // the tees and the inner corner
    for (const [gx, gy] of inner) expect(PILLARS.has(at(placed, gx, gy)!), `${gx},${gy}`).toBe(true);
    expect(new Set(inner.map(([gx, gy]) => at(placed, gx, gy))).size).toBe(1); // one kind of column per maze
    for (const [gx, gy] of [[0, 0], [4, 0], [0, 4]] as const) expect(SMALL.has(at(placed, gx, gy)!), `${gx},${gy}`).toBe(true);
    // another variant, another column and another turret
    const other = decode("wall_maze_thin", PLAN, RICH, 1);
    expect(at(other, 2, 2)).not.toBe(at(placed, 2, 2));
    expect(at(other, 0, 0)).not.toBe(at(placed, 0, 0));
    // the wreckage that is also called a wall is not what a maze is built of
    expect([...placed, ...other].some((p) => p.id.startsWith("G000MG808") || p.id === "G000MG8090")).toBe(false);
  });

  it("builds a run of whole pieces and lets it crumble at a free end", () => {
    // a frame with a wall hanging into the yard from each side: four free tips
    const placed = decode("wall_maze_thin", [
      "BBBBBBB",
      "B..B..B",
      "B.....B",
      "BB...BB",
      "B.....B",
      "B..B..B",
      "BBBBBBB",
    ], RICH);
    expect(at(placed, 1, 0)).toBe("G003MG0009"); // the body of a run along x: the whole piece
    expect(at(placed, 0, 1)).toBe("G003MG0010"); // … along y: the least lopsided of the two
    expect(at(placed, 3, 1)).toBe("G003MG0010"); // a tip attached to the north: the half that leans that way
    expect(at(placed, 3, 5)).toBe("G003MG0014"); // … to the south
    expect(at(placed, 5, 3)).toBe("G003MG0013"); // … to the east
    expect(at(placed, 1, 3)).toBe("G003MG0009"); // … to the west: the set has no such half, the whole piece stands in
  });
});

describe("the palisade (one-cell)", () => {
  it("is built of its own pieces only — no stone tower on a wooden corner", () => {
    const placed = decode("wall_maze_fence", PLAN);
    expect(placed).toHaveLength(PLAN.join("").split("B").length - 1);
    expect(placed.every((p) => FENCE.has(p.id))).toBe(true);
  });

  it("turns each corner with the piece that joins those two arms", () => {
    // a ring: its four corners are the four corner pieces, each once (no watchtowers in this mod)
    const ring = decode("wall_maze_fence", ["BBB", "B.B", "BBB"], RICH.filter((e) => e.shape !== "tower"));
    expect(at(ring, 0, 0)).toBe("G000MG8301"); // arms east and south: the one that opens down
    expect(at(ring, 2, 0)).toBe("G000MG8300"); // south and west: opens to the left
    expect(at(ring, 2, 2)).toBe("G000MG8298"); // west and north: opens up
    expect(at(ring, 0, 2)).toBe("G000MG8299"); // north and east: opens to the right
    expect(at(ring, 1, 0)).toBe("G000MG8296");
    expect(at(ring, 0, 1)).toBe("G000MG8297");
  });

  it("stands watchtowers on the outer corners and by an entrance, and nowhere else", () => {
    // a ring with a gap in its top side, and a wall across the yard
    const rows = [
      "BB.BBBB",
      "B.....B",
      "BBBBB.B",
      "B.....B",
      "BBBBBBB",
    ];
    const placed = decode("wall_maze_fence", rows, RICH);
    const towers = placed.filter((p) => WATCH.has(p.id)).map((p) => `${p.x - 10},${p.y - 10}`).sort();
    expect(towers).toEqual(["0,0", "0,4", "1,0", "3,0", "6,0", "6,4"]); // the four corners and the two gate posts
    expect(placed.every((p) => WATCH.has(p.id) || p.id.startsWith("G000MG829") || p.id.startsWith("G000MG830"))).toBe(true);
    // a tee has no piece of its own: the through run goes on
    expect(at(placed, 0, 2)).toBe("G000MG8297");
    // the corner towers of a maze are of one kind, the gate posts of another
    expect(new Set([at(placed, 6, 0), at(placed, 0, 4), at(placed, 6, 4)]).size).toBe(1);
    expect(at(placed, 3, 0)).not.toBe(at(placed, 6, 4));
  });
});

describe("what a mod needs for each maze", () => {
  const sets = (catalog: object[]) => ({ walls: buildWallSet(catalog as never), decor: {} });
  const LACKS = "в этом моде нет стен для лабиринта";

  it("has all three with the full catalogue", () => {
    for (const id of ["wall_maze", "wall_maze_thin", "wall_maze_fence"]) expect(recipeLacks(id, sets(CATALOG)), id).toBeUndefined();
    for (const id of ["wall_maze", "wall_maze_thin", "wall_maze_fence"]) expect(recipeLacks(id, sets(RICH)), id).toBeUndefined();
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

describe("the art sets of a catalogue", () => {
  const walls = buildWallSet(RICH as never);

  it("are runs of consecutive ids: the stone wall and its mossy twin are two sets", () => {
    expect(wallStylesFor(walls, "wall", 2).map((s) => s.key)).toEqual(["wall|G000MG0046", "wall|G000MG8134"]);
    expect(wallStylesFor(walls, "wall", 2).map((s) => s.tone)).toEqual(["neutral", "dark"]);
    expect(pickWallStyle(walls, "wall", 2, 0)?.key).toBe("wall|G000MG0046");
    expect(pickWallStyle(walls, "wall", 2, 1)?.key).toBe("wall|G000MG8134");
    expect(pickWallStyle(walls, "wall", 2, 2)?.key).toBe("wall|G000MG0046");
  });

  it("of the one-cell stone sets only the richest is a wall to build with", () => {
    expect(wallStylesFor(walls, "wall", 1).map((s) => s.key)).toEqual(["wall|G003MG0009"]); // six pieces; the wreckage has four
    expect(walls.styles.map((s) => s.key)).toContain("wall|G000MG8087");
  });

  it("the fortress look comes first, a palisade last", () => {
    expect(walls.styles[0]!.key).toBe("wall|G000MG0046");
    expect(walls.styles[walls.styles.length - 1]!.key).toBe("fence|G000MG8296");
  });

  it("tells the four corners of a palisade apart, and the half walls of a ruined set", () => {
    const fence = pickWallStyle(walls, "fence", 1)!;
    expect(fence.corners).toEqual({ 3: "G000MG8299", 6: "G000MG8301", 9: "G000MG8298", 12: "G000MG8300" });
    const ruins = pickWallStyle(walls, "wall", 1)!;
    expect(ruins.corners).toBeUndefined(); // two blocks, not four corners
    expect(ruins.stubs).toEqual({ 1: "G003MG0010", 2: "G003MG0013", 4: "G003MG0014" }); // toward the north, east, south
    expect(ruins.s1["NW-SE"][0]).toBe("G003MG0009"); // the whole piece first
  });

  it("without the geometry (an older catalogue) there are no corner or half pieces to tell", () => {
    const old = buildWallSet(CATALOG as never);
    for (const st of old.styles) {
      expect(st.corners).toBeUndefined();
      expect(st.stubs).toBeUndefined();
    }
  });

  it("gives each set a turret of its own stone", () => {
    expect(pickWallStyle(walls, "wall", 2, 0)?.tower).toBe("G000MG0149");
    expect(pickWallStyle(walls, "wall", 2, 1)?.tower).toBe("G000MG8132");
  });

  it("collects the buildings for the joints by kind", () => {
    expect(walls.ornaments?.towers.map((t) => t.kind).sort()).toEqual(
      ["Small tower", "Small tower", "Tower", "Tower", "Tower", "Tower", "Watchtower", "Watchtower"]);
    expect(walls.ornaments?.bastions.map((t) => t.id)).toEqual(["G000MG8262", "G000MG8263"]);
    expect(walls.ornaments?.pillars.map((t) => t.id)).toEqual(["G000MG8128", "G000MG8129"]);
  });
});
