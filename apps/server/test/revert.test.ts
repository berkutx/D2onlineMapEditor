/**
 * edit:revertRange (M5) — conflict-aware, per-author rollback. Handler-level test with fake
 * sockets sharing one EditLog: my ops roll back, a PEER's edit on the same cell forms a
 * conflict boundary (I stop there, the peer's value stays). Verifies the reverted state via
 * the RoomSnapshots materialisation of the post-revert HEAD.
 */

import { describe, it, expect } from "vitest";
import type { EditOp } from "@d2/socket-contract";
import type { MapDocument } from "@d2/map-schema";
import { registerRoomHandlers } from "../src/realtime/handlers.room";
import { RoomManager } from "../src/realtime/RoomManager";
import { EditLog } from "../src/realtime/EditLog";
import { RoomSnapshots } from "../src/realtime/RoomSnapshots";
import { roomKey } from "../src/realtime/RoomManager";

type Handler = (...args: unknown[]) => void;

function fakeSocket(id: string, clientId: string): {
  socket: never;
  invoke: (ev: string, ...args: unknown[]) => void;
} {
  const handlers = new Map<string, Handler>();
  const sink = { emit: () => undefined };
  const socket = {
    id,
    connected: true,
    disconnected: false,
    data: { userId: `u-${id}`, clientId },
    on: (ev: string, fn: Handler) => handlers.set(ev, fn),
    join: () => Promise.resolve(),
    to: () => sink,
    emit: () => undefined,
  };
  return {
    socket: socket as never,
    invoke: (ev, ...args) => {
      const h = handlers.get(ev);
      if (!h) throw new Error(`no handler for ${ev}`);
      h(...args);
    },
  };
}

const fakeIo = { to: () => ({ emit: () => undefined }) } as never;

function baseDoc(): MapDocument {
  const n = 4;
  const cells = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) cells.push({ x, y, value: 0, terrain: 0, ground: 0, forest: 0, roadType: -1, roadVar: -1 });
  return { name: "t", size: n, players: 0, terrain: { size: n, cells }, objects: [], version: "S143" } as unknown as MapDocument;
}
const fakeStore = { getMap: async () => ({ doc: baseDoc() }) } as never;

const setCell = (x: number, y: number, value: number): EditOp => ({ kind: "setCell", x, y, value });
const MAP = "m1";
const CH = "ch";
const KEY = roomKey(MAP, CH);

/** Await an ack: the revert handler acks from an async IIFE, so return a promise. */
function ackP<T>(invoke: (ev: string, ...a: unknown[]) => void, ev: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => invoke(ev, payload, resolve as (r: T) => void));
}

function opAt(invoke: (ev: string, ...a: unknown[]) => void, op: EditOp, clientOpId: string): void {
  invoke("edit:op", { mapId: MAP, clientOpId, baseSeq: 0, op }, () => undefined);
}

describe("edit:revertRange", () => {
  it("rolls back ALL my ops after fromSeq when no peer touched them", async () => {
    const rooms = new RoomManager();
    const log = new EditLog();
    const snaps = new RoomSnapshots();
    const A = fakeSocket("sockA", "clientA");
    registerRoomHandlers(fakeIo, A.socket, rooms, log, fakeStore, snaps);
    A.invoke("room:join", { mapId: MAP, channel: CH, user: { name: "A" } }, () => undefined);

    opAt(A.invoke, setCell(0, 0, 5), "a1");
    opAt(A.invoke, setCell(1, 1, 7), "a2");
    expect(log.head(KEY)).toBe(2);

    const res = await ackP<{ ok: boolean; revertedCount: number; conflictAt: unknown }>(
      A.invoke, "edit:revertRange", { mapId: MAP, fromSeq: 0 },
    );
    expect(res.ok).toBe(true);
    expect(res.revertedCount).toBe(2);
    expect(res.conflictAt).toBeNull();
    // the revert appended a forward batch (log grew, never rewound) and restored both cells
    expect(log.head(KEY)).toBeGreaterThan(2);
    const { doc } = snaps.materialize(KEY, baseDoc(), log);
    expect(doc.terrain.cells[0]!.value).toBe(0); // (0,0) reverted
    expect(doc.terrain.cells[5]!.value).toBe(0); // (1,1) reverted
  });

  it("STOPS at a peer's edit — reverts only up to the conflict, keeps the peer's value", async () => {
    const rooms = new RoomManager();
    const log = new EditLog();
    const snaps = new RoomSnapshots();
    const A = fakeSocket("sockA", "clientA");
    const B = fakeSocket("sockB", "clientB");
    registerRoomHandlers(fakeIo, A.socket, rooms, log, fakeStore, snaps);
    registerRoomHandlers(fakeIo, B.socket, rooms, log, fakeStore, snaps);
    A.invoke("room:join", { mapId: MAP, channel: CH, user: { name: "A" } }, () => undefined);
    B.invoke("room:join", { mapId: MAP, channel: CH, user: { name: "B" } }, () => undefined);

    opAt(A.invoke, setCell(0, 0, 5), "a1"); // seq 1: mine on (0,0)
    opAt(B.invoke, setCell(0, 0, 9), "b1"); // seq 2: PEER overwrites (0,0)
    opAt(A.invoke, setCell(2, 2, 3), "a2"); // seq 3: mine on (2,2), peer-free
    expect(log.head(KEY)).toBe(3);

    const res = await ackP<{ ok: boolean; revertedCount: number; conflictAt: { seq: number; keys: string[] } | null }>(
      A.invoke, "edit:revertRange", { mapId: MAP, fromSeq: 0 },
    );
    expect(res.ok).toBe(true);
    expect(res.revertedCount).toBe(1); // only my (2,2); stopped at the (0,0) conflict
    expect(res.conflictAt).toEqual({ seq: 1, keys: ["0,0"] });

    const { doc } = snaps.materialize(KEY, baseDoc(), log);
    expect(doc.terrain.cells[10]!.value).toBe(0); // (2,2) reverted (mine, peer-free)
    expect(doc.terrain.cells[0]!.value).toBe(9);  // (0,0) KEPT — the peer's edit survives
  });
});
