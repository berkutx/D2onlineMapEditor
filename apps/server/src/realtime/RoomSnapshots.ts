/**
 * RoomSnapshots — a materialised-document cache per room, so catch-up does not re-fold the
 * WHOLE op-log every time. The shared state of a room is `baseDoc + fold(all ops in seq
 * order)`; a room like the 144×144 maze accumulated ~90k ops, so folding the lot on every
 * `snapshot:request` is O(90k) each call. This keeps a cached `{ seq, doc }` (the HEAD it was
 * last built at) and, on the next request, folds ONLY the tail since that seq — O(new ops).
 *
 * In-memory + derived (not persisted): losing the cache on restart just means the first
 * request after boot re-folds from base once. The SAME materialisation is what M5 (revert
 * re-simulation) and M6 ("выкачать промежуток" — export at a seq) build on.
 */

import type { MapDocument } from "@d2/map-schema";
import { applyOps } from "@d2/map-edit";
import type { EditLog } from "./EditLog.js";

/** Refresh the cached snapshot once the head has advanced this many ops past it. */
const REFRESH_EVERY = 200;

interface Snapshot {
  seq: number;
  doc: MapDocument;
}

export class RoomSnapshots {
  private cache = new Map<string, Snapshot>();

  /**
   * The materialised document at the room's current HEAD, plus that head seq. Folds only the
   * ops appended since the cached snapshot (from `baseDoc` when there is no usable cache).
   * Advances + stores the cache once the tail grows past REFRESH_EVERY.
   */
  materialize(roomKey: string, baseDoc: MapDocument, log: EditLog): Snapshot {
    const head = log.head(roomKey);
    const cached = this.cache.get(roomKey);

    let seq: number;
    let doc: MapDocument;
    if (cached && cached.seq <= head) {
      // fold only the tail (ops with seq > cached.seq) onto the cached doc
      const tail = log.since(roomKey, cached.seq);
      doc = tail.length ? applyOps(cached.doc, tail.map((e) => e.op)) : cached.doc;
      seq = head;
    } else {
      // no cache (or a stale one past head, e.g. after a clear) → fold the whole log from base
      doc = applyOps(baseDoc, log.all(roomKey).map((e) => e.op));
      seq = head;
    }

    // advance the cache when the tail we just folded was large, or there was no cache yet.
    if (!cached || head - cached.seq >= REFRESH_EVERY) {
      this.cache.set(roomKey, { seq, doc });
    }
    return { seq, doc };
  }

  /** Drop a room's cached snapshot (e.g. when its op-log is cleared/reset). */
  clear(roomKey: string): void {
    this.cache.delete(roomKey);
  }
}
