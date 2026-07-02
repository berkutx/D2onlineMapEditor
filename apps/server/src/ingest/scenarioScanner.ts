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
import { join, basename, sep } from "node:path";
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

/** Best-effort campaign label = the parent directory name. */
function campaignOf(realPath: string): string | undefined {
  const parts = realPath.split(sep);
  // .../<campaign>/<file>.sg
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
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
  roots: readonly string[],
  uploadRecords: readonly ScenarioRecord[] = [],
): Promise<ScanResult> {
  const registry = new Map<string, ScenarioRecord>();
  const entries: ScenarioEntry[] = [];

  // 1) installed scenarios from the game roots
  const candidates: string[] = [];
  for (const root of roots) {
    await walk(root, candidates);
  }

  for (const path of candidates) {
    try {
      const real = await realpath(path);
      const st = await stat(real);
      const id = idForPath(real);
      registry.set(id, {
        id,
        realPath: real,
        source: "install",
        mtimeMs: st.mtimeMs,
      });

      const buf = new Uint8Array(await readFile(real));
      const h = parseHeaderOnly(buf);
      entries.push({
        id,
        name: h.header.name || basename(real),
        source: "install",
        campaign: campaignOf(real),
        fileName: basename(real),
        mapSize: h.size,
        players: h.players.length,
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
      const buf = new Uint8Array(await readFile(rec.realPath));
      const h = parseHeaderOnly(buf);
      entries.push({
        id: rec.id,
        name: h.header.name || basename(rec.realPath),
        source: "upload",
        fileName: basename(rec.realPath),
        mapSize: h.size,
        players: h.players.length,
        sizeBytes: st.size,
        mtime: Math.floor(st.mtimeMs),
        owner: rec.owner,
      });
    } catch {
      continue;
    }
  }

  // stable order: campaign then name
  entries.sort(
    (a, b) =>
      (a.campaign ?? "").localeCompare(b.campaign ?? "") ||
      a.name.localeCompare(b.name),
  );

  return { entries, registry };
}
