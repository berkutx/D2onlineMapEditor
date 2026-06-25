/**
 * Per-socket room + presence + edit handlers.
 *
 * Stage 1 behavior:
 *  - room:join / room:leave manage membership and broadcast peer lists.
 *  - presence:cursor / viewport / select are throttled (~20Hz) per socket and
 *    broadcast to the rest of the room.
 *  - edit:op immediately acks { ok:false, reason:"read-only" } and emits nothing.
 *
 * The wiring (rooms, broadcasts, snapshotSeq) is final; Stage 4 only swaps the
 * edit:op body for a real apply path.
 */

import type { Server, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
  UserPresence,
} from "@d2/socket-contract";
import { RoomManager, roomId } from "./RoomManager.js";

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

      ack({ ok: true, you: presence, peers, snapshotSeq: 0 });
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

  // Stage 1: edits are rejected read-only. No state mutates, nothing is emitted.
  socket.on("edit:op", (_p, ack) => {
    ack({ ok: false, reason: "read-only" });
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
