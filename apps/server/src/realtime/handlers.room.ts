/**
 * Per-socket room + presence + edit handlers.
 *
 *  - room:join / room:leave manage membership and broadcast peer lists; the join ack
 *    carries the current log head (snapshotSeq) so a late joiner can sync.
 *  - presence:cursor / viewport / select are throttled (~20Hz) per socket and
 *    broadcast to the rest of the room.
 *  - edit:op validates + appends to the server-authoritative EditLog (assigning a seq),
 *    acks { ok, seq } to the author, and broadcasts edit:applied to the rest of the room.
 *  - snapshot:request returns the base map + the whole log applied (catch-up / late join).
 *
 * Privacy (v0.2): rooms + the EditLog are keyed by roomKey(mapId, channel) — the client's
 * own persistent channel by default (a PRIVATE per-visitor room), or the channel from a
 * share link (?map=<id>&room=<channel>), so edits are shared only with invited peers.
 * The snapshot base is still resolved by the bare mapId (the map file is the same).
 */

import type { Server, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
  UserPresence,
} from "@d2/socket-contract";
import { EditOp } from "@d2/socket-contract";
import { applyOps } from "@d2/map-edit";
import type { MapStore } from "../maps/mapStore.js";
import { RoomManager, roomId, roomKey } from "./RoomManager.js";
import type { EditLog } from "./EditLog.js";

type IO = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
type IOSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/** ~20Hz presence throttle. */
const PRESENCE_INTERVAL_MS = 50;

interface Throttle {
  cursor: number;
  viewport: number;
  select: number;
}

