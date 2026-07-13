/**
 * EditLog — the server-authoritative, DURABLE, append-only edit history per room.
 *
 * The collaboration model: the server serialises every peer's EditOps into ONE ordered log
 * (per roomKey = `mapId#channel`). `seq` is a monotonic 1-based counter; applying the log's
 * ops to the base MapDocument in seq order yields the shared state. Conflict resolution is
 * last-writer-wins by seq (no OT/CRDT). Undo is modelled as appending an INVERSE op (git
 * revert), so the log never rewinds.
 *
 * Durability (M1): with a `dataDir`, each room's log is appended to `<dataDir>/<sha1>.jsonl`
 * (one LogEntry per line) and lazily loaded back on first access — so the SERVER is the
 * source of truth and survives a restart (no more clients re-seeding ~90k ops on reconnect).
 * The in-memory API stays synchronous; callers must `await ensureLoaded(key)` before the
 * first append/read of a room. Without a `dataDir` the log is pure in-memory (unit tests).
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { EditOp } from "@d2/socket-contract";

/** A batch COMMIT sentinel line: written after every multi-op batch append so a crash mid
 *  batch is detected on load (an uncommitted TAIL batch is dropped whole — all-or-nothing;
 *  the author re-sends unacked batches and journals dedupe by op uid). Single-op appends
 *  need no sentinel: one JSONL line is torn-or-whole by itself. */
interface CommitSentinel {
  commit: string; // the batchId
  n: number; // how many entries the batch wrote
}
const isSentinel = (v: unknown): v is CommitSentinel =>
  !!v && typeof (v as CommitSentinel).commit === "string" && typeof (v as CommitSentinel).n === "number";

/** How long dirty bytes may sit un-fsynced (group commit): the power-loss window. Process
 *  crashes lose nothing regardless (the OS holds the page cache); this timer only bounds
 *  KERNEL-level loss (power cut / host reset) without paying an fsync per brush op. */
const FSYNC_INTERVAL_MS = 200;

/** How often a degraded room re-attempts to flush its un-persisted tail. Degraded rooms reject new
 *  edits, so without a background retry a room that hit a transient disk error would stay degraded
 *  (and its acked-but-unwritten ops in limbo) until a restart. This lets it recover on its own.
 *  The interval backs off exponentially up to RETRY_MAX_MS while the disk stays dead, so a
 *  persistent outage doesn't churn the IO / error log every second. */
const RETRY_INTERVAL_MS = 1000;
const RETRY_MAX_MS = 30_000;

export interface LogEntry {
  /** 1-based monotonic sequence within the room's log. */
  seq: number;
  op: EditOp;
  /** socket id of the author (ephemeral — matches UserPresence.socketId for colour). */
  by: string;
  /** DURABLE author identity (the browser's clientId) — stable across reconnects, used for
   *  per-user attribution / rollback. Falls back to `by` when no clientId was provided. */
  author: string;
  /** the author's optimistic op id, echoed back so they can reconcile their pending op. */
  clientOpId: string;
  /** ops of one commit (stroke / generation) share this so clients collapse them into a
   *  single history row / undo unit. Absent for a standalone op. */
  batchId?: string;
  /** wall-clock ms when the server accepted it. */
  ts: number;
}

