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
import { applyOps, diffDocs, opKeys } from "@d2/map-edit";
import type { MapStore } from "../maps/mapStore.js";
import { RoomManager, roomId, roomKey } from "./RoomManager.js";
import type { EditLog } from "./EditLog.js";
import type { RoomSnapshots } from "./RoomSnapshots.js";

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
  snapshots?: RoomSnapshots,
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

  /** Run `fn` once the room's durable log is in memory — SYNCHRONOUSLY on the fast path
   *  (no dataDir, or already loaded) so the handler acks in the same tick; else after the
   *  one-time async disk load. Only the first touch of a room after a restart is async. */
  const withRoom = (key: string, fn: () => void): void => {
    if (log.needsLoad(key)) {
      void log.ensureLoaded(key).then(fn).catch((e) => console.error("[room] load failed:", (e as Error).message));
    } else {
      fn();
    }
  };

  socket.on("room:join", (p, ack) => {
    if (!p || typeof p.mapId !== "string" || !p.user?.name) {
      ack({ ok: false, error: "invalid room:join payload" });
      return;
    }
    const channel = typeof p.channel === "string" && p.channel ? p.channel.slice(0, 128) : undefined;
    const key = roomKey(p.mapId, channel);
    // load the durable log BEFORE reading head, so a late joiner after a server restart
    // sees the persisted head (>0) and catches up instead of re-seeding its whole journal.
    // The body runs after that one-time async load, so its try/catch + connected-guard live
    // INSIDE the deferred fn (an error here must still ack, not hang the client).
    withRoom(key, () => {
      try {
        // the socket may have disconnected DURING the async disk load — leave/disconnect
        // already ran (before rooms.join), so joining now would leak a permanent ghost peer.
        if (socket.disconnected) return;
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
    withRoom(key, () => {
      const author = socket.data.clientId ?? socket.id;
      const entry = log.append(key, parsed.data, socket.id, p.clientOpId, Date.now(), p.batchId, author);
      ack({ ok: true, seq: entry.seq });
      socket
        .to(roomId(key))
        .emit("edit:applied", { seq: entry.seq, by: socket.id, author, clientOpId: p.clientOpId, op: parsed.data, batchId: p.batchId });
    });
  });

  // BATCHED apply: a whole commit (brush stroke / Copilot generation, up to thousands of
  // setCell ops) arrives as ONE message — append them all under one batchId, ack the seq
  // range, and re-broadcast ONE edit:opsApplied. Fixes the per-tile flood/lag.
  const MAX_BATCH = 50_000;
  socket.on("edit:ops", (p, ack) => {
    if (!p || typeof p.mapId !== "string" || typeof p.batchId !== "string" || !Array.isArray(p.ops)) {
      ack({ ok: false, reason: "invalid edit:ops payload" });
      return;
    }
    const key = keyFor(p.mapId);
    if (!key) {
      ack({ ok: false, reason: "not joined to this map's room" });
      return;
    }
    if (p.ops.length === 0) {
      ack({ ok: false, reason: "empty batch" });
      return;
    }
    if (p.ops.length > MAX_BATCH) {
      ack({ ok: false, reason: `batch too large (${p.ops.length} > ${MAX_BATCH})` });
      return;
    }
    const validated: { clientOpId: string; op: EditOp }[] = [];
    for (const item of p.ops) {
      const parsed = EditOp.safeParse(item?.op);
      if (!parsed.success) {
        ack({ ok: false, reason: "invalid op in batch: " + parsed.error.issues[0]?.message });
        return;
      }
      validated.push({ clientOpId: String(item?.clientOpId ?? ""), op: parsed.data });
    }
    withRoom(key, () => {
      const author = socket.data.clientId ?? socket.id;
      const entries = log.appendBatch(key, validated, socket.id, p.batchId, Date.now(), author);
      ack({ ok: true, seqStart: entries[0]!.seq, seqEnd: entries[entries.length - 1]!.seq });
      socket.to(roomId(key)).emit("edit:opsApplied", {
        batchId: p.batchId,
        by: socket.id,
        author,
        ops: entries.map((e) => ({ seq: e.seq, clientOpId: e.clientOpId, op: e.op })),
      });
    });
  });

  // Catch-up: return the base map with the entire log applied, plus the head seq, so a late
  // joiner (or a client that fell behind) can resync to the authoritative shared state.
  socket.on("snapshot:request", (p, ack) => {
    void (async () => {
      const key = keyFor(p.mapId) ?? p.mapId;
      try {
        await log.ensureLoaded(key);
        const loaded = await store.getMap(p.mapId);
        if (!loaded) {
          ack({ seq: log.head(key), doc: { name: "", size: 0, players: 0, terrain: [], objects: [] } as never });
          return;
        }
        // materialise the HEAD doc via the cache (folds only the tail since the last snapshot),
        // falling back to a full fold when no cache is wired (unit tests).
        if (snapshots) {
          const snap = snapshots.materialize(key, loaded.doc, log);
          ack({ seq: snap.seq, doc: snap.doc });
        } else {
          const ops = log.all(key).map((e) => e.op);
          ack({ seq: log.head(key), doc: applyOps(loaded.doc, ops) });
        }
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
    withRoom(key, () => {
      const entries = log
        .since(key, p.afterSeq)
        .map((e) => ({ seq: e.seq, by: e.by, author: e.author, clientOpId: e.clientOpId, op: e.op, batchId: e.batchId }));
      ack({ ok: true, seq: log.head(key), entries });
    });
  });

  // Conflict-aware revert (M5): roll back MY ops after `fromSeq`, keeping every other author's
  // edits. Walk my ops newest→oldest and stop at the first whose cell/object a peer has since
  // touched (the conflict boundary — "откат только до конфликта"). The rollback is computed as
  // the diff from HEAD to a re-simulation WITHOUT my reverted ops, then APPENDED as a normal
  // forward batch (git revert; the log never rewinds) and broadcast to the whole room.
  socket.on("edit:revertRange", (p, ack) => {
    if (!p || typeof p.mapId !== "string" || typeof p.fromSeq !== "number") {
      ack({ ok: false, reason: "invalid edit:revertRange payload" });
      return;
    }
    const key = keyFor(p.mapId);
    if (!key) {
      ack({ ok: false, reason: "not joined to this map's room" });
      return;
    }
    const me = socket.data.clientId ?? socket.id;
    withRoom(key, () => {
      void (async () => {
        try {
          const loaded = await store.getMap(p.mapId);
          if (!loaded) {
            ack({ ok: false, reason: "map not found" });
            return;
          }
          const all = log.all(key);
          // keys any OTHER author wrote after fromSeq — reverting one of mine on such a key
          // would clobber their live edit (a conflict).
          const peerKeys = new Set<string>();
          for (const e of all) {
            if (e.seq > p.fromSeq && e.author !== me) for (const k of opKeys(e.op)) peerKeys.add(k);
          }
          // Revert every one of MY ops after fromSeq whose cell/object NO peer has touched
          // since; SKIP (keep) the ones a peer edited — those are the conflict boundary. Walk
          // newest→oldest so `conflictAt` reports the most recent blocked op. Skipping rather
          // than stopping dead means one recent conflict does not block reverting older,
          // independent edits (they touch different cells/objects, so the target stays
          // consistent — every reverted key is fully mine).
          const mine = all.filter((e) => e.seq > p.fromSeq && e.author === me).sort((a, b) => b.seq - a.seq);
          const revertSeqs = new Set<number>();
          let conflictAt: { seq: number; keys: string[] } | null = null;
          for (const e of mine) {
            const clash = opKeys(e.op).filter((k) => peerKeys.has(k));
            if (clash.length) {
              if (!conflictAt) conflictAt = { seq: e.seq, keys: clash }; // report the newest conflict
              continue; // keep this peer-touched op; roll back the others
            }
            revertSeqs.add(e.seq);
          }
          if (revertSeqs.size === 0) {
            ack({ ok: true, revertedCount: 0, conflictAt });
            return;
          }
          // target = the map with MY reverted ops removed (everyone else's kept); the revert is
          // diffDocs(HEAD, target) — minimal and only on the (peer-free) reverted keys.
          const keepOps = all.filter((e) => !revertSeqs.has(e.seq)).map((e) => e.op);
          const target = applyOps(loaded.doc, keepOps);
          const headDoc = snapshots
            ? snapshots.materialize(key, loaded.doc, log).doc
            : applyOps(loaded.doc, all.map((e) => e.op));
          const revertOps = diffDocs(headDoc, target);
          if (revertOps.length === 0) {
            ack({ ok: true, revertedCount: revertSeqs.size, conflictAt });
            return;
          }
          const batchId = `revert:${me}:${log.head(key)}`;
          const withIds = revertOps.map((op, i) => ({ clientOpId: `${batchId}:${i}`, op }));
          const entries = log.appendBatch(key, withIds, socket.id, batchId, Date.now(), me);
          ack({ ok: true, revertedCount: revertSeqs.size, conflictAt });
          // broadcast to the WHOLE room INCLUDING the author — the revert is server-computed,
          // so the author applies it via edit:opsApplied like any incoming batch.
          io.to(roomId(key)).emit("edit:opsApplied", {
            batchId,
            by: socket.id,
            author: me,
            ops: entries.map((e) => ({ seq: e.seq, clientOpId: e.clientOpId, op: e.op })),
          });
        } catch (err) {
          ack({ ok: false, reason: (err as Error).message });
        }
      })();
    });
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
