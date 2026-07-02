/**
 * Map store: resolves opaque ids to real paths, parses `.sg` -> MapDocument via
 * @d2/sg-parser, and caches the result in an in-memory LRU keyed by id + mtime.
 * A changed mtime invalidates the cache entry; the ETag is derived from id+mtime
 * so the client can revalidate cheaply.
 *
 * The store owns the id->path registry (built by the scenario scanner) plus any
 * runtime-registered uploads.
 */

import { stat, readFile, writeFile, realpath, mkdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { parseScenario, type MapDocument } from "@d2/sg-parser";
import type { MapMeta } from "@d2/socket-contract";
import { config } from "../config.js";
import { idForPath } from "../ingest/idCodec.js";
import {
  scanScenarios,
  type ScenarioRecord,
  type ScanResult,
} from "../ingest/scenarioScanner.js";

interface CacheEntry {
  mtimeMs: number;
  etag: string;
  doc: MapDocument;
}

function etagFor(id: string, mtimeMs: number): string {
  const h = createHash("sha1")
    .update(id)
    .update(":")
    .update(String(Math.floor(mtimeMs)))
    .digest("hex")
    .slice(0, 16);
  return `"${h}"`;
}

/** On-disk shape of one uploads-registry entry (UPLOAD_DIR/registry.json). */
interface RegistryEntry {
  fileName: string;
  owner?: string;
  createdAt?: number;
  /** Temporary map (first-visit auto-clone) — swept after the TTL since lastAccess. */
  ephemeral?: boolean;
  lastAccess?: number;
}

/** Persist lastAccess at most this often (avoid a registry write on every map fetch). */
const TOUCH_THROTTLE_MS = 60 * 60 * 1000;

export class MapStore {
  /** id -> server-private record (real path, source, mtime). */
  private registry = new Map<string, ScenarioRecord>();
  /** Uploaded scenarios registered at runtime (kept across rescans). */
  private uploads: ScenarioRecord[] = [];
  /** LRU of parsed documents (insertion order = recency). */
  private cache = new Map<string, CacheEntry>();
  /** One-shot load of the persisted uploads registry (see loadUploads). */
  private uploadsLoaded = false;

  constructor(private readonly cacheMax = config.MAP_CACHE_MAX) {}

  /**
   * Restore runtime-registered uploads from UPLOAD_DIR/registry.json (written by
   * registerUpload). Without this, every uploaded/new map's id would 404 after a server
   * restart (dev tsx-watch reload, prod container redeploy): the files persist on the
   * volume but the in-memory list is gone and the scanner only walks SCENARIO_ROOTS.
   * Entries whose file has vanished are skipped silently.
   */
  private async loadUploads(): Promise<void> {
    if (this.uploadsLoaded) return;
    this.uploadsLoaded = true;
    let entries: RegistryEntry[];
    try {
      entries = JSON.parse(
        await readFile(join(config.UPLOAD_DIR, "registry.json"), "utf-8"),
      ) as RegistryEntry[];
    } catch {
      return; // no registry yet (fresh install) — nothing to restore
    }
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!e || typeof e.fileName !== "string") continue;
      try {
        const real = await realpath(join(config.UPLOAD_DIR, e.fileName));
        const st = await stat(real);
        const id = idForPath(real);
        if (this.uploads.some((u) => u.id === id)) continue;
        this.uploads.push({
          id,
          realPath: real,
          source: "upload",
          mtimeMs: st.mtimeMs,
          owner: typeof e.owner === "string" ? e.owner : undefined,
          ephemeral: e.ephemeral === true || undefined,
          lastAccessMs: typeof e.lastAccess === "number" ? e.lastAccess : e.createdAt,
        });
      } catch {
        continue; // file gone — drop from the effective registry
      }
    }
  }

  /** Persist the uploads registry (fileName + owner + TTL bookkeeping) next to the files. */
  private async saveUploads(): Promise<void> {
    const entries: RegistryEntry[] = this.uploads.map((u) => ({
      fileName: basename(u.realPath),
      owner: u.owner,
      createdAt: Math.floor(u.mtimeMs),
      ephemeral: u.ephemeral || undefined,
      lastAccess: u.lastAccessMs,
    }));
    try {
      await mkdir(config.UPLOAD_DIR, { recursive: true });
      await writeFile(
        join(config.UPLOAD_DIR, "registry.json"),
        JSON.stringify(entries, null, 2),
        "utf-8",
      );
    } catch {
      // persistence is best-effort; the in-memory registry still works this session
    }
  }

  /** Rescan the configured roots and refresh the id->path registry. */
  async refresh(): Promise<ScanResult> {
    await this.loadUploads();
    const result = await scanScenarios(config.SCENARIO_ROOTS, this.uploads);
    this.registry = result.registry;
    return result;
  }

  /** Latest scenario listing (rescans on every call — cheap, header-only). */
  async listScenarios() {
    const result = await this.refresh();
    return result.entries;
  }

  /** Register an uploaded `.sg` file (already written to disk). `owner` = the anonymous
   *  x-client-id of the creator, so listings can be scoped per visitor. `ephemeral` marks a
   *  temporary map (first-visit auto-clone) for the TTL sweeper. */
  async registerUpload(
    absPath: string,
    owner?: string,
    opts?: { ephemeral?: boolean },
  ): Promise<ScenarioRecord> {
    await this.loadUploads();
    const real = await realpath(absPath);
    const id = idForPath(real);
    const st = await stat(real);
    const rec: ScenarioRecord = {
      id,
      realPath: real,
      source: "upload",
      mtimeMs: st.mtimeMs,
      owner,
      ephemeral: opts?.ephemeral || undefined,
      lastAccessMs: Date.now(),
    };
    this.uploads = this.uploads.filter((u) => u.id !== id).concat(rec);
    this.registry.set(id, rec);
    await this.saveUploads();
    return rec;
  }

  /** Refresh an ephemeral record's TTL on access (persisted at most hourly). */
  private touchAccess(rec: ScenarioRecord): void {
    if (!rec.ephemeral) return;
    const now = Date.now();
    const prev = rec.lastAccessMs ?? 0;
    rec.lastAccessMs = now;
    if (now - prev > TOUCH_THROTTLE_MS) void this.saveUploads();
  }

  /**
   * Delete ephemeral uploads not accessed within `ttlMs` (the "temporary first-visit copy"
   * watcher): unlink the file, drop the registry entries. Returns how many were swept.
   */
  async sweepEphemeral(ttlMs: number): Promise<number> {
    await this.loadUploads();
    const cutoff = Date.now() - ttlMs;
    const expired = this.uploads.filter(
      (u) => u.ephemeral && (u.lastAccessMs ?? 0) < cutoff,
    );
    if (expired.length === 0) return 0;
    for (const u of expired) {
      try {
        await rm(u.realPath, { force: true });
      } catch {
        /* file already gone — still drop the record */
      }
      this.registry.delete(u.id);
      this.cache.delete(u.id);
    }
    const gone = new Set(expired.map((u) => u.id));
    this.uploads = this.uploads.filter((u) => !gone.has(u.id));
    await this.saveUploads();
    return expired.length;
  }

  /** Resolve an opaque id to its server-private record, rescanning if unknown. */
  async resolve(id: string): Promise<ScenarioRecord | undefined> {
    let rec = this.registry.get(id);
    if (!rec) {
      await this.refresh();
      rec = this.registry.get(id);
    }
    return rec;
  }

  /**
   * Load + parse the MapDocument for an id. Returns the doc and its ETag, using
   * the LRU when the file's mtime is unchanged. Returns undefined for unknown ids.
   */
  async getMap(
    id: string,
  ): Promise<{ doc: MapDocument; etag: string; mtimeMs: number } | undefined> {
    const rec = await this.resolve(id);
    if (!rec) return undefined;
    this.touchAccess(rec); // any use refreshes an ephemeral copy's TTL

    const st = await stat(rec.realPath);
    const cached = this.cache.get(id);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      this.touch(id, cached);
      return { doc: cached.doc, etag: cached.etag, mtimeMs: st.mtimeMs };
    }

    const buf = new Uint8Array(await readFile(rec.realPath));
    const doc = parseScenario(buf);
    const etag = etagFor(id, st.mtimeMs);
    const entry: CacheEntry = { mtimeMs: st.mtimeMs, etag, doc };
    this.put(id, entry);
    return { doc, etag, mtimeMs: st.mtimeMs };
  }

  /**
   * Read the original `.sg` bytes for an id (the editor's patch base). Not cached
   * — the writer needs a fresh, unparsed buffer. Returns undefined for unknown ids.
   */
  async getRawBytes(
    id: string,
  ): Promise<{ bytes: Uint8Array; etag: string; mtimeMs: number } | undefined> {
    const rec = await this.resolve(id);
    if (!rec) return undefined;
    this.touchAccess(rec); // any use refreshes an ephemeral copy's TTL
    const st = await stat(rec.realPath);
    const bytes = new Uint8Array(await readFile(rec.realPath));
    return { bytes, etag: etagFor(id, st.mtimeMs), mtimeMs: st.mtimeMs };
  }

  /** Cheap header-derived meta for an id (uses the full parse cache if warm). */
  async getMeta(id: string): Promise<MapMeta | undefined> {
    const loaded = await this.getMap(id);
    if (!loaded) return undefined;
    const { doc } = loaded;
    return {
      id,
      name: doc.header.name,
      size: doc.size,
      players: doc.players.length,
      version: doc.header.version,
      description: doc.header.description ?? "",
    };
  }

  /** Compute the ETag for an id without forcing a parse (for revalidation). */
  async etagFor(id: string): Promise<string | undefined> {
    const rec = await this.resolve(id);
    if (!rec) return undefined;
    try {
      const st = await stat(rec.realPath);
      return etagFor(id, st.mtimeMs);
    } catch {
      return undefined;
    }
  }

  // --- tiny LRU ---------------------------------------------------------
  private touch(id: string, entry: CacheEntry): void {
    this.cache.delete(id);
    this.cache.set(id, entry);
  }

  private put(id: string, entry: CacheEntry): void {
    this.cache.delete(id);
    this.cache.set(id, entry);
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
