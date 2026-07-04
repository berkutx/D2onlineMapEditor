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
import { ElMessage, ElMessageBox } from "element-plus";
import type { EditOp, UserPresence } from "@d2/socket-contract";
import { activeOps } from "@d2/map-edit";
import { getSocket } from "../realtime/socket";
import { getChannelId } from "../services/clientId";
import { useEditStore } from "./editStore";
import { useDecorStore } from "./decorStore";

const NAME_KEY = "d2.collab.name";

/** A shared-timeline entry (newest last): who applied which op at which seq. */
export interface HistoryEntry {
  seq: number;
  by: string; // socketId of the author
  byName: string;
  byColor: string;
  op: EditOp;
  summary: string;
  /** A slightly longer, click-to-reveal description (what exactly changed). */
  detail: string;
  mine: boolean;
  /** Ops that undo this entry (apply in array order), captured at apply time. Empty for a
   *  mid-stroke entry whose composed inverse rides on the stroke's LAST entry. */
  inverse?: EditOp[];
}

function randomName(): string {
  const n = Math.floor(1000 + (Date.now() % 9000));
  return `Гость-${n}`;
}

/** Russian labels for the object types + the patchObject field keys, so history rows read
 *  like the editor, not like the raw model. */
const TYPE_RU: Record<string, string> = {
  stack: "отряд", village: "город", capital: "столица", fort: "форт", ruin: "руины",
  merchant: "лавка", mage: "маг. башня", trainer: "тренер", mercenary: "наёмники",
  mountains: "горы", crystal: "кристалл", landmark: "декор", location: "локация",
  unit: "юнит", treasure: "клад", rod: "жезл", tomb: "гробница", generic: "объект",
};
const FIELD_RU: Record<string, string> = {
  name: "имя", owner: "владелец", garrison: "гарнизон", leaderCell: "лидер", order: "приказ",
  equip: "снаряжение", inventory: "инвентарь", banner: "знамя", baseType: "вид", image: "вид",
  radius: "радиус", items: "предметы", stock: "товары", school: "школа магии", gold: "золото",
  facing: "поворот", morale: "мораль", move: "ход", subRace: "фракция", desc: "описание",
  visitorStack: "гость", tier: "уровень", value: "значение",
};
const typeRu = (t: string): string => TYPE_RU[t] ?? t;
const fieldsRu = (fields: Record<string, unknown>): string =>
  Object.keys(fields).map((k) => FIELD_RU[k] ?? k).join(", ");

/** Optional humanizers wired in by the store (avoid hard coupling at module level):
 *  the target object of an op by id, and a decoration name for a G000MG… id. */
interface OpContext {
  objectOf?: (id: string) => { type: string; name?: string } | undefined;
  decorName?: (id: string) => string | undefined;
}

/** «столица „Хеленверд“» / «декор „Стена“» — the op target, best effort. */
function targetRu(id: string, ctx?: OpContext): string {
  const o = ctx?.objectOf?.(id);
  if (!o) return "объект";
  const decor = o.type === "landmark" ? ctx?.decorName?.((o as { baseType?: string }).baseType ?? "") : undefined;
  const label = o.name || decor;
  return label ? `${typeRu(o.type)} «${label}»` : typeRu(o.type);
}

/** Humanize one patched value: decoration ids get their catalog name, the rest print as-is. */
function valueRu(key: string, v: unknown, ctx?: OpContext): string {
  if (typeof v === "object") return "…";
  const s = String(v);
  if (key === "baseType") {
    const name = ctx?.decorName?.(s);
    return name ? `${name} (${s})` : s;
  }
  if (key === "image") return `вариант ${s}`;
  return s;
}