export class EditLog {
  private logs = new Map<string, LogEntry[]>();
  /** roomKey -> (clientOpId -> its entry): the idempotency index. Guarantees the log is an
   *  INJECTIVE set over clientOpId, so a re-sent batch (two tabs racing an empty room to reseed
   *  their shared-localStorage journal; a reconnect re-seed flap) never lands a DUPLICATE line.
   *  This matters because the server-side doc-rebuild folds (RoomSnapshots.materialize, the two
   *  revert handlers) apply the raw log via applyOps WITHOUT deduping by uid — a duplicate
   *  addObject line would throw "id already exists" there and permanently break revert/catch-up.
   *  Lazily rebuilt from the in-memory log; kept current by append/appendBatch; dropped on clear. */
  private seenIdx = new Map<string, Map<string, LogEntry>>();
  /** roomKey -> the in-flight/settled load promise (idempotent lazy load). */
  private loads = new Map<string, Promise<void>>();
  /** roomKey -> the serialized append-write chain (keeps disk lines in order). */
  private writes = new Map<string, Promise<void>>();
  /** roomKey -> open append FileHandle (group-commit fsync needs a handle, appendFile
   *  opens+closes per call and cannot fdatasync). Closed in clear()/flush(all). */
  private handles = new Map<string, FileHandle>();
  /** rooms with un-fsynced bytes; drained by the group-commit timer. */
  private dirty = new Set<string>();
  private fsyncTimer: ReturnType<typeof setTimeout> | undefined;
  /** roomKey -> JSONL bytes accepted into memory but NOT yet durably on disk. A failed write keeps
   *  its bytes here (never drops them into a disk gap); they are retried by the next persist and by
   *  the background retry timer until they land. A room stays degraded until its buffer drains. */
  private unpersisted = new Map<string, string>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = RETRY_INTERVAL_MS;
  /** rooms whose durability FAILED even after retries (disk full / IO dead): memory keeps
   *  serving reads, but callers must REJECT new edits — an ack without durability is a
   *  silent-divergence promise we refuse to make. */
  private degradedRooms = new Set<string>();

  /** @param dataDir directory for durable per-room JSONL logs; omit for pure in-memory. */
  constructor(private readonly dataDir?: string) {}

  /** True when the room's durable file stopped accepting writes — reject new edits. */
  isDegraded(roomKey: string): boolean {
    return this.degradedRooms.has(roomKey);
  }

  /** True while the room holds bytes accepted into memory but NOT yet durably on disk (a write is
   *  in flight, hung, or failed). The evictor must NOT drop such a room — clearing it would lose the
   *  un-written acked ops (and a later write-failure would strand the room permanently degraded).
   *  Covers the window a healthy-but-slow write opens that `isDegraded` (set only on failure) does
   *  not. */
  isFlushing(roomKey: string): boolean {
    return this.unpersisted.has(roomKey);
  }

  /** Count of degraded rooms (health route). */
  degradedCount(): number {
    return this.degradedRooms.size;
  }

  private file(roomKey: string): string {
    // hash the room key: it contains `#` and arbitrary channel text (filename-unsafe).
    return join(this.dataDir!, `${createHash("sha1").update(roomKey).digest("hex")}.jsonl`);
  }

  /** Lazily load a room's persisted log into memory (once). No-op without a dataDir or once
   *  loaded. MUST be awaited before the first append/read of a room so seqs continue the file
   *  instead of restarting at 1. Idempotent + concurrency-safe (one shared promise per room). */
  ensureLoaded(roomKey: string): Promise<void> {
    if (!this.dataDir) return Promise.resolve();
    let p = this.loads.get(roomKey);
    if (!p) {
      p = this.load(roomKey);
      this.loads.set(roomKey, p);
    }
    return p;
  }

  /** True iff this room must be async-loaded from disk before use (durable + not yet in
   *  memory). False without a dataDir or once loaded — callers take a synchronous fast path. */
  needsLoad(roomKey: string): boolean {
    return !!this.dataDir && !this.logs.has(roomKey);
  }

