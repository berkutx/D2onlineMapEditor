/**
 * Collaboration store: connects the typed socket, joins the room for the open map (room =
 * map id = share link), broadcasts my edits, and folds peers' edits into the live doc.
 *
 * Model (decided with the user): the server keeps ONE ordered EditOp log per map; every
 * client applies the broadcast stream in seq order (last-writer-wins, no OT/CRDT). My local
 * edits apply optimistically and are sent immediately; peers' arrive via `edit:applied` and
 * fold into the journal (so Export still materialises them). Undo is append-inverse
 * (editStore handles it). Presence (cursor / selection) is broadcast and rendered per peer
 * in their assigned colour. History is a shared, read-only timeline of who changed what.
 */

import { defineStore } from "pinia";
import { ref, reactive, computed } from "vue";
import type { EditOp, UserPresence } from "@d2/socket-contract";
import { getSocket } from "../realtime/socket";
import { getChannelId } from "../services/clientId";
import { useEditStore } from "./editStore";

const NAME_KEY = "d2.collab.name";

/** A shared-timeline entry (newest last): who applied which op at which seq. */
export interface HistoryEntry {
  seq: number;
  by: string; // socketId of the author
  byName: string;
  byColor: string;
  op: EditOp;
  summary: string;
  mine: boolean;
}

function randomName(): string {
  const n = Math.floor(1000 + (Date.now() % 9000));
  return `Гость-${n}`;
}

/** A short, human-readable Russian summary of an op for the history panel. */
function summarize(op: EditOp): string {
  switch (op.kind) {
    case "setCell":
      return `клетка (${op.x}, ${op.y})`;
    case "addObject":
      return `+ объект (${op.object.type})`;
    case "moveObject":
      return `⇄ объект → (${op.x}, ${op.y})`;
    case "patchObject":
      return `✎ свойства объекта`;
    case "deleteObject":
      return `✕ удалён объект`;
  }
}

