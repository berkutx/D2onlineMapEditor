/**
 * RoomSnapshots unit tests — the materialised-doc cache must ALWAYS equal a full fold of the
 * log onto the base doc, whether it folds from base or advances a cached snapshot by the tail.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("persists a gz snapshot and a FRESH instance seeds from it — no full re-fold, same result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d2-snap-"));
    try {
      const key = "persist#c";
      const durableLog = new EditLog(dir); // the log is durable too (shared ROOMS_DIR)
      await durableLog.ensureLoaded(key);
      // cross PERSIST_EVERY (2000) so materialise writes a gz snapshot
      for (let i = 0; i < 2100; i++) durableLog.append(key, setCell(i % 4, Math.floor(i / 4) % 4, (i % 9) + 1), "s", `c${i}`, 0);
      await durableLog.flush(key);

      const a = new RoomSnapshots(dir);
      await a.ensureLoaded(key);
      const built = a.materialize(key, baseDoc(), durableLog); // writes .snap.<seq>.json.gz
      await a.flush(key);
      expect(built.seq).toBe(2100);
      const snapFiles = (await readdir(dir)).filter((f) => f.includes(".snap.") && f.endsWith(".json.gz"));
      expect(snapFiles.length).toBeGreaterThanOrEqual(1);

      // a fresh RoomSnapshots (== server restart) seeds its cache from the snapshot file, then
      // folds only the tail — the result must equal a full fold of the (reloaded) log from base.
      const restartLog = new EditLog(dir);
      await restartLog.ensureLoaded(key);
      const b = new RoomSnapshots(dir);
      await b.ensureLoaded(key);
      const afterRestart = b.materialize(key, baseDoc(), restartLog);
      const groundTruth = applyOps(baseDoc(), restartLog.all(key).map((e) => e.op));
      expect(afterRestart.seq).toBe(2100);
      for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++)
        expect(cellVal(afterRestart.doc, x, y)).toBe(cellVal(groundTruth, x, y));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps at most 2 snapshot files per room (prunes older)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d2-snapkeep-"));
    try {
      const key = "keep#c";
      const log = new EditLog(dir);
      await log.ensureLoaded(key);
      const snaps = new RoomSnapshots(dir);
      await snaps.ensureLoaded(key);
      // three PERSIST_EVERY crossings → three write attempts, but only the newest 2 survive
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 2100; i++) log.append(key, setCell(0, 0, (i % 9) + 1), "s", `r${round}c${i}`, 0);
        snaps.materialize(key, baseDoc(), log);
        await snaps.flush(key);
      }
      const files = (await readdir(dir)).filter((f) => f.includes(".snap.") && f.endsWith(".json.gz"));
      expect(files.length).toBeLessThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
