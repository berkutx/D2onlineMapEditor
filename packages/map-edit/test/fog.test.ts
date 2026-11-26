/**
 * A player's fog of war: the bit layout of a MidgardMapFog line, the setFog op with its
 * inverse, and the same fog coming back from an exported file — through the model rebuild
 * (the export path) and through the byte-patch writer (the tests' oracle).
 */
import { describe, it, expect } from "vitest";
import { createBlankMap, parseScenario, parseScenarioRaw, serializeMapFromModelBytes } from "@d2/sg-parser";
import type { FogInfo } from "@d2/map-schema";
// the sources, not the built package: a new op must not be tested against a stale build
import {
  applyEditsToBytes, applyOp, applyOps, diffDocs, invertOps, materializeForExport, opKeys, roundTripSemantic,
  fogFillOps, fogGrid, fogHiddenCount, fogOfPlayer, fogPaintOps, fogSquare, isFogged, type EditOp,
} from "../src/index";

const SIZE = 48;
const base = createBlankMap({ size: SIZE, name: "Fog", races: ["empire", "undead"] });
const doc = parseScenario(base);
const empire = doc.players.find((p) => p.fogId === "S143FG0001")!;
const fogOf = (bytes: Uint8Array, id: string): FogInfo => parseScenario(bytes).satellites!.fogs.find((f) => f.id === id)!;
const exported = (ops: readonly EditOp[]): Uint8Array => serializeMapFromModelBytes(base, materializeForExport(doc, ops));

