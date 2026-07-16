import { describe, it, expect } from "vitest";
import { firstDiff, deepEqual } from "../src/verifySemantic.js";

// firstDiff is the primitive that turns "objects differ after round-trip" into a precise,
// located reason (id + json path + expected/actual). Its contract: return null EXACTLY when the
// values are deep-equal, else the FIRST divergence as {path, a=expected, b=actual}.
describe("firstDiff (precise semantic diff primitive)", () => {
  it("returns null for deeply-equal values (and stays in sync with deepEqual)", () => {
    const a = { id: "X", garrison: [{ unit: "U1", hp: 3 }, null], n: 5 };
    const b = { id: "X", garrison: [{ unit: "U1", hp: 3 }, null], n: 5 };
    expect(firstDiff(a, b)).toBeNull();
    expect(deepEqual(a, b)).toBe(true);
  });

  it("is key-order insensitive", () => {
    expect(firstDiff({ a: 1, b: 2 }, { b: 2, a: 1 })).toBeNull();
  });

  it("locates a changed leaf with a dotted/indexed path", () => {
    const d = firstDiff({ garrison: [{ unit: "U1" }, { unit: "U2" }] }, { garrison: [{ unit: "U1" }, { unit: null }] });
    expect(d).toEqual({ path: "garrison[1].unit", a: "U2", b: null });
  });

  it("reports an array length mismatch at .length", () => {
    const d = firstDiff({ items: [1, 2, 3] }, { items: [1, 2] });
    expect(d).toEqual({ path: "items.length", a: 3, b: 2 });
  });

  it("reports a key present on one side only (union of keys, not just A's keys)", () => {
    // b has an EXTRA key the model side lacks — must be reported, not skipped.
    const d = firstDiff({ id: "X" }, { id: "X", stray: true });
    expect(d).toEqual({ path: "stray", a: undefined, b: true });
  });

  it("distinguishes present-with-undefined from a differing value at the leaf", () => {
    const d = firstDiff({ hp: 3 }, { hp: 4 });
    expect(d).toEqual({ path: "hp", a: 3, b: 4 });
  });

  it("treats a type change (object vs array) as a root-level diff", () => {
    const d = firstDiff({ x: [] }, { x: {} });
    expect(d?.path).toBe("x");
  });

  it("deepEqual is exactly firstDiff === null over nested structures", () => {
    const base = { p: [{ q: [1, { r: "s" }] }], t: null };
    const same = { t: null, p: [{ q: [1, { r: "s" }] }] };
    const diff = { p: [{ q: [1, { r: "S" }] }], t: null };
    expect(deepEqual(base, same)).toBe(true);
    expect(deepEqual(base, diff)).toBe(false);
    expect(firstDiff(base, diff)).toEqual({ path: "p[0].q[1].r", a: "s", b: "S" });
  });
});
