/**
 * RoomEvictor — frees an EMPTY room's op-log + snapshot from MEMORY after a grace delay.
 *
 * The durable log (var/rooms/*.jsonl) is the source of truth, but every room ever touched
 * kept its parsed entries + materialised doc in RAM for the process lifetime (a 90k-op room
 * is ~50-100 MB; 100 rooms would exhaust the box). This evicts a room once its last member
 * leaves — but only after a grace window, so a brief socket flap (CF-tunnel blip, reload)
 * that empties then re-fills the room does NOT thrash a re-read of the whole log. A rejoin
 * cancels the pending eviction. The next real join lazily reloads from disk (ensureLoaded).
 */

import type { RoomManager } from "./RoomManager.js";
import type { EditLog } from "./EditLog.js";
import type { RoomSnapshots } from "./RoomSnapshots.js";

export class RoomEvictor {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly rooms: RoomManager,
    private readonly log: EditLog,
    private readonly snapshots: RoomSnapshots | undefined,
    private readonly delayMs: number,
  ) {}

  /** A (re)join to `roomKey` cancels any pending eviction — the room is live again. */
  cancel(roomKey: string): void {
    const t = this.timers.get(roomKey);
    if (t) {
      clearTimeout(t);
      this.timers.delete(roomKey);
    }
  }

  /** The room emptied — schedule its RAM eviction after the grace window (idempotent: a
   *  second schedule replaces the timer). Double-checks emptiness at fire time. */
  schedule(roomKey: string): void {
    this.cancel(roomKey);
    const t = setTimeout(() => {
      this.timers.delete(roomKey);
      if (this.rooms.hasMembers(roomKey)) return; // someone rejoined in the window
      // A DEGRADED room's in-memory tail is the ONLY copy of ops the disk refused (disk full /
      // IO dead) — evicting + reloading from disk would silently lose them. Keep it in RAM (a
      // degraded room is rare and the box is already unhealthy; a small leak beats data loss).
      if (this.log.isDegraded(roomKey)) return;
      this.log.clear(roomKey); // drop parsed entries; the durable .jsonl stays
      this.snapshots?.clear(roomKey);
    }, this.delayMs);
    t.unref?.(); // don't keep the process alive for a pending eviction
    this.timers.set(roomKey, t);
  }

  /** Cancel every pending eviction (graceful shutdown / tests). */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
