/**
 * EditLog unit tests — the server-authoritative op log backing collaboration.
 * Pure (no sockets): asserts monotonic seq, per-map isolation, since() catch-up.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditOp } from "@d2/socket-contract";
import { EditLog } from "../src/realtime/EditLog";

const setCell = (x: number, y: number, value: number): EditOp => ({ kind: "setCell", x, y, value });

describe("EditLog", () => {
  it("assigns monotonic 1-based seqs per map and reports head", () => {
    const log = new EditLog();
    expect(log.head("m")).toBe(0);
    const a = log.append("m", setCell(0, 0, 1), "sock1", "c1", 100);
    const b = log.append("m", setCell(1, 0, 2), "sock2", "c2", 101);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(log.head("m")).toBe(2);
    expect(log.all("m").map((e) => e.by)).toEqual(["sock1", "sock2"]);
  });

  it("isolates logs per map id", () => {
    const log = new EditLog();
    log.append("a", setCell(0, 0, 1), "s", "c", 0);
    log.append("a", setCell(0, 0, 1), "s", "c", 0);
    log.append("b", setCell(0, 0, 1), "s", "c", 0);
    expect(log.head("a")).toBe(2);
    expect(log.head("b")).toBe(1);
    expect(log.head("c")).toBe(0);
  });

  it("since(seq) returns only entries after seq (reconnect catch-up)", () => {
    const log = new EditLog();
    for (let i = 0; i < 5; i++) log.append("m", setCell(i, 0, i), "s", `c${i}`, i);
    expect(log.since("m", 0)).toHaveLength(5); // 0 / negative => whole log
    expect(log.since("m", 3).map((e) => e.seq)).toEqual([4, 5]);
    expect(log.since("m", 5)).toHaveLength(0);
  });

  it("preserves the exact op payload (incl. road fields)", () => {
    const log = new EditLog();
    const op: EditOp = { kind: "setCell", x: 2, y: 3, value: 9, roadType: 4, roadVar: 1 };
    const e = log.append("m", op, "s", "c", 0);
    expect(e.op).toEqual(op);
    expect(e.clientOpId).toBe("c");
  });

  it("appendBatch adds a run of consecutive seqs sharing one batchId", () => {
    const log = new EditLog();
    log.append("m", setCell(0, 0, 1), "s", "solo", 0); // a prior standalone op (seq 1)
    const ops = [
      { clientOpId: "b0", op: setCell(1, 1, 5) },
      { clientOpId: "b1", op: setCell(2, 2, 6) },
      { clientOpId: "b2", op: setCell(3, 3, 7) },
    ];
    const entries = log.appendBatch("m", ops, "sock", "BATCH1", 42);
    expect(entries.map((e) => e.seq)).toEqual([2, 3, 4]); // consecutive, continuing the log
    expect(entries.every((e) => e.batchId === "BATCH1")).toBe(true);
    expect(entries.every((e) => e.by === "sock")).toBe(true);
    expect(log.head("m")).toBe(4);
    // the batch is visible to a catch-up (since) with its batchId intact
    expect(log.since("m", 1).map((e) => e.batchId)).toEqual(["BATCH1", "BATCH1", "BATCH1"]);
    expect(log.since("m", 1).map((e) => e.op)).toEqual(ops.map((o) => o.op));
  });

  it("records a durable `author` (clientId), falling back to the socket id", () => {
    const log = new EditLog();
    const a = log.append("m", setCell(0, 0, 1), "sockX", "c1", 0, undefined, "client-77");
    const b = log.append("m", setCell(1, 0, 2), "sockY", "c2", 0); // no author -> falls back to `by`
    expect(a.author).toBe("client-77");
    expect(b.author).toBe("sockY");
  });

  it("persists to disk and a FRESH instance reloads the same log (server restart)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d2-editlog-"));
    try {
      const key = "map1#chanA";
      const a = new EditLog(dir);
      await a.ensureLoaded(key);
      a.append(key, setCell(0, 0, 1), "s1", "c1", 100, undefined, "clientA");
      a.appendBatch(
        key,
        [{ clientOpId: "c2", op: setCell(1, 1, 5) }, { clientOpId: "c3", op: setCell(2, 2, 6) }],
        "s2",
        "BATCH",
        101,
        "clientB",
      );
      await a.flush(key);

      // a brand-new instance (== server restart) must see the SAME log from disk
      const b = new EditLog(dir);
      await b.ensureLoaded(key);
      expect(b.head(key)).toBe(3);
      expect(b.all(key).map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(b.all(key).map((e) => e.author)).toEqual(["clientA", "clientB", "clientB"]);
      expect(b.all(key).map((e) => e.clientOpId)).toEqual(["c1", "c2", "c3"]);
      expect(b.all(key).map((e) => e.op)).toEqual([setCell(0, 0, 1), setCell(1, 1, 5), setCell(2, 2, 6)]);
      // a fresh append continues the seq (no restart at 1)
      const cont = b.append(key, setCell(3, 3, 9), "s3", "c4", 102, undefined, "clientC");
      expect(cont.seq).toBe(4);
      // isolation: a different room key is empty
      await b.ensureLoaded("map1#other");
      expect(b.head("map1#other")).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves stored seqs across a GAP — a dropped line does NOT renumber later ops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d2-editlog-gap-"));
    try {
      const key = "gapmap#c";
      const file = join(dir, createHash("sha1").update(key).digest("hex") + ".jsonl");
      // simulate a persisted log whose seq-3 line was lost to a failed write: seqs 1,2,4,5
      const line = (seq: number, x: number): string =>
        JSON.stringify({ seq, op: setCell(x, 0, x), by: "s", author: "a", clientOpId: `c${seq}`, ts: 0 }) + "\n";
      await writeFile(file, line(1, 1) + line(2, 2) + line(4, 4) + line(5, 5));

      const log = new EditLog(dir);
      await log.ensureLoaded(key);
      expect(log.head(key)).toBe(5); // MAX seq, not the count (4)
      expect(log.all(key).map((e) => e.seq)).toEqual([1, 2, 4, 5]); // gap preserved, not renumbered
      // since() filters by SEQ, not array index — catch-up window stays correct across the gap
      expect(log.since(key, 2).map((e) => e.seq)).toEqual([4, 5]);
      expect(log.since(key, 4).map((e) => e.seq)).toEqual([5]);
      expect(log.since(key, 5)).toHaveLength(0);
      // a fresh append continues from the MAX seq (6), never colliding with an existing seq
      const cont = log.append(key, setCell(9, 0, 9), "s", "cN", 0, undefined, "a");
      expect(cont.seq).toBe(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
