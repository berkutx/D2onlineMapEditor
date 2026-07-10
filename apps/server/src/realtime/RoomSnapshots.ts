/**
 * RoomSnapshots — a materialised-document cache per room, so catch-up does not re-fold the
 * WHOLE op-log every time. The shared state of a room is `baseDoc + fold(all ops in seq
 * order)`; a room like the 144×144 maze accumulated ~90k ops, so folding the lot on every
 * `snapshot:request` is O(90k) each call. This keeps a cached `{ seq, doc }` (the HEAD it was
 * last built at) and, on the next request, folds ONLY the tail since that seq — O(new ops).
 *
 * Durability (phase 2): with a `dataDir` the cache is also PERSISTED as a gzipped snapshot
 * (`<sha1>.snap.<seq>.json.gz`, keep last 2). On first touch after a restart, `ensureLoaded`
 * seeds the in-memory cache from the newest valid snapshot → the first materialise folds only
 * the tail instead of the whole 90k log. Snapshots are DERIVED data: a missing/corrupt one
 * falls back to the previous file, then to a full fold from base — never authoritative.
 */

import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MapDocument } from "@d2/map-schema";
import { applyOps } from "@d2/map-edit";
import type { EditLog } from "./EditLog.js";

const gz = promisify(gzip);
const gunz = promisify(gunzip);

/** Refresh the in-memory cached snapshot once the head has advanced this many ops past it. */
const REFRESH_EVERY = 200;
/** Persist a new on-disk snapshot once the head has advanced this many ops past the last
 *  persisted one (much rarer than the in-memory refresh — disk writes are the expensive part). */
const PERSIST_EVERY = 2000;
/** Keep at most this many snapshot files per room (newest); older ones are pruned. */
const KEEP = 2;

interface Snapshot {
  seq: number;
  doc: MapDocument;
}

export class RoomSnapshots {
  private cache = new Map<string, Snapshot>();
  /** roomKey -> the last seq we PERSISTED to disk (throttles gz writes). */
  private persistedSeq = new Map<string, number>();
  /** roomKey -> idempotent lazy-load promise (seed cache from newest snapshot file). */
  private loads = new Map<string, Promise<void>>();
  /** roomKey -> in-flight snapshot write chain (serialised, off the hot path). */
  private writes = new Map<string, Promise<void>>();

  /** @param dataDir directory for durable gz snapshots; omit for pure in-memory (tests). */
  constructor(private readonly dataDir?: string) {}

  private base(roomKey: string): string {
    return createHash("sha1").update(roomKey).digest("hex");
  }

  /** Lazily seed the in-memory cache from the newest valid persisted snapshot (once per room).
   *  No-op without a dataDir or once loaded. Await before the first materialise of a room so a
   *  post-restart request folds only the tail, not the whole log. Corrupt files are skipped. */
  ensureLoaded(roomKey: string): Promise<void> {
    if (!this.dataDir || this.cache.has(roomKey)) return Promise.resolve();
    let p = this.loads.get(roomKey);
    if (!p) {
      p = this.load(roomKey);
      this.loads.set(roomKey, p);
    }
    return p;
  }

  private async load(roomKey: string): Promise<void> {
    const dir = this.dataDir!;
    const prefix = `${this.base(roomKey)}.snap.`;
    let files: string[];
    try {
      files = (await readdir(dir))
        .filter((f) => f.startsWith(prefix) && f.endsWith(".json.gz"))
        .sort((a, b) => seqOf(b) - seqOf(a)); // newest first
    } catch {
      return; // no dir yet
    }
    for (const f of files) {
      try {
        const raw = await readFile(join(dir, f));
        const doc = JSON.parse((await gunz(raw)).toString("utf8")) as MapDocument;
        const seq = seqOf(f);
        if (Number.isFinite(seq)) {
          this.cache.set(roomKey, { seq, doc });
          this.persistedSeq.set(roomKey, seq);
          return; // newest valid snapshot wins
        }
      } catch {
        /* corrupt/truncated snapshot — try the next-older one */
      }
    }
  }

  /**
   * The materialised document at the room's current HEAD, plus that head seq. Folds only the
   * ops appended since the cached snapshot (from `baseDoc` when there is no usable cache).
   * Advances the in-memory cache past REFRESH_EVERY, and persists a gz snapshot past
   * PERSIST_EVERY (off the hot path). Call `await ensureLoaded(roomKey)` first so a
   * post-restart materialise seeds from disk instead of re-folding the whole log.
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

    // advance the in-memory cache when the tail we just folded was large, or there was no cache.
    if (!cached || head - cached.seq >= REFRESH_EVERY) {
      this.cache.set(roomKey, { seq, doc });
    }
    // persist a durable snapshot far less often (disk writes are the cost); off the hot path.
    const lastPersisted = this.persistedSeq.get(roomKey) ?? 0;
    if (this.dataDir && seq - lastPersisted >= PERSIST_EVERY) {
      this.persistedSeq.set(roomKey, seq); // reserve now so we don't queue duplicate writes
      this.persist(roomKey, seq, doc);
    }
    return { seq, doc };
  }

  /** Write a gz snapshot (temp → atomic rename), then prune all but the newest KEEP files.
   *  Serialised per room; failures only warn (the snapshot is derived, the log is the truth). */
  private persist(roomKey: string, seq: number, doc: MapDocument): void {
    const dir = this.dataDir!;
    const prefix = `${this.base(roomKey)}.snap.`;
    const final = join(dir, `${prefix}${seq}.json.gz`);
    const tmp = `${final}.tmp`;
    const prev = this.writes.get(roomKey) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await mkdir(dir, { recursive: true });
        const buf = await gz(Buffer.from(JSON.stringify(doc), "utf8"));
        await writeFile(tmp, buf);
        // fsync the temp before rename so a crash can't leave a rename to torn bytes
        const h = await open(tmp, "r+");
        await h.datasync().catch(() => undefined);
        await h.close();
        await rename(tmp, final);
        // prune older snapshots, keep the newest KEEP
        const files = (await readdir(dir))
          .filter((f) => f.startsWith(prefix) && f.endsWith(".json.gz"))
          .sort((a, b) => seqOf(b) - seqOf(a));
        for (const f of files.slice(KEEP)) await unlink(join(dir, f)).catch(() => undefined);
      })
      .catch((err) => {
        // roll back the reservation so a later materialise retries the persist
        this.persistedSeq.delete(roomKey);
        // eslint-disable-next-line no-console
        console.error(`[RoomSnapshots] persist FAILED for ${roomKey}:`, (err as Error).message);
      });
    this.writes.set(roomKey, next);
  }

  /** Await pending snapshot writes (graceful shutdown / tests). */
  async flush(roomKey?: string): Promise<void> {
    if (roomKey) {
      await this.writes.get(roomKey);
      return;
    }
    await Promise.all([...this.writes.values()]);
  }

  /** Drop a room's cached snapshot from MEMORY (e.g. when its op-log is cleared/reset). The
   *  durable snapshot files are kept — a fresh ensureLoaded re-seeds from them. */
  clear(roomKey: string): void {
    this.cache.delete(roomKey);
    this.loads.delete(roomKey);
  }
}

/** Parse the trailing `<seq>` out of `<sha1>.snap.<seq>.json.gz`. */
function seqOf(file: string): number {
  const m = /\.snap\.(\d+)\.json\.gz$/.exec(file);
  return m ? Number(m[1]) : NaN;
}
