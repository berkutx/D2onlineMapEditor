/**
 * Typed socket.io client singleton. Same-origin: in dev the Vite server proxies
 * `/socket.io` (ws:true) to the Fastify backend, so no host/port is needed here.
 *
 * One connection per tab; the collab store joins/leaves rooms over it as the open map
 * changes. Lazily created so a user who never edits collaboratively pays nothing.
 */

import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@d2/socket-contract";

export type TypedClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: TypedClientSocket | null = null;

// Namespace the socket.io endpoint under the deploy base ('/' in dev, '/map/' in prod) so it
// resolves to OUR container behind the tunnel (the existing site owns the root /socket.io).
const SOCKET_PATH = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/socket.io`;

export function getSocket(): TypedClientSocket {
  if (!socket) {
    socket = io({
      path: SOCKET_PATH,
      autoConnect: true,
      transports: ["websocket", "polling"],
      // a dropped connection should re-establish and the collab store will re-join + resync
      reconnection: true,
      reconnectionDelay: 500,
    });
  }
  return socket;
}