/** A short, human-readable Russian summary of an op for the history panel. */
function summarize(op: EditOp, ctx?: OpContext): string {
  switch (op.kind) {
    case "setCell":
      // roadType rides along on every INVERSE setCell (exact restore; -1 = «нет дороги») —
      // call it a road op only when it lays road (≥0), so terrain reverts don't read «дорога»
      return op.roadType !== undefined && op.roadType >= 0
        ? `🛣 дорога (${op.x}, ${op.y})` : `⛰ рельеф (${op.x}, ${op.y})`;
    case "addObject":
      return `➕ ${typeRu(op.object.type)}`;
    case "moveObject":
      return `⇄ ${targetRu(op.id, ctx)} → (${op.x}, ${op.y})`;
    case "patchObject":
      return `✎ ${fieldsRu(op.fields) || "свойства"} — ${targetRu(op.id, ctx)}`;
    case "deleteObject":
      return `🗑 ${targetRu(op.id, ctx)}`;
    case "upsertEvent":
      return `⚡ событие «${op.event.name || op.event.id}»`;
    case "deleteEvent":
      return "🗑 удалено событие";
    case "setVariables":
      return `𝑥 переменные (${op.variables.length})`;
    case "upsertTemplate":
      return `⛨ шаблон «${op.template.name || op.template.id}»`;
    case "deleteTemplate":
      return "🗑 удалён шаблон";
  }
}

