/**
 * Collab id slots (M4, Contract C v0.8): the room hands each socket a DISTINCT slot ∈ [0,16),
 * so clients mint object ids in disjoint bands and concurrent placements never collide. This
 * covers RoomManager slot bookkeeping (distinct per member, freed + reused on leave) and the
 * wiring that surfaces the slot in the room:join ack.
 */

import { describe, it, expect } from "vitest";
import { registerRoomHandlers } from "../src/realtime/handlers.room";
import { RoomManager } from "../src/realtime/RoomManager";
import { EditLog } from "../src/realtime/EditLog";
import { ID_SLOTS } from "@d2/map-edit";

type Handler = (...args: unknown[]) => void;

function fakeSocket(id: string): { socket: never; invoke: (ev: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, Handler>();
  const sink = { emit: () => undefined };
  const socket = {
    id,
    data: { userId: `u-${id}` },
    disconnected: false,
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

describe("RoomManager id slots", () => {
  it("assigns the smallest free slot per member and keeps them distinct", () => {
    const rooms = new RoomManager();
    rooms.join("r1", "a", "ua", "A");
    rooms.join("r1", "b", "ub", "B");
    rooms.join("r1", "c", "uc", "C");
    expect(rooms.slotOf("r1", "a")).toBe(0);
    expect(rooms.slotOf("r1", "b")).toBe(1);
    expect(rooms.slotOf("r1", "c")).toBe(2);
  });

  it("frees a slot on leave and reuses the lowest free one", () => {
    const rooms = new RoomManager();
    rooms.join("r1", "a", "ua", "A"); // slot 0
    rooms.join("r1", "b", "ub", "B"); // slot 1
    rooms.leave("r1", "a"); // frees 0
    rooms.join("r1", "c", "uc", "C"); // should reuse 0, not take 2
    expect(rooms.slotOf("r1", "c")).toBe(0);
    expect(rooms.slotOf("r1", "b")).toBe(1);
  });

  it("slots are per-room (same socket id in two rooms gets each room's slot 0)", () => {
    const rooms = new RoomManager();
    rooms.join("r1", "a", "ua", "A");
    rooms.join("r2", "a", "ua", "A");
    expect(rooms.slotOf("r1", "a")).toBe(0);
    expect(rooms.slotOf("r2", "a")).toBe(0);
  });

  it("a full room (>ID_SLOTS members) degrades to slot 0, never crashes", () => {
    const rooms = new RoomManager();
    for (let i = 0; i < ID_SLOTS; i++) rooms.join("r1", `s${i}`, `u${i}`, `S${i}`);
    rooms.join("r1", "overflow", "uo", "O");
    expect(rooms.slotOf("r1", "overflow")).toBe(0); // fallback, not undefined/NaN
  });

  it("room:join ack carries this socket's slot", () => {
    const rooms = new RoomManager();
    const log = new EditLog();
    const a = fakeSocket("sockA");
    const b = fakeSocket("sockB");
    registerRoomHandlers(fakeIo, a.socket, rooms, log, fakeStore);
    registerRoomHandlers(fakeIo, b.socket, rooms, log, fakeStore);

    let slotA: number | undefined;
    let slotB: number | undefined;
    a.invoke("room:join", { mapId: "m1", channel: "ch", user: { name: "A" } }, (r: { ok: boolean; slot?: number }) => {
      expect(r.ok).toBe(true);
      slotA = r.slot;
    });
    b.invoke("room:join", { mapId: "m1", channel: "ch", user: { name: "B" } }, (r: { ok: boolean; slot?: number }) => {
      expect(r.ok).toBe(true);
      slotB = r.slot;
    });
    expect(slotA).toBe(0);
    expect(slotB).toBe(1);
    expect(slotA).not.toBe(slotB);
  });
});
