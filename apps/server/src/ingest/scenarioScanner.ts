/**
 * Scenario discovery. Walks the configured roots (recursively, Cyrillic dirs +
 * spaces are fine), filters to `*.sg` (case-insensitive, skipping `.bak/.csg/
 * .lua/.dbf`), and builds `ScenarioEntry[]` using cheap header-only parses.
 *
 * The id<->path mapping is held in a registry so the public API only ever
 * exposes the opaque id; raw paths never leave the server.
 */

import { readdir, stat, realpath, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, basename, dirname, relative, sep } from "node:path";
import { parseHeaderOnly } from "@d2/sg-parser";
import type { ScenarioEntry } from "@d2/socket-contract";
import { idForPath } from "./idCodec.js";

/** Extensions that look map-ish but are NOT loadable `.sg` scenarios. */
const SKIP_EXT = new Set([".bak", ".csg", ".lua", ".dbf", ".txt", ".pdf", ".docx"]);

export interface ScenarioRecord {
  id: string;
  /** Real (canonical) absolute path — server-private, never serialized. */
  realPath: string;
  source: "install" | "upload";
  mtimeMs: number;
  /** Anonymous owner (x-client-id) of an uploaded/new map; installs have none. */
  owner?: string;
  /** TEMPORARY map (a first-visit auto-clone of the reference): swept after the TTL
   *  since the last access. Explicit uploads / "Новая карта" creations are permanent. */
  ephemeral?: boolean;
  /** Last time this record was accessed (ms epoch) — refreshes the ephemeral TTL. */
  lastAccessMs?: number;
  /** Fixed deletion deadline for a trusted external read-only preview. It is intentionally
   * independent from lastAccessMs: repeatedly opening a link must not prolong storage. */
  previewExpiresAtMs?: number;
  /** SHA-256 of the original `.sg`; active previews are deduplicated by this value. */
  previewContentHash?: string;
  /** The mod this map is known to belong to: the mod whose scenario folder it lives in
   *  (install), or the one set explicitly for an upload. Absent = decided by detection. */
  modId?: string;
}

/** A folder to scan; `modId` marks every map in it as that mod's. */
export interface ScanRoot {
  path: string;
  modId?: string;
}

function lowerExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/** Recursively collect candidate `.sg` paths under a directory. */
async function walk(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip silently
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(full, out);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = lowerExt(ent.name);
    if (ext !== ".sg") continue; // only .sg (case-insensitive via toLowerCase)
    if (SKIP_EXT.has(ext)) continue; // defensive (".sg" never matches, but explicit)
    out.push(full);
  }
}

/** What a listing shows of a file's header. */
interface HeaderFacts {
  name: string;
  mapSize: number;
  players: number;
}

/** Header facts per file, kept while its mtime and size stay the same: parsing even the
 *  header needs the whole file read, and a listing runs on every start of the editor, so
 *  only the files that changed since the last listing are read again. */
const headerCache = new Map<string, { mtimeMs: number; size: number; facts: HeaderFacts }>();

async function headerOf(real: string, st: { mtimeMs: number; size: number }): Promise<HeaderFacts> {
  const hit = headerCache.get(real);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.facts;
  const h = parseHeaderOnly(new Uint8Array(await readFile(real)));
  const facts = { name: h.header.name || basename(real), mapSize: h.size, players: h.players.length };
  headerCache.set(real, { mtimeMs: st.mtimeMs, size: st.size, facts });
  return facts;
}

/**
 * The group a listing shows a map under: the folders between the scan root and the file, a
 * leading `Campaign` dropped — `Campaign/Возвращение Галлеана/Империя/1.sg` is «Возвращение
 * Галлеана / Империя», so two sagas with a same-named folder stay apart. A file directly in
 * the root is listed under the root folder's own name.
 */
function campaignOf(file: string, root: string): string | undefined {
  const parts = relative(root, dirname(file))
    .split(sep)
    .filter((p) => p && p !== ".");
  if (parts.length > 1 && parts[0]?.toLowerCase() === "campaign") parts.shift();
  if (parts.length > 0) return parts.join(" / ");
  return basename(root) || undefined;
}

export interface ScanResult {
  entries: ScenarioEntry[];
  /** id -> record, for resolving opaque ids back to real paths. */
  registry: Map<string, ScenarioRecord>;
}

/**
 * Scan all roots once. Each file is wrapped in try/catch so a single bad file
 * cannot break the listing. Header parsing is header-only (cheap).
 */
export async function scanScenarios(
  roots: readonly (string | ScanRoot)[],
  uploadRecords: readonly ScenarioRecord[] = [],
): Promise<ScanResult> {
  const registry = new Map<string, ScenarioRecord>();
  const entries: ScenarioEntry[] = [];
  const seen = new Set<string>();

  // 1) installed scenarios from the game roots. Roots are scanned in order and a file is
  //    taken from the FIRST root that holds it, so a mod's own folder (listed first) keeps
  //    its mod even when a plain root covers the same directory.
  const candidates: { path: string; root: string; modId?: string }[] = [];
  for (const root of roots) {
    const { path, modId } = typeof root === "string" ? { path: root, modId: undefined } : root;
    const found: string[] = [];
    await walk(path, found);
    for (const f of found) candidates.push({ path: f, root: path, modId });
  }

  for (const { path, root, modId } of candidates) {
    try {
      const real = await realpath(path);
      const st = await stat(real);
      const id = idForPath(real);
      if (registry.has(id)) continue; // already taken from an earlier root
      registry.set(id, {
        id,
        realPath: real,
        source: "install",
        mtimeMs: st.mtimeMs,
        modId,
      });

      seen.add(real);
      const h = await headerOf(real, st);
      entries.push({
        id,
        name: h.name,
        source: "install",
        campaign: campaignOf(path, root),
        fileName: basename(real),
        mapSize: h.mapSize,
        players: h.players,
        sizeBytes: st.size,
        mtime: Math.floor(st.mtimeMs),
      });
    } catch {
      // one bad/locked/corrupt file must not break the whole listing
      continue;
    }
  }

  // 2) uploaded scenarios (Stage-1 optional path)
  for (const rec of uploadRecords) {
    try {
      const st = await stat(rec.realPath);
      registry.set(rec.id, rec);
      seen.add(rec.realPath);
      const h = await headerOf(rec.realPath, st);
      entries.push({
        id: rec.id,
        name: h.name,
        source: "upload",
        fileName: basename(rec.realPath),
        mapSize: h.mapSize,
        players: h.players,
        sizeBytes: st.size,
        mtime: Math.floor(st.mtimeMs),
        owner: rec.owner,
      });
    } catch {
      continue;
    }
  }

  // files gone since the last listing take their cached header with them
  for (const path of headerCache.keys()) if (!seen.has(path)) headerCache.delete(path);

  // stable order: campaign then name
  entries.sort(
    (a, b) =>
      (a.campaign ?? "").localeCompare(b.campaign ?? "") ||
      a.name.localeCompare(b.name),
  );

  return { entries, registry };
}
