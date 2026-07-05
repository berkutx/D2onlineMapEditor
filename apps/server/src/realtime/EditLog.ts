/**
 * EditLog — the server-authoritative, append-only edit history per map (= per room).
 *
 * The collaboration model: the server serialises every peer's
 * EditOps into ONE ordered log. `seq` is a monotonic 1-based counter; applying the log's
 * ops to the base MapDocument in seq order yields the shared state. Conflict resolution
 * is last-writer-wins by seq (no OT/CRDT) — later ops simply overwrite earlier ones, which
 * the single ordered log gives for free. Undo is modelled as appending an INVERSE op (the
 * client emits it), so the log never rewinds.
 *
 * In-memory and per-process (Stage-4 scope): a room's log lives only while someone is in
 * it, seeded lazily from the base map. Export still goes through the REST writer/validator.
 */

import type { EditOp } from "@d2/socket-contract";

export interface LogEntry {
  /** 1-based monotonic sequence within the map's log. */
  seq: number;
  op: EditOp;
  /** socket id of the author (matches UserPresence.socketId for colour/attribution). */
  by: string;
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

  /** Append an op and return its assigned entry (with the new seq). */
  append(mapId: string, op: EditOp, by: string, clientOpId: string, ts: number, batchId?: string): LogEntry {
    let log = this.logs.get(mapId);
    if (!log) {
      log = [];
      this.logs.set(mapId, log);
    }
    const entry: LogEntry = { seq: log.length + 1, op, by, clientOpId, batchId, ts };
    log.push(entry);
    return entry;
  }

  /** Append MANY ops as one batch (shared batchId) and return their entries (in order).
   *  Each op still gets its own seq so LWW / catch-up work unchanged. */
  appendBatch(
    mapId: string,
    ops: readonly { clientOpId: string; op: EditOp }[],
    by: string,
    batchId: string,
    ts: number,
  ): LogEntry[] {
    let log = this.logs.get(mapId);
    if (!log) {
      log = [];
      this.logs.set(mapId, log);
    }
    const entries: LogEntry[] = [];
    for (const { clientOpId, op } of ops) {
      const entry: LogEntry = { seq: log.length + 1, op, by, clientOpId, batchId, ts };
      log.push(entry);
      entries.push(entry);
    }
    return entries;
  }

  /** The current head sequence (0 = empty / no edits yet). */
  head(mapId: string): number {
    return this.logs.get(mapId)?.length ?? 0;
  }

  /** All entries (in seq order). */
  all(mapId: string): readonly LogEntry[] {
    return this.logs.get(mapId) ?? [];
  }

  /** Entries strictly after `seq` (for catch-up after a reconnect). */
  since(mapId: string, seq: number): LogEntry[] {
    const log = this.logs.get(mapId);
    if (!log) return [];
    return seq <= 0 ? log.slice() : log.slice(seq);
  }

  /** Drop a map's log (e.g. when its room empties — optional housekeeping). */
  clear(mapId: string): void {
    this.logs.delete(mapId);
  }
}
