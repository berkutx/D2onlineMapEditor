import { describe, it, expect } from "vitest";
import { fogRuns } from "../src/fogRuns";

const grid = (size: number, rows: string[]): { size: number; hidden: Uint8Array } => {
  const hidden = new Uint8Array(size * size);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { hidden[y * size + x] = ch === "#" ? 1 : 0; }));
  return { size, hidden };
};

describe("fogRuns: the quads of a fog veil", () => {
  it("merges neighbouring hidden cells of a line into one run", () => {
    const runs = fogRuns(grid(8, [
      "########",
      "##..####",
      "........",
      "#.#.#.#.",
    ]));
    expect(runs).toEqual([
      { y: 0, x0: 0, x1: 8 },
      { y: 1, x0: 0, x1: 2 },
      { y: 1, x0: 4, x1: 8 },
      { y: 3, x0: 0, x1: 1 },
      { y: 3, x0: 2, x1: 3 },
      { y: 3, x0: 4, x1: 5 },
      { y: 3, x0: 6, x1: 7 },
    ]);
  });

  it("draws nothing for an open map and one run per line for a hidden one", () => {
    expect(fogRuns({ size: 144, hidden: new Uint8Array(144 * 144) })).toEqual([]);
    expect(fogRuns({ size: 144, hidden: new Uint8Array(144 * 144).fill(1) })).toHaveLength(144);
  });
});