/** A slightly longer description revealed when a history row is clicked (not exhaustive). */
function detailOf(op: EditOp, ctx?: OpContext): string {
  switch (op.kind) {
    case "setCell":
      return `клетка (${op.x}, ${op.y}), значение ${op.value}${op.roadType !== undefined ? `, дорога ${op.roadType}` : ""}`;
    case "addObject":
      return `${typeRu(op.object.type)} «${(op.object as { name?: string }).name || op.object.id}» в (${op.object.pos.x}, ${op.object.pos.y})`;
    case "moveObject":
      return `${targetRu(op.id, ctx)} (${op.id}) → клетка (${op.x}, ${op.y})`;
    case "patchObject": {
      const parts = Object.entries(op.fields).map(([k, v]) => {
        const label = FIELD_RU[k] ?? k;
        const val = valueRu(k, v, ctx);
        return val.length && typeof v !== "object" ? `${label}: ${val}` : label;
      });
      return `${targetRu(op.id, ctx)} (${op.id})\n${parts.join("\n")}`;
    }
    case "deleteObject":
      return `${targetRu(op.id, ctx)} (${op.id})`;
    case "upsertEvent":
      return `${op.event.id}\nусловий: ${op.event.conditions.length}, эффектов: ${op.event.effects.length}, шанс ${op.event.chance}%`;
    case "deleteEvent":
      return `событие ${op.id}`;
    case "setVariables":
      return op.variables.map((v) => `${v.name} = ${v.value}`).join("\n") || "нет переменных";
    case "upsertTemplate":
      return `${op.template.id}\nюнитов: ${op.template.units.filter(Boolean).length}, лидер: ${op.template.leader || "—"}`;
    case "deleteTemplate":
      return `шаблон ${op.id}`;
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

  /** Humanizer context for history rows: resolve the op's target object + decor names.
   *  Best effort — a deleted object no longer resolves (falls back to «объект»). */
  function opCtx(): OpContext {
    const decor = useDecorStore();
    return {
      objectOf: (id) =>
        edit.liveDoc?.objects.find((o) => o.id === id) as { type: string; name?: string } | undefined,
      decorName: (id) => (id ? decor.get(id.toUpperCase())?.name_ru || decor.get(id.toUpperCase())?.desc_en : undefined),
    };
  }

  function record(seq: number, by: string, op: EditOp, mine: boolean, inverse?: EditOp[]): void {
    const ctx = opCtx();
    history.value = [
      ...history.value,
      { seq, by, byName: nameOf(by), byColor: colorOf(by), op, summary: summarize(op, ctx), detail: detailOf(op, ctx), mine, inverse },
    ];
  }

  function bindListeners(): void {
    if (listenersBound) return;
    listenersBound = true;
    const socket = getSocket();

    socket.on("edit:applied", ({ seq, by, op }) => {
      const inv = edit.applyIncoming([op]); // peer op → live doc + journal (not my undo stack)
      lastSeq = Math.max(lastSeq, seq);
      record(seq, by, op, false, inv);
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

  /** The outgoing hook editStore calls on every local commit / undo / redo.
   *  `inverses[i]` (captured at apply time) rides into the history entry of ops[i]. */
  function sendOps(ops: readonly EditOp[], inverses?: EditOp[][]): void {
    const id = mapId.value;
    const socket = getSocket();
    if (!id || !me.value) return;
    ops.forEach((op, i) => {
      const clientOpId = `${me.value!.socketId}:${opCounter++}`;
      const inverse = inverses?.[i];
      socket.emit("edit:op", { mapId: id, clientOpId, baseSeq: lastSeq, op }, (ack) => {
        if (ack.ok && typeof ack.seq === "number") {
          lastSeq = Math.max(lastSeq, ack.seq);
          record(ack.seq, me.value!.socketId, op, true, inverse);
        } else {
          // eslint-disable-next-line no-console
          console.warn("[collab] op rejected:", ack.reason);
        }
      });
    });
  }

  // --- history revert («откатить») -------------------------------------------------------
  // Revert = apply the captured inverses as a NEW forward commit (append-only model: nothing
  // is rewound; peers receive it as a regular edit; it lands in MY undo stack).

  /** Inverses of the given entries, newest→oldest, ready to apply in order. */
  function inversesOf(entries: HistoryEntry[]): EditOp[] {
    return entries
      .slice()
      .sort((a, b) => b.seq - a.seq)
      .flatMap((e) => e.inverse ?? []);
  }

  /** Revert ONE entry (may conflict with later edits — applyOp fails loud, nothing applies). */
  function revertOne(seq: number): boolean {
    const entry = history.value.find((e) => e.seq === seq);
    if (!entry) return false;
    return applyRevert(inversesOf([entry]), `#${seq}`);
  }

  /** Revert entry `seq` and EVERYTHING newer (exact inverses, newest→oldest). */
  function revertFrom(seq: number): boolean {
    return applyRevert(inversesOf(history.value.filter((e) => e.seq >= seq)), `#${seq} и новее`);
  }

  function applyRevert(ops: EditOp[], label: string): boolean {
    if (!ops.length) return false;
    try {
      edit.commit(ops);
      return true;
    } catch (err) {
      // applyToLive assigns liveDoc only after ALL ops apply — a mid-chain conflict
      // (e.g. reverting a delete whose object a peer re-created) leaves the doc untouched.
      // eslint-disable-next-line no-console
      console.warn(`[collab] откат ${label} не применился:`, err);
      return false;
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
    offerPreJoinDraft(id);
  }

  /** Pre-join local draft: edits made OUTSIDE the room (offline / before ever joining) live
   *  only in my journal — peers can't see them. When joining a room WITH peers, offer to
   *  broadcast the draft as regular room ops (my journal keeps them — it stays the full
   *  op list for export). Declining keeps the draft local-on-top; either way the offer is
   *  made once per room per session (no nagging on every map open). NOT on reconnects —
   *  doJoin from the reconnect handler bypasses this. */
  function offerPreJoinDraft(id: string): void {
    if (!connected.value || mapId.value !== id) return;
    if (peers.size === 0) return; // solo room — no one to share the draft with
    const p = edit.project;
    if (!p || p.baseScenarioId !== id) return;
    // capture NOW: peer ops folding into the journal while the dialog is open must not ride along
    const draft = activeOps(p);
    if (!draft.length) return;
    const key = `d2.collab.draftOffered.${id}#${channel.value ?? ""}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      /* storage unavailable — offer anyway */
    }
    void ElMessageBox.confirm(
      `У вас есть локальный черновик этой карты (правок: ${draft.length}), сделанный до входа в комнату — участники его не видят. Отправить черновик в комнату?`,
      "Локальный черновик",
      { confirmButtonText: "Отправить в комнату", cancelButtonText: "Оставить локально", type: "info" },
    )
      .then(() => {
        sendOps(draft); // no captured inverses (applied long ago) — their revert rows come disabled
        ElMessage.success(`Черновик отправлен: участники теперь видят ваши правки (${draft.length})`);
      })
      .catch(() => {
        /* оставить локально (текущее поведение: черновик поверх, только у меня) */
      });
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
    revertOne,
    revertFrom,
  };
});