export function registerRoomHandlers(
  io: IO,
  socket: IOSocket,
  rooms: RoomManager,
  log: EditLog,
  store: MapStore,
): void {
  const last: Throttle = { cursor: 0, viewport: 0, select: 0 };

  const throttled = (key: keyof Throttle): boolean => {
    const now = Date.now();
    if (now - last[key] < PRESENCE_INTERVAL_MS) return true;
    last[key] = now;
    return false;
  };

  /** The joined room key for a payload that names this socket's current map; null if the
   *  payload targets a map this socket has not joined (drop it — no cross-room leaks). */
  const keyFor = (mapId: string): string | null =>
    socket.data.mapId === mapId && socket.data.roomKey ? socket.data.roomKey : null;

  socket.on("room:join", (p, ack) => {
    try {
      if (!p || typeof p.mapId !== "string" || !p.user?.name) {
        ack({ ok: false, error: "invalid room:join payload" });
        return;
      }
      const channel = typeof p.channel === "string" && p.channel ? p.channel.slice(0, 128) : undefined;
      const key = roomKey(p.mapId, channel);
      const presence = rooms.join(
        key,
        socket.id,
        socket.data.userId,
        p.user.name,
        p.user.color,
      );
      socket.data.mapId = p.mapId;
      socket.data.roomKey = key;
      void socket.join(roomId(key));

      const peers = rooms.peers(key, socket.id);
      // tell existing peers about the newcomer
      socket.to(roomId(key)).emit("presence:update", presence);

      // late joiner gets the current head; if >0 they should snapshot:request to catch up
      ack({ ok: true, you: presence, peers, snapshotSeq: log.head(key) });
    } catch (err) {
      ack({ ok: false, error: (err as Error).message });
    }
  });

  socket.on("room:leave", (p) => {
    if (!p || typeof p.mapId !== "string") return;
    const key = keyFor(p.mapId);
    if (key) handleLeave(io, socket, rooms, key);
  });

  socket.on("presence:cursor", (p) => {
    if (!p || typeof p.mapId !== "string") return;
    if (throttled("cursor")) return;
    const key = keyFor(p.mapId);
    if (!key) return;
    const updated = rooms.update(key, socket.id, { cursor: p.cursor });
    if (updated) broadcastPresence(socket, key, updated);
  });

  socket.on("presence:viewport", (p) => {
    if (!p || typeof p.mapId !== "string") return;
    if (throttled("viewport")) return;
    const key = keyFor(p.mapId);
    if (!key) return;
    const updated = rooms.update(key, socket.id, { viewport: p.viewport });
    if (updated) broadcastPresence(socket, key, updated);
  });

  socket.on("presence:select", (p) => {
    if (!p || typeof p.mapId !== "string") return;
    if (throttled("select")) return;
    const key = keyFor(p.mapId);
    if (!key) return;
    const updated = rooms.update(key, socket.id, { selection: p.selection });
    if (updated) broadcastPresence(socket, key, updated);
  });

  // Apply a peer's op: validate, append to the authoritative log (assigns seq), ack the
  // author with the seq, and broadcast edit:applied to the rest of the room. LWW is implicit
  // in the single ordered log — every client applies the broadcast stream in seq order.
  socket.on("edit:op", (p, ack) => {
    if (!p || typeof p.mapId !== "string" || typeof p.clientOpId !== "string") {
      ack({ ok: false, reason: "invalid edit:op payload" });
      return;
    }
    const key = keyFor(p.mapId);
    if (!key) {
      ack({ ok: false, reason: "not joined to this map's room" });
      return;
    }
    const parsed = EditOp.safeParse(p.op);
    if (!parsed.success) {
      ack({ ok: false, reason: "invalid op: " + parsed.error.issues[0]?.message });
      return;
    }
    const entry = log.append(key, parsed.data, socket.id, p.clientOpId, Date.now(), p.batchId);
    ack({ ok: true, seq: entry.seq });
    socket
      .to(roomId(key))
      .emit("edit:applied", { seq: entry.seq, by: socket.id, clientOpId: p.clientOpId, op: parsed.data, batchId: p.batchId });
  });

  // Catch-up: return the base map with the entire log applied, plus the head seq, so a late
  // joiner (or a client that fell behind) can resync to the authoritative shared state.
  socket.on("snapshot:request", (p, ack) => {
    void (async () => {
      const key = keyFor(p.mapId) ?? p.mapId;
      try {
        const loaded = await store.getMap(p.mapId);
        if (!loaded) {
          ack({ seq: log.head(key), doc: { name: "", size: 0, players: 0, terrain: [], objects: [] } as never });
          return;
        }
        const ops = log.all(key).map((e) => e.op);
        ack({ seq: log.head(key), doc: applyOps(loaded.doc, ops) });
      } catch {
        ack({ seq: log.head(key), doc: { name: "", size: 0, players: 0, terrain: [], objects: [] } as never });
      }
    })();
  });

  // Reconnect catch-up: entries STRICTLY AFTER afterSeq. A reconnecting client keeps its
  // journal (it already holds every op it saw) and replays only this missed tail — a full
  // snapshot would double-apply those ops client-side (addObject/deleteObject throw).
  socket.on("ops:since", (p, ack) => {
    if (!p || typeof p.mapId !== "string" || typeof p.afterSeq !== "number") {
      ack({ ok: false, seq: 0, entries: [] });
      return;
    }
    const key = keyFor(p.mapId);
    if (!key) {
      ack({ ok: false, seq: 0, entries: [] });
      return;
    }
    const entries = log
      .since(key, p.afterSeq)
      .map((e) => ({ seq: e.seq, by: e.by, clientOpId: e.clientOpId, op: e.op, batchId: e.batchId }));
    ack({ ok: true, seq: log.head(key), entries });
  });

  socket.on("disconnect", () => {
    for (const key of rooms.roomsForSocket(socket.id)) {
      handleLeave(io, socket, rooms, key);
    }
  });
}

function broadcastPresence(
  socket: IOSocket,
  key: string,
  presence: UserPresence,
): void {
  socket.to(roomId(key)).emit("presence:update", presence);
}

function handleLeave(
  _io: IO,
  socket: IOSocket,
  rooms: RoomManager,
  key: string,
): void {
  const left = rooms.leave(key, socket.id);
  if (left) {
    socket.to(roomId(key)).emit("presence:left", { socketId: socket.id });
  }
  void socket.leave(roomId(key));
  if (socket.data.roomKey === key) {
    socket.data.roomKey = undefined;
    socket.data.mapId = undefined;
  }
}
