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
import { activeOps, activeOpUids, allOpUids, opKeys, applyOps, newStructuralIssues } from "@d2/map-edit";
import { getSocket } from "../realtime/socket";
import { getChannelId, getClientId } from "../services/clientId";
import { useEditStore } from "./editStore";
import { useDecorStore } from "./decorStore";

const NAME_KEY = "d2.collab.name";

/** A later history entry that blocks a cherry-pick revert (touches the same keys). */
export type RevertDependent = { seq: number; byName: string; mine: boolean; summary: string };

/** A shared-timeline entry (newest last): who applied which op at which seq. */
export interface HistoryEntry {
  /** Stable per-session ROW id — the panel and the revert APIs address rows by this, never
   *  by seq: my optimistic rows carry a PROVISIONAL seq (lastSeq+1) until the ack, so two
   *  in-flight commits can tie and a seq lookup resolves the wrong entry. */
  rid: number;
  seq: number;
  by: string; // socketId of the author
  byName: string;
  byColor: string;
  op: EditOp;
  summary: string;
  /** A slightly longer, click-to-reveal description (what exactly changed). */
  detail: string;
  mine: boolean;
  /** The server confirmed this row (its seq is authoritative → the server-side cherry-pick
   *  can target it). false while in flight, and forever for rejected/local-only rows. */
  acked: boolean;
  /** The server REFUSED this row's ops (ack.ok=false) — they are applied locally but are NOT
   *  in the room log. Distinguishes "local-only" (safe to revert locally) from "in flight"
   *  (reverting locally would race the pending ack — wait instead). */
  rejected?: boolean;
  /** Ops that undo this entry (apply in array order), captured at apply time. For a batched
   *  entry this is EVERY op's inverse, newest-first, so one revert undoes the whole commit.
   *  Empty for a mid-stroke entry whose composed inverse rides on the stroke's LAST entry,
   *  and for rows re-folded from the room log after a reload (no local capture — the
   *  server-side revert handles those). */
  inverse?: EditOp[];
  /** Ops of ONE commit (brush stroke, Copilot generation) collapse into a single row keyed
   *  by this. Absent for a standalone op. */
  batchId?: string;
  /** How many ops this row represents (undefined/1 = standalone). */
  count?: number;
  /** Conflict keys of ALL ops in this entry (opKeys union), captured at record time. The
   *  dependency guard needs this because a pre-join-draft batch is recorded with an EMPTY
   *  inverse — deriving keys from op+inverse would then see only the representative op and
   *  miss the batch's other targets (silent-clobber hole). Absent on legacy in-memory rows. */
  keys?: string[];
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
  /** Ops emitted but not yet acked by the server (in flight) — drives the honest sync badge. */
  const pending = ref(0);
  /** Collab id slot (M4): the room assigns this socket a distinct index ∈ [0,16). New-object
   *  ids are minted in this slot's DISJOINT band (`nextTypedId`), so two editors placing the
   *  same object type concurrently never collide. 0 = solo / offline / pre-join. */
  const idSlot = ref(0);
  /** offline (no room) · syncing (ops in flight) · synced (everything acked). Replaces the old
   *  «есть правки» flag, which meant "journal non-empty" and never reflected actual sync. */
  const syncState = computed<"offline" | "syncing" | "synced">(() =>
    !connected.value ? "offline" : pending.value > 0 ? "syncing" : "synced",
  );
  /** Highest seq this client has applied (its position in the shared log). */
  let lastSeq = 0;
  let opCounter = 0;
  /** Monotonic history-row id source (see HistoryEntry.rid). */
  let ridCounter = 0;
  /** clientOpId (journal uid) → its history row, for fold-time dedup + pending-row
   *  confirmation (an op whose ack was lost is re-seen in the log on reconnect). */
  let rowByUid = new Map<string, HistoryEntry>();
  let listenersBound = false;
  /** My durable browser identity — log entries whose `author` matches are MINE («вы»),
   *  whichever session or tab of this browser sent them. */
  const myClientId = getClientId();

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

  /** Push an entry and return its REACTIVE proxy from the array — every later mutation
   *  (seq fix-up on ack, batch merge) must go through the proxy, or Vue effects (the
   *  dependents index, the panel's :disabled) keep serving stale results. In-place push
   *  (reactive, tracked via length) — NOT a spread copy: a reload fold records a row per
   *  log entry, and spreading the proxied array per row is O(rows²) proxy traps. */
  function pushEntry(entry: HistoryEntry, uids?: readonly (string | undefined)[]): HistoryEntry {
    history.value.push(entry);
    const proxy = history.value[history.value.length - 1]!;
    if (uids) for (const u of uids) if (u) rowByUid.set(u, proxy);
    return proxy;
  }

  function record(
    seq: number, by: string, op: EditOp, mine: boolean, inverse?: EditOp[],
    opts?: { acked?: boolean; uid?: string },
  ): HistoryEntry {
    const ctx = opCtx();
    return pushEntry(
      {
        rid: ridCounter++, seq, by, byName: nameOf(by), byColor: colorOf(by), op,
        summary: summarize(op, ctx), detail: detailOf(op, ctx), mine,
        acked: opts?.acked ?? true, inverse, keys: opKeys(op),
      },
      [opts?.uid],
    );
  }

