import type { MapDocument } from "@d2/map-schema";
import type { UserPresence } from "./presence.js";
import type { EditOp, OpAck } from "./ops.js";

/** Typed socket.io events. Stage 1 implements room/presence/snapshot; `edit:op` is
 *  declared but the server replies read-only until Stage 4. Import into the typed
 *  `Server<...>` / `Socket<...>` on both client and server. */
export interface ClientToServerEvents {
  "room:join": (
    p: {
      mapId: string;
      /**
       * Collab channel (additive, v0.2): the room key becomes `mapId#channel`, so two
       * visitors of the same map share edits ONLY when they share the channel. The client
       * sends its own persistent channel by default (private room) or the `?room=` value
       * from a share link. Absent -> legacy global per-map room.
       */
      channel?: string;
      user: { name: string; color?: string };
    },
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
  // `batchId` (additive, v0.5): ops of ONE commit (a brush stroke, a Copilot generation)
  // share a batch id so receivers collapse them into a SINGLE history row / undo unit
  // instead of one per changed tile. Absent -> a standalone op (its own row).
  "edit:op": (
    p: { mapId: string; clientOpId: string; baseSeq: number; op: EditOp; batchId?: string },
    ack: (r: OpAck) => void,
  ) => void;

  /**
   * BATCHED op transfer (additive, v0.6): a whole commit — a brush stroke or a Copilot
   * generation with THOUSANDS of setCell ops — is sent as ONE message instead of one
   * `edit:op` per tile (which lagged the client and flooded the log). The server appends
   * them all under one `batchId` (each still gets its own seq for LWW) and re-broadcasts
   * ONE `edit:opsApplied` to the room. Empty/oversized batches are rejected.
   */
  "edit:ops": (
    p: { mapId: string; batchId: string; baseSeq: number; ops: { clientOpId: string; op: EditOp }[] },
    ack: (
      r: { ok: true; seqStart: number; seqEnd: number } | { ok: false; reason: string },
    ) => void,
  ) => void;

  "snapshot:request": (
    p: { mapId: string },
    ack: (r: { seq: number; doc: MapDocument }) => void,
  ) => void;

  /**
   * Reconnect catch-up (additive, v0.3): the room-log entries STRICTLY AFTER `afterSeq`.
   * A reconnecting client must NOT take a full snapshot — its journal already holds every
   * op it saw, so rebasing on a snapshot double-applies them (addObject/deleteObject throw).
   * Replaying only the missed tail (the client skips its own ops by clientOpId) is exact.
   */
  "ops:since": (
    p: { mapId: string; afterSeq: number },
    ack: (r: {
      ok: boolean;
      /** current log head (authoritative seq to resume from) */
      seq: number;
      /** `author` (additive, v0.7): the DURABLE clientId of each op's author (falls back to
       *  the socket id) — stable across reconnects, for per-user attribution / rollback. */
      entries: { seq: number; by: string; author?: string; clientOpId: string; op: EditOp; batchId?: string }[];
    }) => void,
  ) => void;
}

export interface ServerToClientEvents {
  "room:peers": (p: { peers: UserPresence[] }) => void;
  "presence:update": (p: UserPresence) => void;
  "presence:left": (p: { socketId: string }) => void;

  /** v0.4: carries the author's `clientOpId` (= the op's stable uid, persisted in the
   *  author's journal) so receivers sharing that journal (a second tab of the same
   *  browser) can skip ops they already hold instead of double-applying them.
   *  v0.7: `author` = the DURABLE clientId (falls back to `by`) for per-user rollback. */
  "edit:applied": (p: { seq: number; by: string; author?: string; clientOpId: string; op: EditOp; batchId?: string }) => void;
  /** Broadcast of a whole batched commit (see `edit:ops`): the receiver applies every op and
   *  records ONE history row keyed by `batchId`. */
  "edit:opsApplied": (p: {
    batchId: string;
    by: string;
    /** v0.7: durable clientId author (falls back to `by`). */
    author?: string;
    ops: { seq: number; clientOpId: string; op: EditOp }[];
  }) => void;
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
  /** Persistent anonymous browser identity from the socket auth payload (v0.2, optional). */
  clientId?: string;
  /** The composite room key (`mapId#channel`) this socket joined (v0.2, optional). */
  roomKey?: string;
}

/** Event name constants (avoid stringly-typed emits in implementations). */
export const EVENTS = {
  roomJoin: "room:join",
  roomLeave: "room:leave",
  presenceCursor: "presence:cursor",
  presenceViewport: "presence:viewport",
  presenceSelect: "presence:select",
  editOp: "edit:op",
  editOps: "edit:ops",
  snapshotRequest: "snapshot:request",
  opsSince: "ops:since",
  roomPeers: "room:peers",
  presenceUpdate: "presence:update",
  presenceLeft: "presence:left",
  editApplied: "edit:applied",
  editOpsApplied: "edit:opsApplied",
  editRejected: "edit:rejected",
  assetsReload: "assets:reload",
  mapReloaded: "map:reloaded",
  serverError: "server:error",
} as const;