export const useCollabStore = defineStore("collab", () => {
  const edit = useEditStore();

  const mapId = ref<string | null>(null);
  /** The collab channel this session is in (room = mapId#channel). Defaults to MY persistent
   *  private channel; a share link (?map=<id>&room=<channel>) puts a guest on the sharer's. */
  const channel = ref<string | null>(null);
  /** One-shot channel override parsed from a share link, consumed by the next join(). */
  let pendingShare: { mapId: string; channel: string } | null = null;
  const me = ref<UserPresence | null>(null);
  const peers = reactive(new Map<string, UserPresence>());
  const history = ref<HistoryEntry[]>([]);
  const connected = computed(() => me.value !== null);
  /** Highest seq this client has applied (its position in the shared log). */
  let lastSeq = 0;
  let opCounter = 0;
  let listenersBound = false;

  const userName = ref<string>(localStorage.getItem(NAME_KEY) || randomName());
  function setUserName(name: string): void {
    const n = name.trim() || randomName();
    userName.value = n;
    try {
      localStorage.setItem(NAME_KEY, n);
    } catch {
      /* ignore */
    }
  }

  const peerList = computed<UserPresence[]>(() => [...peers.values()]);
  /** socketId → colour, for tinting history rows + presence markers. */
  const colorOf = (socketId: string): string =>
    socketId === me.value?.socketId ? (me.value?.color ?? "#888") : peers.get(socketId)?.color ?? "#888";
  const nameOf = (socketId: string): string =>
    socketId === me.value?.socketId ? (me.value?.name ?? "я") : peers.get(socketId)?.name ?? "?";

  function record(seq: number, by: string, op: EditOp, mine: boolean): void {
    history.value = [
      ...history.value,
      { seq, by, byName: nameOf(by), byColor: colorOf(by), op, summary: summarize(op), mine },
    ];
  }

  function bindListeners(): void {
    if (listenersBound) return;
    listenersBound = true;
    const socket = getSocket();

    socket.on("edit:applied", ({ seq, by, op }) => {
      edit.applyIncoming([op]); // peer op → live doc + journal (not my undo stack)
      lastSeq = Math.max(lastSeq, seq);
      record(seq, by, op, false);
    });
    socket.on("presence:update", (p) => {
      if (p.socketId !== me.value?.socketId) peers.set(p.socketId, p);
    });
    socket.on("presence:left", ({ socketId }) => {
      peers.delete(socketId);
    });
    socket.on("room:peers", ({ peers: list }) => {
      peers.clear();
      for (const p of list) if (p.socketId !== me.value?.socketId) peers.set(p.socketId, p);
    });
    socket.on("server:error", (e) => {
      // eslint-disable-next-line no-console
      console.warn("[collab] server error", e);
    });
    // a reconnect re-joins the same room and resyncs from the snapshot
    socket.io.on("reconnect", () => {
      if (mapId.value) void doJoin(mapId.value);
    });
  }

  /** The outgoing hook editStore calls on every local commit / undo / redo. */
  function sendOps(ops: readonly EditOp[]): void {
    const id = mapId.value;
    const socket = getSocket();
    if (!id || !me.value) return;
    for (const op of ops) {
      const clientOpId = `${me.value.socketId}:${opCounter++}`;
      socket.emit("edit:op", { mapId: id, clientOpId, baseSeq: lastSeq, op }, (ack) => {
        if (ack.ok && typeof ack.seq === "number") {
          lastSeq = Math.max(lastSeq, ack.seq);
          record(ack.seq, me.value!.socketId, op, true);
        } else {
          // eslint-disable-next-line no-console
          console.warn("[collab] op rejected:", ack.reason);
        }
      });
    }
  }

  /** Adopt a share link's channel for the given map (before it is opened/joined). */
  function setPendingShare(forMapId: string, chan: string): void {
    pendingShare = { mapId: forMapId, channel: chan };
  }

  async function doJoin(id: string): Promise<void> {
    const socket = getSocket();
    bindListeners();
    // a share link's channel wins (joining the sharer's room); a reconnect reuses the
    // channel we were already in; otherwise my persistent private channel
    const chan =
      pendingShare?.mapId === id ? pendingShare.channel : channel.value ?? getChannelId();
    if (pendingShare?.mapId === id) pendingShare = null; // consume once
    channel.value = chan;
    await new Promise<void>((resolve) => {
      socket.emit("room:join", { mapId: id, channel: chan, user: { name: userName.value } }, (r) => {
        if (!r.ok) {
          // eslint-disable-next-line no-console
          console.warn("[collab] join failed:", r.error);
          resolve();
          return;
        }
        me.value = r.you;
        peers.clear();
        for (const p of r.peers) peers.set(p.socketId, p);
        lastSeq = r.snapshotSeq;
        edit.setCollab(true, sendOps);
        // catch up to the authoritative state if peers edited before we arrived
        if (r.snapshotSeq > 0) {
          socket.emit("snapshot:request", { mapId: id }, ({ seq, doc }) => {
            edit.setBaseDoc(doc);
            lastSeq = Math.max(lastSeq, seq);
          });
        }
        resolve();
      });
    });
  }

  /** Join the room for `id` (leaving any previous room). Idempotent for the same map. */
  async function join(id: string): Promise<void> {
    if (mapId.value === id && connected.value) return;
    if (mapId.value) leave();
    mapId.value = id;
    history.value = [];
    await doJoin(id);
  }

  function leave(): void {
    const id = mapId.value;
    if (id) getSocket().emit("room:leave", { mapId: id });
    edit.setCollab(false, null);
    me.value = null;
    peers.clear();
    history.value = [];
    lastSeq = 0;
    mapId.value = null;
    channel.value = null; // the next map joins its own channel (no cross-map channel leaks)
  }

  // --- presence senders (throttled lightly client-side; server also throttles ~20Hz) ----
  let lastCursorSent = 0;
  function sendCursor(cell: { x: number; y: number } | null): void {
    const id = mapId.value;
    if (!id || !me.value || !cell) return;
    const now = Date.now();
    if (now - lastCursorSent < 60) return;
    lastCursorSent = now;
    getSocket().emit("presence:cursor", { mapId: id, cursor: cell });
  }
  function sendSelection(ids: string[]): void {
    const id = mapId.value;
    if (!id || !me.value) return;
    getSocket().emit("presence:select", { mapId: id, selection: ids });
  }

  return {
    mapId,
    channel,
    me,
    connected,
    peerList,
    history,
    userName,
    setUserName,
    setPendingShare,
    join,
    leave,
    sendCursor,
    sendSelection,
  };
});
