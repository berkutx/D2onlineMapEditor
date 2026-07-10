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
import { activeOps, activeOpUids, allOpUids, opKeys } from "@d2/map-edit";
import { getSocket } from "../realtime/socket";
import { getChannelId } from "../services/clientId";
import { useEditStore } from "./editStore";
import { useDecorStore } from "./decorStore";

const NAME_KEY = "d2.collab.name";

/** A later history entry that blocks a cherry-pick revert (touches the same keys). */
export type RevertDependent = { seq: number; byName: string; mine: boolean; summary: string };

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

  /** Record a WHOLE batched commit as ONE history row (I have every op + inverse at once —
   *  from my own send, a peer's edit:opsApplied, or a catch-up run). `inverse` is newest-first
   *  so a single revert undoes the whole commit. */
  function recordBatchRow(
    seq: number, by: string, ops: readonly EditOp[], inverse: EditOp[] | undefined, batchId: string, mine: boolean,
  ): HistoryEntry {
    const ctx = opCtx();
    const entry: HistoryEntry = {
      seq, by, byName: nameOf(by), byColor: colorOf(by),
      op: ops[0]!, summary: summarizeBatch(ops, ctx), detail: detailBatch(ops),
      mine, inverse: inverse ?? [], batchId, count: ops.length,
    };
    batchAgg.set(batchId, { entry, count: ops.length }); // a stray later op merges, not dups
    history.value = [...history.value, entry];
    return entry;
  }

  function bindListeners(): void {
    if (listenersBound) return;
    listenersBound = true;
    const socket = getSocket();
    (window as unknown as { __d2socket?: unknown }).__d2socket = socket; // debug hook (inspect emits)

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

    // A peer's WHOLE batched commit (see edit:ops) — apply every op in ONE pass and record
    // ONE history row. This is the receive side of the per-tile-flood fix.
    socket.on("edit:opsApplied", ({ batchId, by, ops }) => {
      for (const o of ops) lastSeq = Math.max(lastSeq, o.seq);
      const fresh = ops.filter((o) => !(o.clientOpId && knownOpIds.has(o.clientOpId))); // skip 2nd-tab dups
      if (fresh.length === 0) return;
      try {
        const inv = edit.applyIncoming(fresh.map((f) => f.op), fresh.map((f) => f.clientOpId)); // ONE apply pass
        for (const f of fresh) if (f.clientOpId) knownOpIds.add(f.clientOpId);
        recordBatchRow(fresh[0]!.seq, by, fresh.map((f) => f.op), inv, batchId, false);
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

  /** The outgoing hook editStore calls on every local commit / undo / redo.
   *  `inverses[i]` (captured at apply time) rides into the history entry of ops[i];
   *  `uids[i]` is ops[i]'s journal-persisted uid, sent as clientOpId. */
  function sendOps(ops: readonly EditOp[], inverses?: EditOp[][], uids?: readonly string[]): void {
    const id = mapId.value;
    const socket = getSocket();
    if (!id || !me.value || ops.length === 0) return;
    const meId = me.value.socketId;

    // Single op → one edit:op message + its own history row (unchanged).
    if (ops.length === 1) {
      const op = ops[0]!;
      const clientOpId = uids?.[0] || `${meId}:${opCounter++}`;
      knownOpIds.add(clientOpId);
      const inverse = inverses?.[0];
      pending.value++;
      socket.emit("edit:op", { mapId: id, clientOpId, baseSeq: lastSeq, op }, (ack) => {
        pending.value = Math.max(0, pending.value - 1);
        if (ack.ok && typeof ack.seq === "number") { lastSeq = Math.max(lastSeq, ack.seq); record(ack.seq, meId, op, true, inverse); }
        else console.warn("[collab] op rejected:", ack.reason); // eslint-disable-line no-console
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
    const entry = recordBatchRow(lastSeq + 1, meId, ops, flatInverse, batchId, true);
    pending.value++;
    socket.emit("edit:ops", { mapId: id, batchId, baseSeq: lastSeq, ops: opsWithIds }, (ack) => {
      pending.value = Math.max(0, pending.value - 1);
      if (ack.ok) { lastSeq = Math.max(lastSeq, ack.seqEnd); entry.seq = ack.seqStart; }
      else console.warn("[collab] batch rejected:", ack.reason); // eslint-disable-line no-console
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
  let reseedInFlight = false; // reconnect can flap several times — re-seed at most ONCE per loss
  function reseedRoom(id: string): void {
    const socket = getSocket();
    const p = edit.project;
    if (reseedInFlight || !socket || !me.value || !p) return;
    const ops = activeOps(p);
    const uids = activeOpUids(p);
    if (ops.length === 0) return;
    reseedInFlight = true;
    window.setTimeout(() => { reseedInFlight = false; }, 30_000); // safety release
    const meId = me.value.socketId;
    // eslint-disable-next-line no-console
    console.info(`[collab] re-seeding room log from journal (${ops.length} ops) after server restart`);
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
        else console.warn("[collab] re-seed chunk rejected:", ack.reason); // eslint-disable-line no-console
        if (--pending === 0) reseedInFlight = false;
      });
    }
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

  /** Every cell/object key an entry touches: its representative op + ALL batch inverses
   *  (each real op's inverse targets the same keys, so the union covers the whole batch). */
  function entryKeys(e: HistoryEntry): Set<string> {
    const ks = new Set(opKeys(e.op));
    for (const inv of e.inverse ?? []) for (const k of opKeys(inv)) ks.add(k);
    return ks;
  }

  /**
   * «Зависимые далее по цепочке»: LATER history entries touching the same cells/objects as
   * entry `seq`. A cherry-pick revert («только это») is only safe when this is EMPTY —
   * otherwise applying the old inverse would silently clobber the newer edits (patch/move),
   * or structurally break (delete/re-add). Same key notion as the server's M5 conflict
   * boundary (opKeys).
   */
  function dependentsOf(seq: number): RevertDependent[] {
    const entry = history.value.find((e) => e.seq === seq);
    if (!entry) return [];
    const keys = entryKeys(entry);
    const out: RevertDependent[] = [];
    for (const e of history.value) {
      if (e.seq <= seq) continue;
      for (const k of entryKeys(e)) {
        if (keys.has(k)) {
          out.push({ seq: e.seq, byName: e.byName, mine: e.mine, summary: e.summary });
          break;
        }
      }
    }
    return out;
  }

  /** Objects the entry's revert would DELETE (its inverse contains deleteObject) that are
   *  still referenced from elsewhere in the live doc (events / a city's visiting stack) —
   *  the indirect dependency a key-intersection can't see. */
  function revertDanglingRefs(seq: number): string[] {
    const entry = history.value.find((e) => e.seq === seq);
    if (!entry) return [];
    const doc = edit.liveDoc;
    if (!doc) return [];
    const out: string[] = [];
    for (const inv of entry.inverse ?? []) {
      if (inv.kind !== "deleteObject") continue;
      const id = inv.id;
      const inEvents = (doc.events ?? []).some((ev) =>
        JSON.stringify(ev.conditions).includes(`"${id}"`) || JSON.stringify(ev.effects).includes(`"${id}"`),
      );
      const asVisitor = doc.objects.some(
        (o) => (o as { stackRef?: string }).stackRef === id,
      );
      if (inEvents || asVisitor) out.push(id);
    }
    return out;
  }

  /** Revert ONE entry — ONLY when nothing later depends on it («вырывать» середину цепочки
   *  нельзя: поздние правки тех же клеток/объектов перезатёрлись бы молча). The result says
   *  WHY when blocked, so the UI can point at the dependents / suggest «откатить моё отсюда». */
  function revertOne(seq: number): { ok: boolean; blocked?: "dependents" | "refs" | "conflict"; dependents?: RevertDependent[]; refs?: string[] } {
    const entry = history.value.find((e) => e.seq === seq);
    if (!entry) return { ok: false, blocked: "conflict" };
    const deps = dependentsOf(seq);
    if (deps.length) return { ok: false, blocked: "dependents", dependents: deps };
    const refs = revertDanglingRefs(seq);
    if (refs.length) return { ok: false, blocked: "refs", refs };
    const ok = applyRevert(inversesOf([entry]), `#${seq}`);
    return ok ? { ok: true } : { ok: false, blocked: "conflict" };
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
  ): Promise<{ ok: boolean; revertedCount: number; conflictAt: { seq: number; keys: string[] } | null }> {
    const id = mapId.value;
    if (!connected.value || !id) {
      const n = history.value.filter((e) => e.seq >= seq).length;
      return Promise.resolve({ ok: revertFrom(seq), revertedCount: n, conflictAt: null });
    }
    // fromSeq is EXCLUSIVE server-side (reverts my ops with seq > fromSeq), so pass seq-1 to
    // include the clicked entry and everything newer.
    return new Promise((resolve) => {
      getSocket().emit("edit:revertRange", { mapId: id, fromSeq: seq - 1 }, (r) => {
        if (r.ok) resolve({ ok: true, revertedCount: r.revertedCount, conflictAt: r.conflictAt });
        else resolve({ ok: false, revertedCount: 0, conflictAt: null });
      });
    });
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
        const fresh = run.filter((r) => !(r.clientOpId && knownOpIds.has(r.clientOpId)));
        if (fresh.length === 0) continue;
        try {
          const inv = edit.applyIncoming(fresh.map((f) => f.op), fresh.map((f) => f.clientOpId));
          for (const f of fresh) if (f.clientOpId) knownOpIds.add(f.clientOpId);
          recordBatchRow(fresh[0]!.seq, fresh[0]!.by, fresh.map((f) => f.op), inv, bid, false);
        } catch (err) {
          failed += fresh.length;
          // eslint-disable-next-line no-console
          console.error(`[collab] пакет из комнаты (batch ${bid}) не применился:`, err);
        }
        continue;
      }
      i++;
      if (en.clientOpId && knownOpIds.has(en.clientOpId)) continue; // уже в журнале (мой / другой таб)
      try {
        const inv = edit.applyIncoming([en.op], en.clientOpId ? [en.clientOpId] : undefined);
        if (en.clientOpId) knownOpIds.add(en.clientOpId);
        record(en.seq, en.by, en.op, false, inv); // singleton row
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
          socket.emit("ops:since", { mapId: id, afterSeq: after }, (res) => {
            if (res.ok) foldEntries(res.entries);
          });
        } else if (serverHead < after) {
          // Сервер перезапустился и потерял лог — мой журнал полнее. Принимаем новый отсчёт,
          // и если лог ПУСТ (0) — RE-SEED его моим журналом, чтобы гость/второй таб снова могли
          // догнать полное состояние (иначе шаринг отдаёт обрезанную карту). Только при head===0:
          // пустой лог гарантирует корректный порядок; частичный лог (>0) не трогаем.
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
