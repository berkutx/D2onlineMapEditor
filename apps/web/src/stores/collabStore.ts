/**
 * Collaboration store: connects the typed socket, joins the room for the open map (room =
 * map id = share link), broadcasts my edits, and folds peers' edits into the live doc.
 *
 * Model: the server keeps ONE ordered EditOp log per map; every
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
import { activeOps, activeOpUids, allOpUids } from "@d2/map-edit";
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
  /** Ops that undo this entry (apply in array order), captured at apply time. For a batched
   *  entry this is EVERY op's inverse, newest-first, so one revert undoes the whole commit.
   *  Empty for a mid-stroke entry whose composed inverse rides on the stroke's LAST entry. */
  inverse?: EditOp[];
  /** Ops of ONE commit (brush stroke, Copilot generation) collapse into a single row keyed
   *  by this. Absent for a standalone op. */
  batchId?: string;
  /** How many ops this row represents (undefined/1 = standalone). */
  count?: number;
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

/** One-line summary for a whole COMMIT collapsed into ONE row — «⛰ рельеф — 412 кл.» instead
 *  of 412 «⛰ рельеф (x, y)» rows (the whole point of batching). */
function summarizeBatch(ops: readonly EditOp[], ctx?: OpContext): string {
  const n = ops.length;
  if (n === 1) return summarize(ops[0]!, ctx);
  const allCells = ops.every((o) => o.kind === "setCell");
  if (allCells) {
    const roads = ops.filter((o) => o.kind === "setCell" && o.roadType !== undefined && o.roadType >= 0).length;
    if (roads === n) return `🛣 дороги — ${n} кл.`;
    if (roads === 0) return `⛰ рельеф — ${n} кл.`;
    return `⛰ рельеф + 🛣 дороги — ${n} кл.`;
  }
  const allSameAdd = ops.every((o) => o.kind === "addObject");
  if (allSameAdd) return `➕ объектов: ${n}`;
  return `✎ правок за операцию: ${n}`;
}
function detailBatch(ops: readonly EditOp[]): string {
  const by = new Map<string, number>();
  for (const o of ops) by.set(o.kind, (by.get(o.kind) ?? 0) + 1);
  const tally = [...by].map(([k, c]) => `${k} × ${c}`).join(", ");
  return `${ops.length} правок за одну операцию\n${tally}`;
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

  /** Live/catch-up grouping of a peer's (or a reloaded) commit: ops sharing a `batchId` fold
   *  into ONE row as they stream in (find-or-create), so a peer's generation is one line, not
   *  thousands. My OWN commits are recorded whole in sendOps (I have every op at once). */
  const batchAgg = new Map<string, { entry: HistoryEntry; count: number }>();
  function recordGrouped(seq: number, by: string, op: EditOp, mine: boolean, inverse: EditOp[] | undefined, batchId?: string): void {
    if (!batchId) return record(seq, by, op, mine, inverse);
    const agg = batchAgg.get(batchId);
    if (agg) {
      agg.count++;
      agg.entry.count = agg.count;
      agg.entry.seq = Math.min(agg.entry.seq, seq);
      if (inverse?.length) agg.entry.inverse = [...inverse, ...(agg.entry.inverse ?? [])]; // newest-first
      agg.entry.summary = `✎ правок за операцию: ${agg.count}`;
      agg.entry.detail = `${agg.count} правок за одну операцию`;
      return;
    }
    const ctx = opCtx();
    const entry: HistoryEntry = {
      seq, by, byName: nameOf(by), byColor: colorOf(by), op,
      summary: summarize(op, ctx), detail: detailOf(op, ctx), mine, inverse: inverse ?? [], batchId, count: 1,
    };
    batchAgg.set(batchId, { entry, count: 1 });
    history.value = [...history.value, entry];
  }

  function bindListeners(): void {
    if (listenersBound) return;
    listenersBound = true;
    const socket = getSocket();

    socket.on("edit:applied", ({ seq, by, clientOpId, op, batchId }) => {
      lastSeq = Math.max(lastSeq, seq);
      // a second tab of THIS browser shares the localStorage journal — an op it already
      // holds must not double-apply (addObject would throw)
      if (clientOpId && knownOpIds.has(clientOpId)) return;
      try {
        const inv = edit.applyIncoming([op], clientOpId ? [clientOpId] : undefined); // peer op → live doc + journal (not my undo stack)
        if (clientOpId) knownOpIds.add(clientOpId);
        recordGrouped(seq, by, op, false, inv, batchId); // peer's stroke/generation → ONE row
      } catch (err) {
        // a conflicting peer op (e.g. an id our local draft already used) must not kill
        // the socket pipeline — surface it instead
        // eslint-disable-next-line no-console
        console.error("[collab] правка участника не применилась:", err, op);
        ElMessage.warning("Правка участника конфликтует с вашим локальным черновиком и не применена");
      }
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
    // a reconnect re-joins the same room and replays only the MISSED ops (not a snapshot —
    // the journal already holds everything we saw; a snapshot would double-apply it)
    socket.io.on("reconnect", () => {
      if (mapId.value) void doJoin(mapId.value, true);
    });
  }

  /** Op uids this client's journal holds (rebuilt from the project at join, grown on every
   *  send/fold). Any room-log replay — fresh join, second tab, reconnect — skips these:
   *  they are already applied AND sit in the journal; replaying = double-apply
   *  (addObject throws). Replaces the old per-session mySentOpIds, which could not
   *  recognize ops sent by an earlier session or another tab of the same browser. */
  let knownOpIds = new Set<string>();

  /** The outgoing hook editStore calls on every local commit / undo / redo.
   *  `inverses[i]` (captured at apply time) rides into the history entry of ops[i];
   *  `uids[i]` is ops[i]'s journal-persisted uid, sent as clientOpId. */
  function sendOps(ops: readonly EditOp[], inverses?: EditOp[][], uids?: readonly string[]): void {
    const id = mapId.value;
    const socket = getSocket();
    if (!id || !me.value) return;
    const meId = me.value.socketId;
    // A multi-op commit (brush stroke / Copilot generation) is ONE history row + ONE undo
    // unit. Record it whole NOW (I hold every op + inverse); the per-op acks below only
    // advance seq/known-ids. The shared `batchId` rides the wire so peers + a later reload
    // collapse the same ops into one row too (recordGrouped).
    const batchId = ops.length > 1 ? `${meId}:B${opCounter++}` : undefined;
    if (batchId) {
      const ctx = opCtx();
      const flatInverse = inverses ? inverses.slice().reverse().flatMap((iv) => iv) : []; // newest-first
      history.value = [
        ...history.value,
        {
          seq: lastSeq + 1, by: meId, byName: nameOf(meId), byColor: colorOf(meId),
          op: ops[0]!, summary: summarizeBatch(ops, ctx), detail: detailBatch(ops),
          mine: true, inverse: flatInverse, batchId, count: ops.length,
        },
      ];
    }
    ops.forEach((op, i) => {
      const clientOpId = uids?.[i] || `${meId}:${opCounter++}`;
      knownOpIds.add(clientOpId);
      const inverse = inverses?.[i];
      socket.emit("edit:op", { mapId: id, clientOpId, baseSeq: lastSeq, op, batchId }, (ack) => {
        if (ack.ok && typeof ack.seq === "number") {
          lastSeq = Math.max(lastSeq, ack.seq);
          if (!batchId) record(ack.seq, meId, op, true, inverse); // singles: their own row
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

  /** Fold room-log entries into the live doc, skipping ops the journal already holds
   *  (matched by clientOpId == the op's journal uid). One conflicting entry must not
   *  abort the rest — it is reported and skipped (the old snapshot path crashed the
   *  whole join on the first conflict). */
  function foldEntries(
    entries: readonly { seq: number; by: string; clientOpId: string; op: EditOp; batchId?: string }[],
  ): void {
    let failed = 0;
    for (const en of entries) {
      lastSeq = Math.max(lastSeq, en.seq);
      if (en.clientOpId && knownOpIds.has(en.clientOpId)) continue; // уже в журнале (мой / другой таб)
      try {
        const inv = edit.applyIncoming([en.op], en.clientOpId ? [en.clientOpId] : undefined);
        if (en.clientOpId) knownOpIds.add(en.clientOpId);
        recordGrouped(en.seq, en.by, en.op, false, inv, en.batchId); // catch-up: one row per commit
      } catch (err) {
        failed++;
        // eslint-disable-next-line no-console
        console.error(`[collab] правка из комнаты (seq ${en.seq}) не применилась:`, err, en.op);
      }
    }
    if (failed > 0) {
      ElMessage.warning(
        `Правок из комнаты не применилось: ${failed} (конфликт с локальным черновиком) — подробности в консоли`,
      );
    }
  }

  async function doJoin(id: string, reconnect = false): Promise<void> {
    const socket = getSocket();
    bindListeners();
    // a share link's channel wins (joining the sharer's room); a reconnect reuses the
    // channel we were already in; otherwise my persistent private channel
    const chan =
      pendingShare?.mapId === id ? pendingShare.channel : channel.value ?? getChannelId();
    if (pendingShare?.mapId === id) pendingShare = null; // consume once
    channel.value = chan;
    // the dedup base: every uid the journal holds (backfill legacy commits first, so a
    // draft sent to the room in THIS session is recognizable after the next reload)
    edit.ensureJournalUids();
    knownOpIds = edit.project ? allOpUids(edit.project) : new Set();
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
        edit.setCollab(true, sendOps);
        const serverHead = r.snapshotSeq;
        // Catch-up (fresh join AND reconnect): replay the room log as OPS with uid dedup —
        // never a snapshot. A snapshot doc already CONTAINS the results of ops sitting in
        // this journal (sent by an earlier session / another tab), so rebasing on it and
        // re-applying the journal double-applied them (addObject threw, the join died).
        const after = reconnect ? lastSeq : 0;
        if (!reconnect) lastSeq = serverHead;
        if (serverHead > after) {
          socket.emit("ops:since", { mapId: id, afterSeq: after }, (res) => {
            if (res.ok) foldEntries(res.entries);
          });
        } else if (serverHead < after) {
          // сервер перезапустился и потерял лог — локальный журнал полнее; просто
          // принимаем новый отсчёт seq (экспорт от серверного лога не зависит)
          lastSeq = serverHead;
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
    batchAgg.clear();
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
    // capture NOW: peer ops folding into the journal while the dialog is open must not ride along.
    // The uids ride along too — the room log must carry the SAME uids the journal holds,
    // or the next reload would re-apply the sent draft (the double-apply crash).
    const draft = activeOps(p);
    const draftUids = activeOpUids(p);
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
        sendOps(draft, undefined, draftUids); // no captured inverses (applied long ago) — their revert rows come disabled
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
    batchAgg.clear();
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
