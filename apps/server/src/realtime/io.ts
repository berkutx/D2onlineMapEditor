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

export type TypedIO = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface IoBundle {
  io: TypedIO;
  rooms: RoomManager;
}

export function createIo(httpServer: HttpServer): IoBundle {
  const io: TypedIO = new Server(httpServer, {
    cors: { origin: true, methods: ["GET", "POST"] },
    // Stage 1 docs are small; allow generous buffer for snapshot replies later.
    maxHttpBufferSize: 8 * 1024 * 1024,
  });

  const rooms = new RoomManager();

  io.on("connection", (socket) => {
    socket.data.userId = randomUUID();
    registerRoomHandlers(io, socket, rooms);
  });

  return { io, rooms };
}
