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
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EditOp } from "@d2/socket-contract";

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
  /** roomKey -> the in-flight/settled load promise (idempotent lazy load). */
  private loads = new Map<string, Promise<void>>();
  /** roomKey -> the serialized append-write chain (keeps disk lines in order). */
  private writes = new Map<string, Promise<void>>();

  /** @param dataDir directory for durable per-room JSONL logs; omit for pure in-memory. */
  constructor(private readonly dataDir?: string) {}

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
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as LogEntry;
        if (e.author === undefined) e.author = e.by; // legacy lines predate `author`
        // PRESERVE the stored seq (clients recorded it in their journals). A single dropped
        // line must NOT renumber every later op — that would shift the whole `ops:since`
        // window and re-send/skip ops on catch-up. Only repair anomalies (NaN / non-monotonic)
        // so head/since stay strictly increasing; a genuine gap is kept as a gap.
        const prev = entries.length ? entries[entries.length - 1]!.seq : 0;
        if (typeof e.seq !== "number" || !Number.isFinite(e.seq) || e.seq <= prev) e.seq = prev + 1;
        entries.push(e);
      } catch {
        /* skip a partial/corrupt trailing line (crash mid-append) */
      }
    }
    this.logs.set(roomKey, entries);
  }

  /** appendFile with a couple of retries for transient failures (EMFILE/EBUSY/EIO), so a
   *  brief hiccup does not silently drop a durably-acked op. Throws after the last attempt. */
  private async writeWithRetry(path: string, lines: string, tries = 3): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await appendFile(path, lines);
        return;
      } catch (err) {
        if (attempt >= tries) throw err;
        await new Promise((r) => setTimeout(r, 20 * attempt));
      }
    }
  }

  /** Append entries' JSONL to disk, serialized per room (no interleaving), with retry. */
  private persist(roomKey: string, lines: string): void {
    if (!this.dataDir) return;
    const prev = this.writes.get(roomKey) ?? Promise.resolve();
    const next = prev
      .then(() => mkdir(this.dataDir!, { recursive: true }))
      .then(() => this.writeWithRetry(this.file(roomKey), lines))
      .catch((err) => {
        // last-resort: durability failed even after retries. Surface loudly; memory keeps
        // serving (a fresh append will still assign the next seq — see the seq-preserving
        // load, which keeps this from cascading into a whole-log renumber).
        console.error(`[EditLog] persist FAILED (op(s) not durable) for ${roomKey}:`, (err as Error).message);
      });
    this.writes.set(roomKey, next);
  }

  private mem(roomKey: string): LogEntry[] {
    let log = this.logs.get(roomKey);
    if (!log) {
      log = [];
      this.logs.set(roomKey, log);
    }
    return log;
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
    const entry: LogEntry = { seq: this.lastSeq(log) + 1, op, by, author: author ?? by, clientOpId, batchId, ts };
    log.push(entry);
    this.persist(roomKey, JSON.stringify(entry) + "\n");
    return entry;
  }

  /** Append MANY ops as one batch (shared batchId) and return their entries (in order).
   *  Each op still gets its own seq so LWW / catch-up work unchanged.
   *  KNOWN LIMIT: the batch is one appendFile, which is NOT crash-atomic — a power-loss mid
   *  write can leave a PREFIX of a large batch (the torn trailing line is skipped on load, but
   *  earlier complete lines survive as a short batch). Planned restarts flush cleanly; a future
   *  hardening (M2+) can add a per-batch commit marker to make batches all-or-nothing. */
  appendBatch(
    roomKey: string,
    ops: readonly { clientOpId: string; op: EditOp }[],
    by: string,
    batchId: string,
    ts: number,
    author?: string,
  ): LogEntry[] {
    const log = this.mem(roomKey);
    const entries: LogEntry[] = [];
    let seq = this.lastSeq(log);
    let lines = "";
    for (const { clientOpId, op } of ops) {
      const entry: LogEntry = { seq: ++seq, op, by, author: author ?? by, clientOpId, batchId, ts };
      log.push(entry);
      entries.push(entry);
      lines += JSON.stringify(entry) + "\n";
    }
    this.persist(roomKey, lines);
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

  /** Await pending disk writes (one room, or all). For graceful shutdown + tests. */
  async flush(roomKey?: string): Promise<void> {
    if (roomKey) {
      await this.writes.get(roomKey);
      return;
    }
    await Promise.all([...this.writes.values()]);
  }

  /** Drop a room's log from MEMORY (e.g. when its room empties). The durable file is kept. */
  clear(roomKey: string): void {
    this.logs.delete(roomKey);
    this.loads.delete(roomKey);
  }
}