  private async load(roomKey: string): Promise<void> {
    if (this.logs.has(roomKey)) return; // already populated in-memory
    let text = "";
    try {
      text = await readFile(this.file(roomKey), "utf8");
    } catch {
      this.logs.set(roomKey, []); // no file yet = fresh room
      return;
    }
    const entries: LogEntry[] = [];
    // Batch atomicity on load: entries sharing a batchId accumulate in `pending` until their
    // COMMIT sentinel arrives; any non-batch line also flushes the buffer (mid-file sentinel
    // loss must not swallow later acked history). Only files that USE sentinels get the
    // all-or-nothing treatment — legacy files (written before sentinels) load as before.
    let sawSentinel = false;
    let pending: LogEntry[] = [];
    let pendingBatch: string | undefined;
    const acceptedIds = new Set<string>();
    const accept = (e: LogEntry): void => {
      // HEAL a legacy duplicate line: a log written before source-dedup (e.g. the pre-fix two-tab
      // reseed race) can hold two lines with the same clientOpId. Keep the FIRST, drop the rest —
      // otherwise the un-deduped doc-rebuild folds (materialize / revert / export) throw on the
      // duplicate addObject. Its seq becomes a preserved gap, which head/since already tolerate.
      if (e.clientOpId && acceptedIds.has(e.clientOpId)) return;
      if (e.clientOpId) acceptedIds.add(e.clientOpId);
      // PRESERVE the stored seq (clients recorded it in their journals). A single dropped
      // line must NOT renumber every later op — that would shift the whole `ops:since`
      // window and re-send/skip ops on catch-up. Only repair anomalies (NaN / non-monotonic)
      // so head/since stay strictly increasing; a genuine gap is kept as a gap.
      const prev = entries.length ? entries[entries.length - 1]!.seq : 0;
      if (typeof e.seq !== "number" || !Number.isFinite(e.seq) || e.seq <= prev) e.seq = prev + 1;
      entries.push(e);
    };
    const flushPending = (): void => {
      for (const e of pending) accept(e);
      pending = [];
      pendingBatch = undefined;
    };
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isSentinel(parsed)) {
          sawSentinel = true;
          if (pendingBatch === parsed.commit) flushPending();
          continue; // a stray sentinel (already flushed / unknown) is inert
        }
        const e = parsed as LogEntry;
        if (e.author === undefined) e.author = e.by; // legacy lines predate `author`
        if (e.batchId) {
          if (pendingBatch && pendingBatch !== e.batchId) flushPending(); // new batch closes the old
          pendingBatch = e.batchId;
          pending.push(e);
        } else {
          flushPending(); // a standalone op after an unclosed batch: keep the batch (mid-file)
          accept(e);
        }
      } catch {
        /* skip a partial/corrupt trailing line (crash mid-append) */
      }
    }
    // A TAIL batch without its sentinel = crash mid-batch → drop whole (all-or-nothing) —
    // but only in sentinel-era files; legacy files never wrote sentinels, keep their tail.
    // A 1-line tail is ALWAYS kept: single-op append() carries a batchId too (the v0.5
    // edit:op path) and never writes a sentinel — its one line is atomic by itself.
    if (pending.length && (!sawSentinel || pending.length === 1)) flushPending();
    else if (pending.length) {
      console.warn(
        `[EditLog] dropped an uncommitted tail batch (${pending.length} ops, crash mid-write) for ${roomKey}`,
      );
    }
    this.logs.set(roomKey, entries);
  }

  /** The room's open append handle (cached; reopened after clear()/close). */
  private async handle(roomKey: string): Promise<FileHandle> {
    let h = this.handles.get(roomKey);
    if (!h) {
      await mkdir(this.dataDir!, { recursive: true });
      h = await open(this.file(roomKey), "a");
      this.handles.set(roomKey, h);
    }
    return h;
  }

  /** handle.write with a couple of retries for transient failures (EMFILE/EBUSY/EIO), so a
   *  brief hiccup does not silently drop a durably-acked op. Throws after the last attempt.
   *  A failed attempt drops the cached handle (it may be poisoned) and reopens. */
  private async writeWithRetry(roomKey: string, lines: string, tries = 3): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const h = await this.handle(roomKey);
        await h.write(lines);
        return;
      } catch (err) {
        await this.closeHandle(roomKey);
        if (attempt >= tries) throw err;
        await new Promise((r) => setTimeout(r, 20 * attempt));
      }
    }
  }

  private async closeHandle(roomKey: string): Promise<void> {
    const h = this.handles.get(roomKey);
    if (!h) return;
    this.handles.delete(roomKey);
    try {
      await h.close();
    } catch {
      /* already broken */
    }
  }

  /** Group-commit: fdatasync every dirty room at most once per FSYNC_INTERVAL_MS. Bounds the
   *  POWER-LOSS window to ~200 ms without an fsync per brush op (process crashes lose nothing
   *  either way — the kernel owns the page cache). unref() keeps the timer from holding the
   *  process open. */
  private scheduleFsync(roomKey: string): void {
    this.dirty.add(roomKey);
    if (this.fsyncTimer) return;
    this.fsyncTimer = setTimeout(() => {
      this.fsyncTimer = undefined;
      const rooms = [...this.dirty];
      this.dirty.clear();
      for (const key of rooms) {
        // chain the sync AFTER any queued writes for that room
        const prev = this.writes.get(key) ?? Promise.resolve();
        const next = prev.then(async () => {
          const h = this.handles.get(key);
          if (h) await h.datasync().catch(() => undefined);
        });
        this.writes.set(key, next);
      }
    }, FSYNC_INTERVAL_MS);
    this.fsyncTimer.unref?.();
  }

  /** Accept `lines` for durable write. The bytes are held in `unpersisted` until a write actually
   *  LANDS: a failed write keeps them (and degrades the room) so they are retried by the next
   *  persist and by the background retry timer — never dropped into a disk GAP under a later
   *  successful write. The room is un-degraded only once its whole un-persisted tail is on disk, and
   *  RoomEvictor skips any room that isDegraded OR isFlushing (buffer non-empty), so it can never
   *  evict a room holding acked-but-unwritten ops, and a reload therefore never loses them. */
  private persist(roomKey: string, lines: string): void {
    if (!this.dataDir) return;
    this.unpersisted.set(roomKey, (this.unpersisted.get(roomKey) ?? "") + lines);
    this.flushRoom(roomKey);
  }

  /** Chain a write of the room's whole un-persisted buffer onto its serialized write queue. */
  private flushRoom(roomKey: string): void {
    const prev = this.writes.get(roomKey) ?? Promise.resolve();
    const next = prev.then(async () => {
      const toWrite = this.unpersisted.get(roomKey);
      if (!toWrite) return; // a coalesced earlier flush already wrote everything
      try {
        await this.writeWithRetry(roomKey, toWrite);
        // Remove exactly the prefix we wrote; bytes appended during the await stay for the next
        // flush (its own persist() chained one). If the buffer no longer STARTS with what we wrote
        // (the evictor now prevents this — a flushing room isn't cleared — but be defensive), KEEP
        // it rather than drop it: a re-written line is deduped on load() by clientOpId, so retrying
        // is always safe while dropping an acked op never is.
        const buf = this.unpersisted.get(roomKey) ?? "";
        const rest = buf.startsWith(toWrite) ? buf.slice(toWrite.length) : buf;
        if (rest) this.unpersisted.set(roomKey, rest);
        else this.unpersisted.delete(roomKey);
        this.scheduleFsync(roomKey);
        // Un-degrade ONLY when the whole tail is durable — a remaining buffer keeps the freeze until
        // a later flush lands it (so the room is never un-degraded with un-written ops).
        if (!this.unpersisted.has(roomKey)) this.degradedRooms.delete(roomKey);
        if (this.unpersisted.size === 0) this.retryDelay = RETRY_INTERVAL_MS; // disk healed → reset backoff
      } catch (err) {
        // Durability failed even after retries (disk full / IO dead). Memory keeps serving READS,
        // the bytes stay in `unpersisted` (retried by scheduleRetry when the disk heals), and the
        // room is DEGRADED so handlers REJECT new edits — acking an edit we cannot persist is a
        // silent-divergence promise we refuse to make. Log only on the healthy→degraded EDGE so a
        // persistently dead disk doesn't spam an error per room per retry.
        if (!this.degradedRooms.has(roomKey)) {
          console.error(`[EditLog] persist FAILED (room degraded, edits rejected) for ${roomKey}:`, (err as Error).message);
        }
        this.degradedRooms.add(roomKey);
        this.scheduleRetry();
      }
    });
    this.writes.set(roomKey, next);
  }

  /** While any room has an un-persisted tail, re-attempt to flush so a degraded room recovers on its
   *  own once the disk heals — without a new edit (it rejects those). The delay backs off
   *  exponentially (RETRY_INTERVAL_MS → RETRY_MAX_MS) so a persistent outage doesn't churn; it
   *  resets to the base on a successful drain. Self-stops when every buffer has drained. unref()
   *  keeps it from holding the process open. */
  private scheduleRetry(): void {
    if (this.retryTimer || this.unpersisted.size === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.unpersisted.size === 0) { this.retryDelay = RETRY_INTERVAL_MS; return; }
      for (const key of this.unpersisted.keys()) this.flushRoom(key);
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
      this.scheduleRetry();
    }, this.retryDelay);
    this.retryTimer.unref?.();
  }

  private mem(roomKey: string): LogEntry[] {
    let log = this.logs.get(roomKey);
    if (!log) {
      log = [];
      this.logs.set(roomKey, log);
    }
    return log;
  }

  /** The room's clientOpId→entry index, lazily built from the in-memory log (which load() has
   *  already populated before any append). Callers keep it current via append/appendBatch. */
  private seen(roomKey: string): Map<string, LogEntry> {
    let s = this.seenIdx.get(roomKey);
    if (!s) {
      s = new Map();
      for (const e of this.mem(roomKey)) if (e.clientOpId) s.set(e.clientOpId, e);
      this.seenIdx.set(roomKey, s);
    }
    return s;
  }

  /** The highest seq currently in memory for a room (0 = empty). Seq — NOT array length — so
   *  a preserved gap from a dropped line does not shift the client-facing sequence. */
  private lastSeq(log: LogEntry[]): number {
    return log.length ? log[log.length - 1]!.seq : 0;
  }

  /** Append an op and return its assigned entry (with the new seq). */
  append(
    roomKey: string,
    op: EditOp,
    by: string,
    clientOpId: string,
    ts: number,
    batchId?: string,
    author?: string,
  ): LogEntry {
    const log = this.mem(roomKey);
    const seen = this.seen(roomKey);
    // Idempotent, exactly like appendBatch: a re-sent single op (same clientOpId) is already logged
    // — return the EXISTING entry (its seq), never append a duplicate line. Keeps the log injective
    // over clientOpId on BOTH append paths, so the doc-rebuild folds (materialize / revert / export)
    // that apply the raw log without deduping never hit a duplicate addObject. The caller detects a
    // dedup hit (entry.seq <= headBefore) and skips the redundant re-broadcast.
    const dup = clientOpId ? seen.get(clientOpId) : undefined;
    if (dup) return dup;
    const entry: LogEntry = { seq: this.lastSeq(log) + 1, op, by, author: author ?? by, clientOpId, batchId, ts };
    log.push(entry);
    if (clientOpId) seen.set(clientOpId, entry);
    this.persist(roomKey, JSON.stringify(entry) + "\n");
    return entry;
  }

  /** Append MANY ops as one batch (shared batchId) and return their entries (in order).
   *  Each op still gets its own seq so LWW / catch-up work unchanged. A COMMIT sentinel line
   *  follows the batch: on load an uncommitted TAIL batch (crash mid-write) is dropped whole
   *  (all-or-nothing) instead of surviving as a silent prefix. */
  appendBatch(
    roomKey: string,
    ops: readonly { clientOpId: string; op: EditOp }[],
    by: string,
    batchId: string,
    ts: number,
    author?: string,
  ): LogEntry[] {
    const log = this.mem(roomKey);
    const seen = this.seen(roomKey);
    const entries: LogEntry[] = [];
    let seq = this.lastSeq(log);
    let lines = "";
    for (const { clientOpId, op } of ops) {
      // Idempotent: skip an op whose clientOpId is already in the log (a re-sent reconcile/reseed
      // batch — two tabs racing an empty room, a reconnect flap). Appending it again would put a
      // DUPLICATE addObject line in the durable log, which throws in the doc-rebuild folds that do
      // NOT dedup by uid (materialize / revert). Skipping keeps the log injective over clientOpId.
      // No seq is consumed for a skipped op, so kept seqs stay contiguous with prior appends.
      if (clientOpId && seen.has(clientOpId)) continue;
      const entry: LogEntry = { seq: ++seq, op, by, author: author ?? by, clientOpId, batchId, ts };
      log.push(entry);
      if (clientOpId) seen.set(clientOpId, entry);
      entries.push(entry);
      lines += JSON.stringify(entry) + "\n";
    }
    if (entries.length > 1) {
      const sentinel: CommitSentinel = { commit: batchId, n: entries.length };
      lines += JSON.stringify(sentinel) + "\n";
    }
    if (lines) this.persist(roomKey, lines); // all-duplicate batch → nothing new to write
    return entries;
  }

  /** The current head sequence (0 = empty / no edits yet) — the max seq, not the count. */
  head(roomKey: string): number {
    const log = this.logs.get(roomKey);
    return log ? this.lastSeq(log) : 0;
  }

  /** All entries (in seq order). */
  all(roomKey: string): readonly LogEntry[] {
    return this.logs.get(roomKey) ?? [];
  }

  /** Entries strictly after seq `seq` (for catch-up). Filters by the entry's SEQ (binary
   *  search on the ascending-seq array), not array index — correct even if the log has a
   *  preserved gap, so a reconnecting client never gets a shifted/wrong catch-up window. */
  since(roomKey: string, seq: number): LogEntry[] {
    const log = this.logs.get(roomKey);
    if (!log) return [];
    if (seq <= 0) return log.slice();
    let lo = 0;
    let hi = log.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (log[mid]!.seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return log.slice(lo);
  }

  /** Await pending disk writes + fdatasync (one room, or all). For graceful shutdown + tests.
   *  After a full flush every acked op is on stable storage — a SIGTERM redeploy loses zero. */
  async flush(roomKey?: string): Promise<void> {
    const sync = async (key: string): Promise<void> => {
      // A degraded room that healed just before shutdown still holds its tail in `unpersisted` with
      // only a background retry pending — issue one final flush so those acked bytes land instead of
      // dying with the process (else the "loses zero" contract breaks). If the disk is still dead
      // the write fails again and the bytes are unavoidably lost, same as before.
      if (this.unpersisted.has(key)) this.flushRoom(key);
      await this.writes.get(key);
      const h = this.handles.get(key);
      if (h) await h.datasync().catch(() => undefined);
    };
    if (roomKey) {
      await sync(roomKey);
      return;
    }
    const keys = new Set([...this.writes.keys(), ...this.unpersisted.keys()]);
    await Promise.all([...keys].map(sync));
  }

  /** Stop the background timers (retry + group-commit fsync) so the instance is quiescent. Call at
   *  graceful shutdown AFTER flush() (prod exits anyway; this matters for tests / embedding, where a
   *  lingering unref'd timer could otherwise re-touch the data dir). Does NOT drop `unpersisted` —
   *  flush() should have drained it; anything left was un-writable and is lost with the process. */
  dispose(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    if (this.fsyncTimer) { clearTimeout(this.fsyncTimer); this.fsyncTimer = undefined; }
  }

  /** Drop a room's log from MEMORY (e.g. when its room empties). The durable file is kept;
   *  the append handle is closed after its queued writes settle (reopened on next append). */
  clear(roomKey: string): void {
    this.logs.delete(roomKey);
    this.seenIdx.delete(roomKey); // rebuilt from the reloaded log on next access
    this.unpersisted.delete(roomKey); // evictor only clears non-degraded rooms → tail already drained
    this.loads.delete(roomKey);
    this.dirty.delete(roomKey);
    const prev = this.writes.get(roomKey) ?? Promise.resolve();
    void prev.then(() => this.closeHandle(roomKey));
  }
}