  /** Live/catch-up grouping of a peer's (or a reloaded) commit: ops sharing a `batchId` fold
   *  into ONE row as they stream in (find-or-create), so a peer's generation is one line, not
   *  thousands. My OWN commits are recorded whole in sendOps (I have every op at once). */
  const batchAgg = new Map<string, { entry: HistoryEntry; count: number }>();
  function recordGrouped(seq: number, by: string, op: EditOp, mine: boolean, inverse: EditOp[] | undefined, batchId?: string, uid?: string): void {
    if (!batchId) {
      record(seq, by, op, mine, inverse, { uid });
      return;
    }
    const agg = batchAgg.get(batchId);
    if (agg) {
      agg.count++;
      agg.entry.count = agg.count;
      agg.entry.seq = Math.min(agg.entry.seq, seq);
      if (inverse?.length) agg.entry.inverse = [...inverse, ...(agg.entry.inverse ?? [])]; // newest-first
      for (const k of opKeys(op)) if (!agg.entry.keys!.includes(k)) agg.entry.keys!.push(k); // accumulate conflict keys as the stroke streams in
      entryKeysCache.delete(agg.entry); // keys grew — a cached Set would silently under-cover
      agg.entry.summary = `✎ правок за операцию: ${agg.count}`;
      agg.entry.detail = `${agg.count} правок за одну операцию`;
      if (uid) rowByUid.set(uid, agg.entry);
      return;
    }
    const ctx = opCtx();
    const entry = pushEntry(
      {
        rid: ridCounter++, seq, by, byName: nameOf(by), byColor: colorOf(by), op,
        summary: summarize(op, ctx), detail: detailOf(op, ctx), mine, acked: true,
        inverse: inverse ?? [], batchId, count: 1, keys: opKeys(op),
      },
      [uid],
    );
    batchAgg.set(batchId, { entry, count: 1 });
  }

  /** Record a WHOLE batched commit as ONE history row (I have every op + inverse at once —
   *  from my own send, a peer's edit:opsApplied, or a catch-up run). `inverse` is newest-first
   *  so a single revert undoes the whole commit. */
  function recordBatchRow(
    seq: number, by: string, ops: readonly EditOp[], inverse: EditOp[] | undefined, batchId: string, mine: boolean,
    opts?: { acked?: boolean; uids?: readonly (string | undefined)[] },
  ): HistoryEntry {
    const ctx = opCtx();
    // keys from ALL ops (not just op[0]/inverse): a pre-join draft batch is recorded with an
    // empty inverse, so op+inverse would under-cover it and the dependency guard would miss it.
    const keys = new Set<string>();
    for (const o of ops) for (const k of opKeys(o)) keys.add(k);
    const entry = pushEntry(
      {
        rid: ridCounter++, seq, by, byName: nameOf(by), byColor: colorOf(by),
        op: ops[0]!, summary: summarizeBatch(ops, ctx), detail: detailBatch(ops),
        mine, acked: opts?.acked ?? true, inverse: inverse ?? [], batchId, count: ops.length, keys: [...keys],
      },
      opts?.uids,
    );
    batchAgg.set(batchId, { entry, count: ops.length }); // a stray later op merges, not dups
    return entry;
  }

