/** diffLines: hunks of a line diff, checked by hand and against a plain LCS. */
import { describe, it, expect } from "vitest";
import { diffLines, lineEdits, splitLines } from "../src/index";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

/** Length of a longest common subsequence, by the textbook table. */
function lcs(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j]!, row[j - 1]!);
      diag = up;
    }
  }
  return row[b.length]!;
}

/** A small seeded generator, so a failure repeats. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("diffLines", () => {
  it("gives no hunks for equal texts", () => {
    expect(diffLines("a\nb\n", "a\nb\n")).toEqual([]);
    expect(diffLines("", "")).toEqual([]);
  });

  it("splits lines on any line break; a final break starts no line", () => {
    expect(splitLines("a\r\nb\nc\rd\n")).toEqual(["a", "b", "c", "d"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([]);
  });

  it("makes hunks with context around each change", () => {
    const a = numbered(10);
    const b = [...a];
    b[4] = "five";
    b.splice(9, 0, "extra"); // before line 10
    const hunks = diffLines(a.join("\n"), b.join("\n"), 1);
    expect(hunks).toEqual([
      {
        aStart: 4,
        aCount: 3,
        bStart: 4,
        bCount: 3,
        lines: [
          { kind: "same", text: "line 4", a: 4, b: 4 },
          { kind: "removed", text: "line 5", a: 5 },
          { kind: "added", text: "five", b: 5 },
          { kind: "same", text: "line 6", a: 6, b: 6 },
        ],
      },
      {
        aStart: 9,
        aCount: 2,
        bStart: 9,
        bCount: 3,
        lines: [
          { kind: "same", text: "line 9", a: 9, b: 9 },
          { kind: "added", text: "extra", b: 10 },
          { kind: "same", text: "line 10", a: 10, b: 11 },
        ],
      },
    ]);
    // with the default context of 3 the two changes share one hunk
    expect(diffLines(a.join("\n"), b.join("\n"))).toHaveLength(1);
    // context = Infinity: one hunk of every line
    const all = diffLines(a.join("\n"), b.join("\n"), Infinity);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ aStart: 1, aCount: 10, bStart: 1, bCount: 11 });
  });

  it("starts a hunk with no lines of one side at the line it comes before", () => {
    expect(diffLines("", "x\ny")).toEqual([
      {
        aStart: 1,
        aCount: 0,
        bStart: 1,
        bCount: 2,
        lines: [
          { kind: "added", text: "x", b: 1 },
          { kind: "added", text: "y", b: 2 },
        ],
      },
    ]);
    expect(diffLines("x\ny\n", "")).toMatchObject([{ aStart: 1, aCount: 2, bStart: 1, bCount: 0 }]);
  });

  it("keeps a longest common subsequence and rebuilds both texts", () => {
    const next = random(7);
    for (let round = 0; round < 300; round++) {
      const pick = () => Array.from({ length: Math.floor(next() * 14) }, () => "abcd"[Math.floor(next() * 4)]!);
      const a = pick();
      const b = pick();
      const edits = lineEdits(a.map((s) => s + "\n").join(""), b.map((s) => s + "\n").join(""));
      expect(edits.filter((e) => e.kind !== "added").map((e) => e.text)).toEqual(a);
      expect(edits.filter((e) => e.kind !== "removed").map((e) => e.text)).toEqual(b);
      expect(edits.filter((e) => e.kind === "same")).toHaveLength(lcs(a, b));
      expect(edits.filter((e) => e.kind !== "added").map((e) => e.a)).toEqual(a.map((_, i) => i + 1));
      expect(edits.filter((e) => e.kind !== "removed").map((e) => e.b)).toEqual(b.map((_, i) => i + 1));
    }
  });

  it("handles a long file with scattered changes", () => {
    const a = numbered(50_000);
    const b = a.map((l, i) => (i % 2_500 === 0 ? `${l} changed` : l));
    const hunks = diffLines(a.join("\n"), b.join("\n"));
    expect(hunks).toHaveLength(20);
    expect(hunks.every((h) => h.lines.filter((l) => l.kind === "removed").length === 1)).toBe(true);
  });
});
