/**
 * Reconnect catch-up (`ops:since`, Contract C v0.3): a reconnecting client keeps its
 * journal and replays ONLY the ops it missed — a full snapshot would double-apply the
 * ops it already holds (addObject/deleteObject throw). Handler-level test with a fake
 * socket: join → 3 ops → ops:since(afterSeq) returns exactly the tail with clientOpIds
 * (so the client can skip its own).
 */

import { describe, it, expect } from "vitest";
import type { EditOp } from "@d2/socket-contract";
import { registerRoomHandlers } from "../src/realtime/handlers.room";
import { RoomManager } from "../src/realtime/RoomManager";
import { EditLog } from "../src/realtime/EditLog";

type Handler = (...args: unknown[]) => void;

function fakeSocket(id: string): {
  socket: never;
  invoke: (ev: string, ...args: unknown[]) => void;
} {
  const handlers = new Map<string, Handler>();
  const sink = { emit: () => undefined };
  const socket = {
    id,
    data: { userId: `u-${id}` },
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
const fakeStore = {} as never;

const setCell = (x: number, v: number): EditOp => ({ kind: "setCell", x, y: 0, value: v });

describe("ops:since — reconnect catch-up", () => {
  it("returns exactly the entries after afterSeq, with clientOpIds for self-filtering", () => {
    const rooms = new RoomManager();
    const log = new EditLog();
    const { socket, invoke } = fakeSocket("sockA");
    registerRoomHandlers(fakeIo, socket, rooms, log, fakeStore);

    let joined = false;
    invoke("room:join", { mapId: "m1", channel: "ch", user: { name: "Тест" } }, (r: { ok: boolean }) => {
      joined = r.ok;
    });
    expect(joined).toBe(true);

    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      invoke(
        "edit:op",
        { mapId: "m1", clientOpId: `sockA:${i}`, baseSeq: i, op: setCell(i, i) },
        (r: { ok: boolean; seq?: number }) => {
          expect(r.ok).toBe(true);
          seqs.push(r.seq!);
        },
      );
    }
    expect(seqs).toEqual([1, 2, 3]);

    // missed ops after seq 1 → exactly 2 and 3, clientOpIds echoed for self-filtering
    let res: { ok: boolean; seq: number; entries: { seq: number; clientOpId: string; op: EditOp }[] } | null = null;
    invoke("ops:since", { mapId: "m1", afterSeq: 1 }, (r: typeof res) => (res = r));
    expect(res!.ok).toBe(true);
    expect(res!.seq).toBe(3);
    expect(res!.entries.map((e) => e.seq)).toEqual([2, 3]);
    expect(res!.entries.map((e) => e.clientOpId)).toEqual(["sockA:1", "sockA:2"]);
    expect(res!.entries[0]!.op).toEqual(setCell(1, 1));

    // nothing missed → empty tail
    invoke("ops:since", { mapId: "m1", afterSeq: 3 }, (r: typeof res) => (res = r));
    expect(res!.ok).toBe(true);
    expect(res!.entries).toHaveLength(0);
  });

  it("refuses maps this socket has not joined (no cross-room leaks)", () => {
    const rooms = new RoomManager();
    const log = new EditLog();
    const { socket, invoke } = fakeSocket("sockB");
    registerRoomHandlers(fakeIo, socket, rooms, log, fakeStore);

    let res: { ok: boolean } | null = null;
    invoke("ops:since", { mapId: "not-joined", afterSeq: 0 }, (r: { ok: boolean }) => (res = r));
    expect(res!.ok).toBe(false);

    invoke("ops:since", { mapId: 42, afterSeq: "x" }, (r: { ok: boolean }) => (res = r));
    expect(res!.ok).toBe(false);
  });
});
