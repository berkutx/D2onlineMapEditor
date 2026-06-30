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
import { RoomManager, roomId } from "./RoomManager.js";
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

  socket.on("room:join", (p, ack) => {
    try {
      if (!p || typeof p.mapId !== "string" || !p.user?.name) {
        ack({ ok: false, error: "invalid room:join payload" });
        return;
      }
      const presence = rooms.join(
        p.mapId,
        socket.id,
        socket.data.userId,
        p.user.name,
        p.user.color,
      );
      socket.data.mapId = p.mapId;
      void socket.join(roomId(p.mapId));

      const peers = rooms.peers(p.mapId, socket.id);
      // tell existing peers about the newcomer
      socket.to(roomId(p.mapId)).emit("presence:update", presence);

      // late joiner gets the current head; if >0 they should snapshot:request to catch up
      ack({ ok: true, you: presence, peers, snapshotSeq: log.head(p.mapId) });
    } catch (err) {
      ack({ ok: false, error: (err as Error).message });
    }
  });

  socket.on("room:leave", (p) => {
    if (!p || typeof p.mapId !== "string") return;
    handleLeave(io, socket, rooms, p.mapId);
  });

  socket.on("presence:cursor", (p) => {
    if (!p || typeof p.mapId !== "string") return;
    if (throttled("cursor")) return;
    const updated = rooms.update(p.mapId, socket.id, { cursor: p.cursor });
    if (updated) broadcastPresence(socket, p.mapId, updated);
  });

  socket.on("presence:viewport", (p) => {
    if (!p || typeof p.mapId !== "string") return;
    if (throttled("viewport")) return;
    const updated = rooms.update(p.mapId, socket.id, { viewport: p.viewport });
    if (updated) broadcastPresence(socket, p.mapId, updated);
  });

  socket.on("presence:select", (p) => {
    if (!p || typeof p.mapId !== "string") return;
    if (throttled("select")) return;
    const updated = rooms.update(p.mapId, socket.id, { selection: p.selection });
    if (updated) broadcastPresence(socket, p.mapId, updated);
  });

  // Apply a peer's op: validate, append to the authoritative log (assigns seq), ack the
  // author with the seq, and broadcast edit:applied to the rest of the room. LWW is implicit
  // in the single ordered log — every client applies the broadcast stream in seq order.
  socket.on("edit:op", (p, ack) => {
    if (!p || typeof p.mapId !== "string" || typeof p.clientOpId !== "string") {
      ack({ ok: false, reason: "invalid edit:op payload" });
      return;
    }
    if (socket.data.mapId !== p.mapId) {
      ack({ ok: false, reason: "not joined to this map's room" });
      return;
    }
    const parsed = EditOp.safeParse(p.op);
    if (!parsed.success) {
      ack({ ok: false, reason: "invalid op: " + parsed.error.issues[0]?.message });
      return;
    }
    const entry = log.append(p.mapId, parsed.data, socket.id, p.clientOpId, Date.now());
    ack({ ok: true, seq: entry.seq });
    socket
      .to(roomId(p.mapId))
      .emit("edit:applied", { seq: entry.seq, by: socket.id, op: parsed.data });
  });

  // Catch-up: return the base map with the entire log applied, plus the head seq, so a late
  // joiner (or a client that fell behind) can resync to the authoritative shared state.
  socket.on("snapshot:request", (p, ack) => {
    void (async () => {
      try {
        const loaded = await store.getMap(p.mapId);
        if (!loaded) {
          ack({ seq: log.head(p.mapId), doc: { name: "", size: 0, players: 0, terrain: [], objects: [] } as never });
          return;
        }
        const ops = log.all(p.mapId).map((e) => e.op);
        ack({ seq: log.head(p.mapId), doc: applyOps(loaded.doc, ops) });
      } catch {
        ack({ seq: log.head(p.mapId), doc: { name: "", size: 0, players: 0, terrain: [], objects: [] } as never });
      }
    })();
  });

  socket.on("disconnect", () => {
    for (const mapId of rooms.roomsForSocket(socket.id)) {
      handleLeave(io, socket, rooms, mapId);
    }
  });
}

function broadcastPresence(
  socket: IOSocket,
  mapId: string,
  presence: UserPresence,
): void {
  socket.to(roomId(mapId)).emit("presence:update", presence);
}

function handleLeave(
  _io: IO,
  socket: IOSocket,
  rooms: RoomManager,
  mapId: string,
): void {
  const left = rooms.leave(mapId, socket.id);
  if (left) {
    socket.to(roomId(mapId)).emit("presence:left", { socketId: socket.id });
  }
  void socket.leave(roomId(mapId));
  if (socket.data.mapId === mapId) socket.data.mapId = undefined;
}
