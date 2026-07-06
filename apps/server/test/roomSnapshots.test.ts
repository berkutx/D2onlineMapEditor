/**
 * RoomSnapshots unit tests — the materialised-doc cache must ALWAYS equal a full fold of the
 * log onto the base doc, whether it folds from base or advances a cached snapshot by the tail.
 */

import { describe, it, expect } from "vitest";
import type { EditOp } from "@d2/socket-contract";
import type { MapDocument } from "@d2/map-schema";
import { applyOps } from "@d2/map-edit";
import { EditLog } from "../src/realtime/EditLog";
import { RoomSnapshots } from "../src/realtime/RoomSnapshots";

/** A tiny 4×4 base doc (all cells value 0), enough for setCell folds. */
function baseDoc(): MapDocument {
  const n = 4;
  const cells = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) cells.push({ x, y, value: 0, terrain: 0, ground: 0, forest: 0, roadType: -1, roadVar: -1 });
  return { name: "t", size: n, players: 0, terrain: { size: n, cells }, objects: [], version: "S143" } as unknown as MapDocument;
}

const setCell = (x: number, y: number, value: number): EditOp => ({ kind: "setCell", x, y, value });
const cellVal = (d: MapDocument, x: number, y: number): number => d.terrain.cells[y * d.size + x]!.value;

describe("RoomSnapshots", () => {
  it("materialise(head) == a full fold of the log onto base", () => {
    const key = "m#c";
    const log = new EditLog();
    const snaps = new RoomSnapshots();
    log.append(key, setCell(0, 0, 5), "s", "c1", 0);
    log.append(key, setCell(1, 1, 7), "s", "c2", 0);

    const { seq, doc } = snaps.materialize(key, baseDoc(), log);
    expect(seq).toBe(2);
    const full = applyOps(baseDoc(), log.all(key).map((e) => e.op));
    expect(cellVal(doc, 0, 0)).toBe(cellVal(full, 0, 0));
    expect(cellVal(doc, 1, 1)).toBe(cellVal(full, 1, 1));
    expect(cellVal(doc, 0, 0)).toBe(5);
  });

  it("advances a cached snapshot by folding ONLY the tail — result equals a from-scratch fold", () => {
    const key = "m#c";
    const log = new EditLog();
    const snaps = new RoomSnapshots();
    // enough ops to cross REFRESH_EVERY so the first materialise caches, the next folds the tail
    for (let i = 0; i < 250; i++) log.append(key, setCell(i % 4, Math.floor(i / 4) % 4, (i % 9) + 1), "s", `c${i}`, 0);
    const first = snaps.materialize(key, baseDoc(), log); // caches at 250
    expect(first.seq).toBe(250);

    // a fresh instance folding the WHOLE log from base is the ground truth
    const groundTruth1 = applyOps(baseDoc(), log.all(key).map((e) => e.op));
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++)
      expect(cellVal(first.doc, x, y)).toBe(cellVal(groundTruth1, x, y));

    // more ops → materialise must advance the cache by the tail and still match a full fold
    log.append(key, setCell(2, 2, 3), "s", "cA", 0);
    log.append(key, setCell(3, 3, 4), "s", "cB", 0);
    const second = snaps.materialize(key, baseDoc(), log);
    expect(second.seq).toBe(252);
    const groundTruth2 = applyOps(baseDoc(), log.all(key).map((e) => e.op));
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++)
      expect(cellVal(second.doc, x, y)).toBe(cellVal(groundTruth2, x, y));
    expect(cellVal(second.doc, 2, 2)).toBe(3);
    expect(cellVal(second.doc, 3, 3)).toBe(4);
  });
});