  function bindListeners(): void {
    if (listenersBound) return;
    listenersBound = true;
    const socket = getSocket();
    (window as unknown as { __d2socket?: unknown }).__d2socket = socket; // debug hook (inspect emits)

    socket.on("edit:applied", ({ seq, by, author, clientOpId, op, batchId }) => {
      lastSeq = Math.max(lastSeq, seq);
      // a second tab of THIS browser shares the localStorage journal — an op it already
      // holds must not double-apply (addObject would throw)
      if (clientOpId && knownOpIds.has(clientOpId)) return;
      try {
        const inv = edit.applyIncoming([op], clientOpId ? [clientOpId] : undefined); // peer op → live doc + journal (not my undo stack)
        if (clientOpId) knownOpIds.add(clientOpId);
        // `mine` by the DURABLE author id: my other tab's op is «вы», not an anonymous peer
        recordGrouped(seq, by, op, author === myClientId, inv, batchId, clientOpId);
      } catch (err) {
        // a conflicting peer op (e.g. an id our local draft already used) must not kill
        // the socket pipeline — surface it instead
        // eslint-disable-next-line no-console
        console.error("[collab] правка участника не применилась:", err, op);
        ElMessage.warning("Правка участника конфликтует с вашим локальным черновиком и не применена");
      }
    });

    // A peer's WHOLE batched commit (see edit:ops) — apply every op in ONE pass and record
    // ONE history row. This is the receive side of the per-tile-flood fix.
    socket.on("edit:opsApplied", ({ batchId, by, author, ops }) => {
      for (const o of ops) lastSeq = Math.max(lastSeq, o.seq);
      const fresh = ops.filter((o) => !(o.clientOpId && knownOpIds.has(o.clientOpId))); // skip 2nd-tab dups
      if (fresh.length === 0) return;
      try {
        const inv = edit.applyIncoming(fresh.map((f) => f.op), fresh.map((f) => f.clientOpId)); // ONE apply pass
        for (const f of fresh) if (f.clientOpId) knownOpIds.add(f.clientOpId);
        recordBatchRow(fresh[0]!.seq, by, fresh.map((f) => f.op), inv, batchId, author === myClientId, {
          uids: fresh.map((f) => f.clientOpId),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[collab] пакет правок участника не применился:", err);
        ElMessage.warning("Пакет правок участника конфликтует с вашим локальным черновиком");
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

  /** Op uids the ROOM's server log already carries, gathered from the ops:since catch-up at join.
   *  Distinct from knownOpIds (which also holds my LOCAL-only journal ops): a pre-join draft offer
   *  must propose ONLY ops the room lacks, else it re-offers a draft I already pushed (harmless —
   *  the server dedups the resend — but confusing). Reset per join; filled in foldEntries. */
  let roomOpUids = new Set<string>();

  /** The outgoing hook editStore calls on every local commit / undo / redo.
   *  `inverses[i]` (captured at apply time) rides into the history entry of ops[i];
   *  `uids[i]` is ops[i]'s journal-persisted uid, sent as clientOpId. */
  function sendOps(ops: readonly EditOp[], inverses?: EditOp[][], uids?: readonly string[]): void {
    const id = mapId.value;
    const socket = getSocket();
    if (!id || !me.value || ops.length === 0) return;
    const meId = me.value.socketId;

    // Single op → one edit:op message + its own history row. The row is recorded AT COMMIT
    // TIME (provisional seq, acked=false), not in the ack — an in-flight op invisible to the
    // dependents guard was a silent-clobber window (revert of an older same-key row slipped
    // through during the RTT). The ack only fixes seq/acked up; a rejected op keeps its row
    // (the edit is still applied locally — it is a local-only change, revertable locally).
    if (ops.length === 1) {
      const op = ops[0]!;
      const clientOpId = uids?.[0] || `${meId}:${opCounter++}`;
      knownOpIds.add(clientOpId);
      const inverse = inverses?.[0];
      const entry = record(lastSeq + 1, meId, op, true, inverse, { acked: false, uid: clientOpId });
      pending.value++;
      socket.emit("edit:op", { mapId: id, clientOpId, baseSeq: lastSeq, op }, (ack) => {
        pending.value = Math.max(0, pending.value - 1);
        if (ack.ok && typeof ack.seq === "number") { lastSeq = Math.max(lastSeq, ack.seq); entry.seq = ack.seq; entry.acked = true; }
        else { entry.rejected = true; console.warn("[collab] op rejected:", ack.reason); } // eslint-disable-line no-console
      });
      return;
    }

    // Multi-op commit (brush stroke / Copilot generation) → ONE batch message + ONE history
    // row. The whole diff crosses the wire as a single frame — NOT one edit:op per tile
    // (that flooded the socket + log and lagged everyone).
    const batchId = `${meId}:B${opCounter++}`;
    const opsWithIds = ops.map((op, i) => {
      const clientOpId = uids?.[i] || `${meId}:o${opCounter++}`;
      knownOpIds.add(clientOpId);
      return { clientOpId, op };
    });
    const flatInverse = inverses ? inverses.slice().reverse().flatMap((iv) => iv) : []; // newest-first
    const entry = recordBatchRow(lastSeq + 1, meId, ops, flatInverse, batchId, true, {
      acked: false,
      uids: opsWithIds.map((o) => o.clientOpId),
    });
    pending.value++;
    socket.emit("edit:ops", { mapId: id, batchId, baseSeq: lastSeq, ops: opsWithIds }, (ack) => {
      pending.value = Math.max(0, pending.value - 1);
      if (ack.ok) { lastSeq = Math.max(lastSeq, ack.seqEnd); entry.seq = ack.seqStart; entry.acked = true; }
      else { entry.rejected = true; console.warn("[collab] batch rejected:", ack.reason); } // eslint-disable-line no-console
    });
  }

  /**
   * RE-SEED an EMPTY room log from my whole journal after the server lost it (restart /
   * redeploy — the log is in-memory). Without this, a guest catching up after a restart sees
   * a TRUNCATED map (the server head is behind my journal), which looked like "the shared map
   * isn't the one the owner sees". Sends the journal in seq order (log is empty → order is
   * correct) in chunks under the server's MAX_BATCH, WITHOUT recording history rows (I already
   * hold them) — peers dedup by uid, so no double-apply. Called only when serverHead === 0.
   */
  const RESEED_CHUNK = 20_000; // < server MAX_BATCH (50k); each chunk ≪ the 8 MB socket buffer
  let reseedInFlight = false; // reconnect can flap / two joins race — push at most ONCE per window

  /** Chunked push of (ops, uids) into the room log WITHOUT recording history rows (I already hold
   *  them; peers dedup by uid). The shared mechanism behind both journal→room reconciles:
   *   • reseedRoom — a server restart emptied the log and my journal is fuller (reconnect branch);
   *   • the fresh-join own-room draft (offerPreJoinDraft) — edits made before the socket joined.
   *  Chunks under the server's MAX_BATCH so a large journal isn't rejected wholesale and lost.
   *  reseedInFlight is per-tab, so two tabs racing an empty room can each push the same uids — the
   *  server's EditLog is idempotent over clientOpId (appendBatch skips an already-logged uid), so
   *  the second push is a no-op: no duplicate lines, and the log stays injective for the
   *  doc-rebuild folds (materialize / revert) that would otherwise throw on a duplicate add. */
  /** Returns true iff the push actually started (false if the guard tripped — another reseed in
   *  flight, no socket/identity, or nothing to send — so callers don't report a false success). */
  function pushJournalToLog(
    id: string,
    ops: readonly EditOp[],
    uids: readonly (string | undefined)[],
    reason: string,
  ): boolean {
    const socket = getSocket();
    if (reseedInFlight || !socket || !me.value || ops.length === 0) return false;
    reseedInFlight = true;
    window.setTimeout(() => { reseedInFlight = false; }, 30_000); // safety release
    const meId = me.value.socketId;
    // eslint-disable-next-line no-console
    console.info(`[collab] ${reason} (${ops.length} ops)`);
    let pending = 0;
    for (let i = 0; i < ops.length; i += RESEED_CHUNK) {
      const chunkOps = ops.slice(i, i + RESEED_CHUNK);
      const chunkUids = uids.slice(i, i + RESEED_CHUNK);
      const batchId = `${meId}:R${opCounter++}`;
      const payload = chunkOps.map((op, j) => {
        const clientOpId = chunkUids[j] || `${meId}:r${opCounter++}`;
        knownOpIds.add(clientOpId);
        return { clientOpId, op };
      });
      pending++;
      socket.emit("edit:ops", { mapId: id, batchId, baseSeq: lastSeq, ops: payload }, (ack) => {
        if (ack.ok) lastSeq = Math.max(lastSeq, ack.seqEnd);
        else console.warn(`[collab] ${reason} chunk rejected:`, ack.reason); // eslint-disable-line no-console
        if (--pending === 0) reseedInFlight = false;
      });
    }
    return true;
  }

  /** A server restart emptied the room log while my journal is fuller — re-seed it (serverHead===0)
   *  so a guest / second tab can catch up to the full state instead of a truncated map. */
  function reseedRoom(id: string): void {
    const p = edit.project;
    if (!p) return;
    pushJournalToLog(id, activeOps(p), activeOpUids(p), "re-seeding room log from journal after server restart");
  }

  // --- history revert («откатить») -------------------------------------------------------
  // Revert = apply the captured inverses as a NEW forward commit (append-only model: nothing
  // is rewound; peers receive it as a regular edit; it lands in MY undo stack).

  /** Inverses of the given entries, newest→oldest in APPLY order (rid desc — seq can tie on
   *  optimistic in-flight rows, and unwinding must mirror how the doc was built), ready to
   *  apply in order. */
  function inversesOf(entries: HistoryEntry[]): EditOp[] {
    return entries
      .slice()
      .sort((a, b) => b.rid - a.rid)
      .flatMap((e) => e.inverse ?? []);
  }

  /** Every cell/object key an entry touches. Prefer `keys` captured at record time from ALL
   *  ops (a draft batch has an EMPTY inverse, so op+inverse would under-cover it); fall back to
   *  op+inverse for legacy rows. Cached per entry (recordGrouped INVALIDATES on merge — keys
   *  grow while a peer's stroke streams in), so the hot path (history panel re-renders on
   *  every peer op) does not rebuild a 50k-key Set each time. */
  const entryKeysCache = new WeakMap<HistoryEntry, Set<string>>();
  function entryKeys(e: HistoryEntry): Set<string> {
    const cached = entryKeysCache.get(e);
    if (cached) return cached;
    let ks: Set<string>;
    if (e.keys) ks = new Set(e.keys);
    else {
      ks = new Set(opKeys(e.op));
      for (const inv of e.inverse ?? []) for (const k of opKeys(inv)) ks.add(k);
    }
    entryKeysCache.set(e, ks);
    return ks;
  }

  /**
   * «Зависимые далее по цепочке»: LATER history entries touching the same cells/objects as an
   * entry. A cherry-pick revert («только это») is only safe when this is EMPTY — otherwise
   * applying the old inverse silently clobbers the newer edits (patch/move produce a VALID doc,
   * so validation can't catch it). Same key notion as the server's M5 conflict boundary; the
   * authoritative check runs SERVER-side on click (`edit:revertOne`) — this local one drives
   * the instant per-row disabled state.
   *
   * «Later» = ARRAY order. Rows are recorded when their ops are APPLIED to the live doc (my
   * commits at commit time, peers' at arrival, reload folds in log order), so array order IS
   * local application order. Seq deliberately plays no part: my optimistic rows carry a
   * provisional seq that can tie or interleave with server-assigned ones (the old `b.seq <=
   * a.seq` skip silently HID a same-key in-flight stroke from the guard).
   *
   * key → row positions index, rebuilt once per history change; per-row lookups memoised on
   * the index object (a generation row can carry 50k keys — no per-render rebuilds).
   */
  const historyIndex = computed(() => {
    const rows = history.value;
    const posByRid = new Map<number, number>();
    const posByKey = new Map<string, number[]>();
    rows.forEach((e, i) => {
      posByRid.set(e.rid, i);
      // SUBSCRIBE to the keys array length explicitly: entryKeys may serve a cached Set
      // (no reactive read), and a live batch merge grows e.keys in place — without this
      // tracked read the merge would never dirty the index and the guard would go stale.
      void e.keys?.length;
      for (const k of entryKeys(e)) {
        const arr = posByKey.get(k);
        if (arr) arr.push(i);
        else posByKey.set(k, [i]);
      }
    });
    return { rows, posByRid, posByKey, depsMemo: new Map<number, RevertDependent[]>() };
  });
  function dependentsOf(rid: number): RevertDependent[] {
    const idx = historyIndex.value;
    const memo = idx.depsMemo.get(rid);
    if (memo) return memo;
    const i = idx.posByRid.get(rid);
    if (i === undefined) return [];
    const later = new Set<number>();
    for (const k of entryKeys(idx.rows[i]!)) {
      for (const j of idx.posByKey.get(k) ?? []) if (j > i) later.add(j);
    }
    const deps = [...later].sort((a, b) => a - b).map((j) => {
      const b = idx.rows[j]!;
      return { seq: b.seq, byName: b.byName, mine: b.mine, summary: b.summary };
    });
    idx.depsMemo.set(rid, deps);
    return deps;
  }

  /** SIMULATE the revert on a clone and report NEW structural problems it would introduce —
   *  the general net that special-casing every dependency class (occupancy, dangling refs,
   *  city-on-water) would miss. A patch/move clobber is caught by `dependentsOf` (it yields a
   *  valid doc); THIS catches revert-of-add re-placing onto an occupied cell, revert-of-delete
   *  re-adding a referenced object, revert-of-paint under a later building, etc. Returns [] when
   *  the reverted state is no worse than now (the shared `newStructuralIssues` is
   *  baseline-subtracted, so pre-existing issues on a shipped map don't block). */
  function revertStructuralIssues(entry: HistoryEntry): string[] {
    const doc = edit.liveDoc;
    if (!doc) return [];
    let after: typeof doc;
    try {
      after = applyOps(doc, inversesOf([entry]));
    } catch (err) {
      return [`структурный конфликт: ${(err as Error).message}`]; // delete/re-add that cannot apply
    }
    return newStructuralIssues(doc, after);
  }

  type RevertResult = {
    ok: boolean;
    /** dependents/structure = guard blocks; pending = the row is still in flight (wait for
     *  the ack — reverting now would race it); offline = the row needs the server (no local
     *  inverse) but there is no live socket; conflict = apply/transport failure. */
    blocked?: "dependents" | "structure" | "conflict" | "pending" | "offline";
    dependents?: RevertDependent[];
    issues?: string[];
    /** the server's own rejection text, when it gave one (throttle / busy / not found). */
    reason?: string;
  };

  /** Revert ONE entry «только это» — only when nothing later depends on it (silent-clobber
   *  guard) AND the revert introduces no NEW structural problem. In a room the click goes to
   *  the SERVER (`edit:revertOne`): its log sees peers' in-flight ops this replica hasn't
   *  received yet, its seqs are final, and it works for rows re-folded after a reload (which
   *  carry no local inverse). REJECTED rows (server refused the op — it exists only locally)
   *  are undone via applyIncoming: the inverse must NEVER be broadcast, because peers' log
   *  never held the op (an addObject's inverse would be an unappliable deleteObject there —
   *  one such entry permanently breaks every fold of the room log). An in-flight row (ack
   *  pending) is refused — its inverse predates whatever the room applied meanwhile. A dead
   *  socket while in a room is refused too: edit.commit would BUFFER the broadcast and fire
   *  it after the reconnect against a moved-on log. */
  async function revertOne(rid: number): Promise<RevertResult> {
    const entry = history.value.find((e) => e.rid === rid);
    if (!entry) return { ok: false, blocked: "conflict" };
    // fast local pre-check — the server re-checks authoritatively, this catches the obvious
    const deps = dependentsOf(rid);
    if (deps.length) return { ok: false, blocked: "dependents", dependents: deps };
    if (entry.rejected) {
      if (!entry.inverse?.length) return { ok: false, blocked: "conflict" }; // already undone
      const issues = revertStructuralIssues(entry);
      if (issues.length) return { ok: false, blocked: "structure", issues };
      try {
        edit.applyIncoming(inversesOf([entry])); // local-only: live doc + journal, NO broadcast
        entry.inverse = []; // undone — the row must not be revertable twice
        return { ok: true };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[collab] локальный откат отклонённой правки не применился:", err);
        return { ok: false, blocked: "conflict" };
      }
    }
    if (connected.value) {
      if (!getSocket().connected) return { ok: false, blocked: "offline" };
      if (!entry.acked) return { ok: false, blocked: "pending" };
      return revertOneServer(entry);
    }
    // solo (no room): sendOps is inert (me == null), the local inverse cannot leak anywhere
    if (!entry.inverse?.length) return { ok: false, blocked: "offline" };
    const issues = revertStructuralIssues(entry);
    if (issues.length) return { ok: false, blocked: "structure", issues };
    const ok = applyRevert(inversesOf([entry]), `#${entry.seq}`);
    return ok ? { ok: true } : { ok: false, blocked: "conflict" };
  }

  /** The server-side cherry-pick: authoritative dependents + structure guards over the ROOM
   *  log, revert = diffDocs(head, sim-without-entry) appended as a forward batch and broadcast
   *  to everyone including us (applied via the normal edit:opsApplied path). `.timeout()` so a
   *  socket drop after the emit resolves honestly instead of hanging the click forever (the
   *  revert may still have landed — the catch-up fold will show it). */
  const REVERT_ACK_TIMEOUT_MS = 15_000;
  function revertOneServer(entry: HistoryEntry): Promise<RevertResult> {
    const id = mapId.value!;
    return new Promise((resolve) => {
      getSocket().timeout(REVERT_ACK_TIMEOUT_MS).emit(
        "edit:revertOne",
        { mapId: id, seq: entry.seq, batchId: entry.batchId },
        (err, r) => {
          if (err || !r) {
            // eslint-disable-next-line no-console
            console.warn("[collab] серверный откат: нет ответа (обрыв/таймаут)", err);
            resolve({ ok: false, blocked: "offline" });
            return;
          }
          if (r.ok) {
            resolve({ ok: true });
            return;
          }
          if (r.blocked === "dependents") {
            resolve({
              ok: false,
              blocked: "dependents",
              dependents: (r.dependents ?? []).map((d) => ({
                seq: d.seq,
                byName: d.author === myClientId ? "вы" : "участник",
                mine: d.author === myClientId,
                summary: "",
              })),
            });
            return;
          }
          if (r.blocked === "structure") {
            resolve({ ok: false, blocked: "structure", issues: r.issues ?? [] });
            return;
          }
          // eslint-disable-next-line no-console
          console.warn("[collab] серверный откат отклонён:", r.reason);
          resolve({ ok: false, blocked: "conflict", reason: r.reason });
        },
      );
    });
  }

  /** Revert entry `seq` and EVERYTHING newer (exact inverses, newest→oldest in APPLY order —
   *  rid order, not seq: provisional seqs can tie). Offline fallback for revertRangeServer. */
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

  /**
   * Server-authoritative, conflict-aware revert (M5): roll back MY ops from history entry
   * `seq` onward, KEEPING every peer's edits and stopping at any cell/object a peer has since
   * touched (the conflict boundary). The server appends the inverse as a forward batch and
   * broadcasts it — we apply it via the normal edit:opsApplied path. Returns how many of MY
   * ops rolled back + the boundary, for UI feedback. Offline / not-in-a-room falls back to the
   * client-computed revert (there all entries are mine, so it is equivalent).
   */
  function revertRangeServer(
    seq: number,
  ): Promise<{ ok: boolean; offline?: boolean; rejectedLeft?: boolean; revertedCount: number; conflictAt: { seq: number; keys: string[] } | null }> {
    const id = mapId.value;
    if (!connected.value || !id) {
      // SOLO (no room — leave() cleared any peer rows): local inverses are safe, nothing is
      // broadcast (sendOps is inert without `me`). Count ONLY rows with a captured inverse —
      // rows re-folded after a reload carry none, counting them would report a full revert
      // while silently leaving their edits applied.
      const inRange = history.value.filter((e) => e.seq >= seq);
      const applicable = inRange.filter((e) => (e.inverse?.length ?? 0) > 0);
      const ok = revertFrom(seq);
      return Promise.resolve({ ok, revertedCount: ok ? applicable.length : 0, conflictAt: null });
    }
    // IN A ROOM with a dead socket: refuse. The local fallback would revert PEERS' rows too
    // (history holds their inverses) — breaking the dialog's «чужие правки останутся» — and
    // edit.commit would BUFFER the broadcast to fire after the reconnect against a moved-on
    // log. The conflict-aware revert needs the server; the user retries after reconnecting.
    if (!getSocket().connected) {
      return Promise.resolve({ ok: false, offline: true, revertedCount: 0, conflictAt: null });
    }
    // Rejected rows exist only locally — the server's log never held them, so the range
    // revert cannot touch them; surface that instead of implying a full rollback.
    const rejectedLeft = history.value.some((e) => e.rejected && (e.inverse?.length ?? 0) > 0);
    // fromSeq is EXCLUSIVE server-side (reverts my ops with seq > fromSeq), so pass seq-1 to
    // include the clicked entry and everything newer.
    return new Promise((resolve) => {
      getSocket().timeout(REVERT_ACK_TIMEOUT_MS).emit("edit:revertRange", { mapId: id, fromSeq: seq - 1 }, (err, r) => {
        if (!err && r?.ok) resolve({ ok: true, revertedCount: r.revertedCount, conflictAt: r.conflictAt, rejectedLeft });
        else resolve({ ok: false, offline: !!err, revertedCount: 0, conflictAt: null });
      });
    });
  }

  /** Adopt a share link's channel for the given map (before it is opened/joined). */
  function setPendingShare(forMapId: string, chan: string): void {
    pendingShare = { mapId: forMapId, channel: chan };
  }

  /** Fold room-log entries into the live doc. Ops the journal already holds (matched by
   *  clientOpId == the op's journal uid) are NOT re-applied — but they DO get a history row:
   *  after a reload the whole log is journal-known, and skipping rows made my own earlier
   *  edits invisible to the dependents guard («только это» on an old row silently clobbered
   *  them). Re-folded rows carry no local inverse — the server-side revert handles those.
   *  A pending row of THIS session (ack lost, reconnect re-delivers the op) is CONFIRMED in
   *  place instead of duplicated. One conflicting entry must not abort the rest — it is
   *  reported and skipped (the old snapshot path crashed the whole join on the first conflict). */
  function foldEntries(
    entries: readonly { seq: number; by: string; author?: string; clientOpId: string; op: EditOp; batchId?: string }[],
  ): void {
    let failed = 0;
    let i = 0;
    while (i < entries.length) {
      const en = entries[i]!;
      lastSeq = Math.max(lastSeq, en.seq);
      // A batched commit's ops are consecutive in the log (appendBatch assigns them in a run):
      // fold the WHOLE run in one applyIncoming + one history row (not thousands of calls).
      if (en.batchId) {
        const bid = en.batchId;
        const run: typeof entries[number][] = [];
        while (i < entries.length && entries[i]!.batchId === bid) { run.push(entries[i]!); lastSeq = Math.max(lastSeq, entries[i]!.seq); i++; }
        for (const r of run) if (r.clientOpId) roomOpUids.add(r.clientOpId); // room log carries these
        const fresh = run.filter((r) => !(r.clientOpId && knownOpIds.has(r.clientOpId)));
        const mine = (run[0]!.author ?? "") === myClientId;
        if (fresh.length === 0) {
          const pendingRow = batchAgg.get(bid)?.entry;
          if (pendingRow) {
            pendingRow.seq = run[0]!.seq; // my in-flight batch whose ack was lost — confirm it
            pendingRow.acked = true;
          } else if (!run.some((r) => r.clientOpId && rowByUid.has(r.clientOpId))) {
            // journal-known from an EARLIER session / another tab: no re-apply, but the
            // dependents guard needs the row (keys + timeline position)
            recordBatchRow(run[0]!.seq, run[0]!.by, run.map((r) => r.op), [], bid, mine, { uids: run.map((r) => r.clientOpId) });
          }
          continue;
        }
        try {
          const inv = edit.applyIncoming(fresh.map((f) => f.op), fresh.map((f) => f.clientOpId));
          for (const f of fresh) if (f.clientOpId) knownOpIds.add(f.clientOpId);
          // keys/count from the FULL run: a partially-known batch must still cover all its keys.
          // A PARTIAL inverse (fresh ⊂ run) is dropped — locally applying it would half-revert
          // the commit while the row claims all of it; the server path reverts it whole.
          const rowInv = fresh.length === run.length ? inv : [];
          recordBatchRow(fresh[0]!.seq, run[0]!.by, run.map((r) => r.op), rowInv, bid, mine, { uids: run.map((r) => r.clientOpId) });
        } catch (err) {
          failed += fresh.length;
          // eslint-disable-next-line no-console
          console.error(`[collab] пакет из комнаты (batch ${bid}) не применился:`, err);
        }
        continue;
      }
      i++;
      if (en.clientOpId) roomOpUids.add(en.clientOpId); // room log carries this uid
      const mine = (en.author ?? "") === myClientId;
      if (en.clientOpId && knownOpIds.has(en.clientOpId)) {
        const row = rowByUid.get(en.clientOpId);
        if (row) {
          row.seq = en.seq; // my in-flight single whose ack was lost — confirm it
          row.acked = true;
        } else {
          record(en.seq, en.by, en.op, mine, [], { uid: en.clientOpId }); // journal-known: row for the guard
        }
        continue;
      }
      try {
        const inv = edit.applyIncoming([en.op], en.clientOpId ? [en.clientOpId] : undefined);
        if (en.clientOpId) knownOpIds.add(en.clientOpId);
        record(en.seq, en.by, en.op, mine, inv, { uid: en.clientOpId }); // singleton row
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
    roomOpUids = new Set(); // rebuilt from the ops:since catch-up below (for the pre-join draft filter)
    await new Promise<void>((resolve) => {
      socket.emit("room:join", { mapId: id, channel: chan, user: { name: userName.value } }, (r) => {
        if (!r.ok) {
          // eslint-disable-next-line no-console
          console.warn("[collab] join failed:", r.error);
          resolve();
          return;
        }
        me.value = r.you;
        idSlot.value = typeof r.slot === "number" ? r.slot : 0; // my disjoint id band (M4)
        peers.clear();
        for (const p of r.peers) peers.set(p.socketId, p);
        edit.setCollab(true, sendOps, idSlot.value);
        const serverHead = r.snapshotSeq;
        // Catch-up (fresh join AND reconnect): replay the room log as OPS with uid dedup —
        // never a snapshot. A snapshot doc already CONTAINS the results of ops sitting in
        // this journal (sent by an earlier session / another tab), so rebasing on it and
        // re-applying the journal double-applied them (addObject threw, the join died).
        const after = reconnect ? lastSeq : 0;
        if (!reconnect) lastSeq = serverHead;
        if (serverHead > after) {
          // resolve AFTER the fold so join()'s pre-join-draft offer sees the room's op log
          // (roomOpUids); always resolve even on !res.ok so a failed ops:since can't hang the join.
          socket.emit("ops:since", { mapId: id, afterSeq: after }, (res) => {
            if (res.ok) foldEntries(res.entries);
            resolve();
          });
          return;
        } else if (serverHead < after) {
          // Сервер перезапустился и потерял лог — мой журнал полнее. Принимаем новый отсчёт,
          // и если лог ПУСТ (0) — RE-SEED его моим журналом, чтобы гость/второй таб снова могли
          // догнать полное состояние (иначе шаринг отдаёт обрезанную карту). Только при head===0:
          // пустой лог гарантирует корректный порядок; частичный лог (>0) не трогаем.
          // Строки истории при этом СБРАСЫВАЕМ: их seq указывают в умерший лог — серверный
          // cherry-pick по такому seq попал бы в ЧУЖУЮ запись нового лога. Перезагрузка
          // страницы восстановит историю фолдом уже из нового лога.
          history.value = [];
          batchAgg.clear();
          rowByUid = new Map();
          lastSeq = serverHead;
          if (serverHead === 0) reseedRoom(id);
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
    rowByUid = new Map();
    await doJoin(id);
    offerPreJoinDraft(id);
  }

  /** Pre-join local draft reconciliation. Edits made before the socket joined the room (the
   *  editor is local-first: every op journals immediately, but broadcasts only once in a room)
   *  live only in my journal. roomOpUids — gathered in the catch-up fold — is what the room's
   *  log already carries; the rest of my journal is un-synced draft.
   *
   *  - Own room (my persistent private channel — a normal open, incl. my OTHER tab of the same
   *    map, or a rejoin after the room log was reset): silently reconcile via the chunked reseed
   *    pusher (no modal, no history-row spam, safe for a huge journal). It's my map, my room — a
   *    confirm is pure friction. Self-limiting: the next join folds these into roomOpUids, so the
   *    draft is then empty and nothing re-sends.
   *  - A share link into someone else's channel (?map=X&room=Y): my journal still holds my own
   *    private edits to map X, and silently pushing them would LEAK my local draft into their
   *    live session. That's a real decision, so ask first (once per room per session, and only
   *    when a peer is actually there to receive it).
   *  NOT on reconnects — doJoin from the reconnect handler bypasses this. */
  function offerPreJoinDraft(id: string): void {
    if (!connected.value || mapId.value !== id) return;
    const p = edit.project;
    if (!p || p.baseScenarioId !== id) return;
    // capture NOW: peer ops folding into the journal while the (possible) dialog is open must not
    // ride along. The uids ride along too — the room log must carry the SAME uids the journal
    // holds, or the next reload would re-apply the sent draft (the double-apply crash). Take ONLY
    // ops the room's log doesn't already carry (roomOpUids) — else a draft pushed in a PRIOR
    // session (still in my journal) is re-sent on every fresh join. Uid-less legacy ops (none
    // after ensureJournalUids) count as un-synced.
    const allDraft = activeOps(p);
    const allUids = activeOpUids(p);
    const draft: typeof allDraft = [];
    const draftUids: typeof allUids = [];
    for (let i = 0; i < allDraft.length; i++) {
      const u = allUids[i];
      if (!u || !roomOpUids.has(u)) { draft.push(allDraft[i]!); draftUids.push(u); }
    }
    if (!draft.length) return; // everything's already in the room — nothing to reconcile

    // My own room → silently reconcile via the chunked reseed pusher, no modal. getChannelId() is
    // this client's persistent private channel; a foreign channel only happens via a share link.
    // Skip the degraded "anonymous" channel (clientId.ts fallback when storage is blocked): there
    // getChannelId() collapses to a shared constant, so a foreign share-link room could masquerade
    // as "own" — fall through to the confirm instead of a silent push.
    const myChannel = getChannelId();
    if (channel.value === myChannel && myChannel !== "anonymous") {
      pushJournalToLog(id, draft, draftUids, "reconciling pre-join draft into own room");
      return;
    }

    // Foreign (share-link) room → asking guards against leaking my private draft into it.
    if (peers.size === 0) return; // no one there to receive it
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
        // Route through the SAME chunked pusher as the own-room path (NOT sendOps): it goes through
        // the server's idempotent appendBatch (confirming in two tabs can't duplicate lines), chunks
        // a large draft under MAX_BATCH, and records no local history rows. A draft is a bulk import
        // I already hold — seating revert rows on it is unnecessary, and an all-duplicate ack would
        // otherwise seat them on a phantom seq. Peers still receive the ops via the broadcast.
        if (pushJournalToLog(id, draft, draftUids, "sharing pre-join draft into room")) {
          ElMessage.success(`Черновик отправлен: участники теперь видят ваши правки (${draft.length})`);
        } else {
          ElMessage.warning("Синхронизация занята — попробуйте отправить черновик ещё раз через несколько секунд.");
        }
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
    rowByUid = new Map();
    lastSeq = 0;
    pending.value = 0;
    idSlot.value = 0; // back to solo band
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
    syncState,
    idSlot,
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
    dependentsOf,
    revertFrom,
    revertRangeServer,
  };
});
