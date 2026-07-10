/**
 * RoomEvictor (Phase 3, memory bound): an EMPTY room's parsed op-log + snapshot are freed from
 * RAM after a grace delay, so a long-lived server that has touched thousands of rooms doesn't
 * keep them all resident. The durable .jsonl is untouched — a real rejoin lazily re-reads it.
 * Covered: fires after the delay; a rejoin cancels; the fire-time re-checks (hasMembers /
 * degraded) veto eviction; dispose() cancels everything pending.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RoomEvictor } from "../src/realtime/RoomEvictor";
import { RoomManager } from "../src/realtime/RoomManager";

type Cleared = { log: string[]; snap: string[] };

/** Minimal fakes standing in for EditLog / RoomSnapshots: they only need clear() + isDegraded(),
 *  and record which rooms were cleared so a test can assert eviction happened (or didn't). */
function fakes(degraded = new Set<string>()): {
  log: never;
  snapshots: never;
  cleared: Cleared;
} {
  const cleared: Cleared = { log: [], snap: [] };
  const log = {
    clear: (k: string) => cleared.log.push(k),
    isDegraded: (k: string) => degraded.has(k),
  };
  const snapshots = { clear: (k: string) => cleared.snap.push(k) };
  return { log: log as never, snapshots: snapshots as never, cleared };
}

const DELAY = 60_000;

describe("RoomEvictor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("evicts an empty room's log + snapshot after the grace delay", () => {
    const rooms = new RoomManager();
    const { log, snapshots, cleared } = fakes();
    const evictor = new RoomEvictor(rooms, log, snapshots, DELAY);

    // room "r1" is empty (never joined) — schedule + let the grace window pass
    evictor.schedule("r1");
    expect(cleared.log).toEqual([]); // nothing yet (still within grace)
    vi.advanceTimersByTime(DELAY);
    expect(cleared.log).toEqual(["r1"]);
    expect(cleared.snap).toEqual(["r1"]);
  });

  it("a rejoin (cancel) within the grace window prevents eviction", () => {
    const rooms = new RoomManager();
    const { log, snapshots, cleared } = fakes();
    const evictor = new RoomEvictor(rooms, log, snapshots, DELAY);

    evictor.schedule("r1");
    vi.advanceTimersByTime(DELAY / 2);
    evictor.cancel("r1"); // someone rejoined
    vi.advanceTimersByTime(DELAY);
    expect(cleared.log).toEqual([]); // never fired
  });

  it("does NOT evict if the room re-filled by fire time (hasMembers veto)", () => {
    const rooms = new RoomManager();
    const { log, snapshots, cleared } = fakes();
    const evictor = new RoomEvictor(rooms, log, snapshots, DELAY);

    evictor.schedule("r1");
    // a member joined but the schedule wasn't cancelled (e.g. join path that skips cancel);
    // the fire-time hasMembers() re-check must still veto the eviction.
    rooms.join("r1", "sock", "u", "U");
    vi.advanceTimersByTime(DELAY);
    expect(cleared.log).toEqual([]);
  });

  it("does NOT evict a degraded room (its in-memory tail is the only copy)", () => {
    const rooms = new RoomManager();
    const { log, snapshots, cleared } = fakes(new Set(["r1"]));
    const evictor = new RoomEvictor(rooms, log, snapshots, DELAY);

    evictor.schedule("r1");
    vi.advanceTimersByTime(DELAY);
    expect(cleared.log).toEqual([]); // degraded → kept in RAM
    expect(cleared.snap).toEqual([]);
  });

  it("re-scheduling replaces the timer (no double eviction)", () => {
    const rooms = new RoomManager();
    const { log, snapshots, cleared } = fakes();
    const evictor = new RoomEvictor(rooms, log, snapshots, DELAY);

    evictor.schedule("r1");
    vi.advanceTimersByTime(DELAY / 2);
    evictor.schedule("r1"); // resets the clock
    vi.advanceTimersByTime(DELAY / 2); // original would have fired here
    expect(cleared.log).toEqual([]); // reset pushed it out
    vi.advanceTimersByTime(DELAY / 2); // now the reset window elapses
    expect(cleared.log).toEqual(["r1"]); // fired exactly once
  });

  it("dispose() cancels every pending eviction", () => {
    const rooms = new RoomManager();
    const { log, snapshots, cleared } = fakes();
    const evictor = new RoomEvictor(rooms, log, snapshots, DELAY);

    evictor.schedule("r1");
    evictor.schedule("r2");
    evictor.dispose();
    vi.advanceTimersByTime(DELAY * 2);
    expect(cleared.log).toEqual([]);
  });
});
