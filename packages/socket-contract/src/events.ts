import type { MapDocument } from "@d2/map-schema";
import type { UserPresence } from "./presence.js";
import type { EditOp, OpAck } from "./ops.js";

/** Typed socket.io events. Stage 1 implements room/presence/snapshot; `edit:op` is
 *  declared but the server replies read-only until Stage 4. Import into the typed
 *  `Server<...>` / `Socket<...>` on both client and server. */
export interface ClientToServerEvents {
  "room:join": (
    p: { mapId: string; user: { name: string; color?: string } },
    ack: (
      r:
        | { ok: true; you: UserPresence; peers: UserPresence[]; snapshotSeq: number }
        | { ok: false; error: string },
    ) => void,
  ) => void;
  "room:leave": (p: { mapId: string }) => void;

  "presence:cursor": (p: { mapId: string; cursor: UserPresence["cursor"] }) => void;
  "presence:viewport": (p: { mapId: string; viewport: UserPresence["viewport"] }) => void;
  "presence:select": (p: { mapId: string; selection: string[] }) => void;

  // Stage 4. Server returns { ok:false, reason:"read-only" } before that.
  "edit:op": (
    p: { mapId: string; clientOpId: string; baseSeq: number; op: EditOp },
    ack: (r: OpAck) => void,
  ) => void;

  "snapshot:request": (
    p: { mapId: string },
    ack: (r: { seq: number; doc: MapDocument }) => void,
  ) => void;
}

export interface ServerToClientEvents {
  "room:peers": (p: { peers: UserPresence[] }) => void;
  "presence:update": (p: UserPresence) => void;
  "presence:left": (p: { socketId: string }) => void;

  "edit:applied": (p: { seq: number; by: string; op: EditOp }) => void;
  "edit:rejected": (p: { clientOpId: string; reason: string }) => void;

  "assets:reload": (p: { version: string }) => void;
  "map:reloaded": (p: { mapId: string; seq: number }) => void;
  "server:error": (p: { code: string; message: string }) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  userId: string;
  mapId?: string;
}

/** Event name constants (avoid stringly-typed emits in implementations). */
export const EVENTS = {
  roomJoin: "room:join",
  roomLeave: "room:leave",
  presenceCursor: "presence:cursor",
  presenceViewport: "presence:viewport",
  presenceSelect: "presence:select",
  editOp: "edit:op",
  snapshotRequest: "snapshot:request",
  roomPeers: "room:peers",
  presenceUpdate: "presence:update",
  presenceLeft: "presence:left",
  editApplied: "edit:applied",
  editRejected: "edit:rejected",
  assetsReload: "assets:reload",
  mapReloaded: "map:reloaded",
  serverError: "server:error",
} as const;