describe("the fog mask of a map line", () => {
  it("hides a cell with a set bit, least significant bit first", () => {
    // byte 0 = 0b00000101 hides x=0 and x=2; byte 1 = 0b10000000 hides x=15
    const fog: FogInfo = { id: "S143FG0001", rows: [{ y: 3, mask: [0b101, 0b10000000, 0, 0, 0, 0] }] };
    const hiddenX = [...Array(SIZE).keys()].filter((x) => isFogged(fog, x, 3));
    expect(hiddenX).toEqual([0, 2, 15]);
    expect(isFogged(fog, 0, 4)).toBe(false); // a line the block lacks is open
    expect(fogHiddenCount(fog, SIZE)).toBe(3);
    const grid = fogGrid(fog, SIZE);
    expect(grid[3 * SIZE + 15]).toBe(1);
    expect(grid.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("a new map starts with every player's fog block present and all open bits", () => {
    expect(fogOfPlayer(doc, empire.id)?.rows).toHaveLength(SIZE);
    expect(fogHiddenCount(fogOfPlayer(doc, empire.id)!, SIZE)).toBe(0);
    expect(fogOfPlayer(doc, "S143PL00ff")).toBeUndefined();
  });
});

describe("setFog", () => {
  it("hides the whole map, then opens a square: only the lines that change travel in the op", () => {
    const hideAll = fogFillOps(doc, "S143FG0001", true);
    expect(hideAll).toHaveLength(1);
    const hidden = applyOps(doc, hideAll);
    expect(fogHiddenCount(fogOfPlayer(hidden, empire.id)!, SIZE)).toBe(SIZE * SIZE);
    expect(fogFillOps(hidden, "S143FG0001", true)).toEqual([]); // already hidden: nothing to do

    const open = fogPaintOps(hidden, "S143FG0001", fogSquare(10, 20, 2), false);
    expect(open).toHaveLength(1);
    const op = open[0] as Extract<EditOp, { kind: "setFog" }>;
    expect(op.rows.map((r) => r.y)).toEqual([18, 19, 20, 21, 22]);
    expect(opKeys(op)).toEqual([18, 19, 20, 21, 22].map((y) => `F:S143FG0001:${y}`));
    const opened = applyOps(hidden, open);
    const fog = fogOfPlayer(opened, empire.id)!;
    expect(fogHiddenCount(fog, SIZE)).toBe(SIZE * SIZE - 25);
    expect(isFogged(fog, 8, 18)).toBe(false);
    expect(isFogged(fog, 12, 22)).toBe(false);
    expect(isFogged(fog, 7, 20)).toBe(true);
    expect(isFogged(fog, 13, 20)).toBe(true);
    // the other player's fog is not touched
    expect(fogHiddenCount(opened.satellites!.fogs.find((f) => f.id === "S143FG0002")!, SIZE)).toBe(0);
  });

  it("ignores cells outside the map and makes no op when nothing changes", () => {
    expect(fogPaintOps(doc, "S143FG0001", [{ x: -1, y: 0 }, { x: SIZE, y: 3 }, { x: 2, y: SIZE }], true)).toEqual([]);
    expect(fogPaintOps(doc, "S143FG0001", fogSquare(5, 5, 1), false)).toEqual([]); // already open
    expect(fogPaintOps(doc, "S143FG00ff", fogSquare(5, 5, 1), true)).toEqual([]); // no such fog
    // a square hanging over the corner hides only what is on the map
    const corner = applyOps(doc, fogPaintOps(doc, "S143FG0001", fogSquare(0, 0, 2), true));
    expect(fogHiddenCount(fogOfPlayer(corner, empire.id)!, SIZE)).toBe(9);
  });

  it("is undone by its inverse, and the document is not mutated", () => {
    const before = JSON.stringify(doc.satellites!.fogs);
    const ops = fogPaintOps(doc, "S143FG0001", fogSquare(30, 30, 3), true);
    const applied = applyOp(doc, ops[0]!);
    expect(JSON.stringify(doc.satellites!.fogs)).toBe(before);
    expect(applyOp(applied.doc, applied.inverse).doc.satellites!.fogs).toEqual(doc.satellites!.fogs);
    const after = applyOps(doc, ops);
    expect(applyOps(after, invertOps(doc, ops)).satellites!.fogs).toEqual(doc.satellites!.fogs);
  });

  it("refuses a fog the map lacks, a line it lacks and a mask of the wrong width", () => {
    const row = (y: number, n: number) => ({ y, mask: new Array(n).fill(0) });
    expect(() => applyOp(doc, { kind: "setFog", id: "S143FG00ff", rows: [row(0, 6)] })).toThrow(/no fog block/);
    expect(() => applyOp(doc, { kind: "setFog", id: "S143FG0001", rows: [row(SIZE, 6)] })).toThrow(/no line/);
    expect(() => applyOp(doc, { kind: "setFog", id: "S143FG0001", rows: [row(0, 5)] })).toThrow(/takes 6 bytes/);
  });

  it("is found again by diffDocs", () => {
    const target = applyOps(doc, [...fogFillOps(doc, "S143FG0002", true), ...fogPaintOps(doc, "S143FG0001", fogSquare(4, 4, 1), true)]);
    const diff = diffDocs(doc, target);
    expect(diff.every((op) => op.kind === "setFog")).toBe(true);
    expect(applyOps(doc, diff).satellites!.fogs).toEqual(target.satellites!.fogs);
    expect(diffDocs(target, target)).toEqual([]);
  });
});

describe("a drawn fog in the exported file", () => {
  const ops: EditOp[] = [
    ...fogFillOps(doc, "S143FG0001", true),
    // open two squares in the hidden map; the second op is built against the result of the first
  ];
  const hidden = applyOps(doc, ops);
  ops.push(...fogPaintOps(hidden, "S143FG0001", [...fogSquare(6, 6, 4), ...fogSquare(40, 12, 1)], false));
  const expected = applyOps(doc, ops).satellites!.fogs.find((f) => f.id === "S143FG0001")!;

  it("survives the model rebuild (the export path)", () => {
    const out = exported(ops);
    expect(fogOf(out, "S143FG0001")).toEqual(expected);
    expect(fogHiddenCount(fogOf(out, "S143FG0001"), SIZE)).toBe(SIZE * SIZE - 81 - 9);
    expect(fogHiddenCount(fogOf(out, "S143FG0002"), SIZE)).toBe(0);
    expect(fogHiddenCount(fogOf(out, "S143FG0000"), SIZE)).toBe(0); // the neutral player's
    expect(out.length).toBe(base.length); // a mask changes no sizes
    expect(roundTripSemantic(doc, out, ops)).toEqual({ ok: true });
  });

  it("is written the same by the byte-patch writer", () => {
    const patched = applyEditsToBytes(parseScenarioRaw(base).raw, ops);
    expect(fogOf(patched, "S143FG0001")).toEqual(expected);
    expect(patched).toEqual(exported(ops));
  });

  it("is caught by the semantic check when the file disagrees with the model", () => {
    const out = exported(ops);
    const fewer = ops.slice(0, 1); // the model says «all hidden», the file has two squares open
    const verdict = roundTripSemantic(doc, out, fewer);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/туман S143FG0001/);
  });

  it("leaves a map nobody painted byte-identical", () => {
    expect(exported([])).toEqual(base);
  });
});
