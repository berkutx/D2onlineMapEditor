/**
 * socket.io server setup. Builds a typed `Server<...>` attached to the Fastify
 * HTTP server, assigns each connection a userId, and wires the room/presence
 * handlers. Behavior is gated read-only for Stage 1 (see handlers.room.ts).
 */

import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
} from "@d2/socket-contract";
import { RoomManager } from "./RoomManager.js";
import { registerRoomHandlers } from "./handlers.room.js";
import type { EditLog } from "./EditLog.js";
import { RoomSnapshots } from "./RoomSnapshots.js";
import { config } from "../config.js";
import type { MapStore } from "../maps/mapStore.js";

export type TypedIO = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface IoBundle {
  io: TypedIO;
  rooms: RoomManager;
  log: EditLog;
  snapshots: RoomSnapshots;
}

export function createIo(httpServer: HttpServer, store: MapStore, log: EditLog): IoBundle {
  const io: TypedIO = new Server(httpServer, {
    // Namespaced under the deploy base in prod ("/map/socket.io"); default in dev. The tunnel
    // forwards /map/* unchanged, so the path must carry the prefix (rewriteUrl does not touch
    // socket.io, which intercepts upgrades before Fastify routing).
    path: `${config.BASE_PATH}/socket.io`,
    cors: { origin: true, methods: ["GET", "POST"] },
    // snapshot replies can carry a full applied MapDocument (multi-MB for a 72×72 map).
    maxHttpBufferSize: 8 * 1024 * 1024,
  });

  const rooms = new RoomManager();
  // `log` is shared with the REST layer (the export-at route reads the same durable op-log).
  // materialised-document cache so catch-up folds only the tail, not the whole log; persisted
  // to ROOMS_DIR so a restart seeds from the newest snapshot instead of re-folding 90k ops.
  const snapshots = new RoomSnapshots(config.ROOMS_DIR);

  io.on("connection", (socket) => {
    socket.data.userId = randomUUID();
    // persistent anonymous browser identity (v0.2) — optional, for future attribution
    const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
    socket.data.clientId = typeof auth.clientId === "string" ? auth.clientId.slice(0, 128) : undefined;
    registerRoomHandlers(io, socket, rooms, log, store, snapshots);
  });

  return { io, rooms, log, snapshots };
}
