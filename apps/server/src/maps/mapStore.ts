/**
 * Map store: resolves opaque ids to real paths, parses `.sg` -> MapDocument via
 * @d2/sg-parser, and caches the result in an in-memory LRU keyed by id + mtime.
 * A changed mtime invalidates the cache entry; the ETag is derived from id+mtime
 * so the client can revalidate cheaply.
 *
 * The store owns the id->path registry (built by the scenario scanner) plus any
 * runtime-registered uploads.
 */

import { stat, readFile, realpath } from "node:fs/promises";
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

export class MapStore {
  /** id -> server-private record (real path, source, mtime). */
  private registry = new Map<string, ScenarioRecord>();
  /** Uploaded scenarios registered at runtime (kept across rescans). */
  private uploads: ScenarioRecord[] = [];
  /** LRU of parsed documents (insertion order = recency). */
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly cacheMax = config.MAP_CACHE_MAX) {}

  /** Rescan the configured roots and refresh the id->path registry. */
  async refresh(): Promise<ScanResult> {
    const result = await scanScenarios(config.SCENARIO_ROOTS, this.uploads);
    this.registry = result.registry;
    return result;
  }

  /** Latest scenario listing (rescans on every call — cheap, header-only). */
  async listScenarios() {
    const result = await this.refresh();
    return result.entries;
  }

  /** Register an uploaded `.sg` file (already written to disk). */
  async registerUpload(absPath: string): Promise<ScenarioRecord> {
    const real = await realpath(absPath);
    const id = idForPath(real);
    const st = await stat(real);
    const rec: ScenarioRecord = {
      id,
      realPath: real,
      source: "upload",
      mtimeMs: st.mtimeMs,
    };
    this.uploads = this.uploads.filter((u) => u.id !== id).concat(rec);
    this.registry.set(id, rec);
    return rec;
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
