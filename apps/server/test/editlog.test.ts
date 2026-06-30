/**
 * EditLog unit tests — the server-authoritative op log backing collaboration.
 * Pure (no sockets): asserts monotonic seq, per-map isolation, since() catch-up.
 */

import { describe, it, expect } from "vitest";
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
});
