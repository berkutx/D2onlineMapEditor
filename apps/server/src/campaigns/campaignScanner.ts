/**
 * The sagas (`.csg`) a game install or a mod folder ships with. Each is listed as a campaign,
 * and each of its missions is a map the editor opens like any other: the mission's id comes
 * from the saga file and the mission's place in it, and its bytes are read out of the saga
 * (see MapStore). Edits of a mission are the visitor's own project, as for any install map —
 * the saga file is never written.
 *
 * A saga the game saved in progress (a save package) is not a campaign and is left out.
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import {
  parseHeaderOnly,
  readCampaign,
  type CampaignHeader,
  type CampaignMissionFormat,
} from "@d2/sg-parser";
import { idForPath } from "../ingest/idCodec.js";
import type { ScanRoot, ScenarioRecord } from "../ingest/scenarioScanner.js";

export interface InstallMission {
  /** The map to open; absent when the editor cannot read the mission. */
  mapId?: string;
  /** The mission's file name inside the saga. */
  fileName: string;
  /** The scenario's own name (the file name when it cannot be read). */
  title: string;
  mapSize?: number;
  format: CampaignMissionFormat;
}

export interface InstallCampaign {
  id: string;
  /** Server-private: the saga file. */
  realPath: string;
  fileName: string;
  modId?: string;
  version: number;
  header: CampaignHeader;
  missions: InstallMission[];
}

/** The id of a mission map: the saga file, the mission's place and its name. */
export function missionMapId(sagaRealPath: string, index: number, name: string): string {
  return idForPath(`${sagaRealPath}#${index}#${name}`);
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) await walk(full, out);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith(".csg")) out.push(full);
  }
}

type Summary = Omit<InstallCampaign, "id" | "realPath" | "modId">;

/** A saga's summary per file, kept while its mtime and size stay the same (a saga is read
 *  whole — up to a few megabytes — so only changed ones are read again). null = not a
 *  campaign (unreadable, or a save package). */
const summaries = new Map<string, { mtimeMs: number; size: number; summary: Summary | null }>();

async function summarize(real: string, st: { mtimeMs: number; size: number }): Promise<Summary | null> {
  const hit = summaries.get(real);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
  let summary: Summary | null = null;
  try {
    const saga = readCampaign(new Uint8Array(await readFile(real)));
    if (!saga.savePackage) {
      summary = {
        fileName: basename(real),
        version: saga.version,
        header: saga.header,
        missions: saga.missions.map((m) => {
          if (m.format !== "sg") return { fileName: m.name, title: m.name, format: m.format };
          try {
            const h = parseHeaderOnly(m.bytes);
            return { fileName: m.name, title: h.header.name || m.name, mapSize: h.size, format: m.format };
          } catch {
            return { fileName: m.name, title: m.name, format: "unknown" as const };
          }
        }),
      };
    }
  } catch {
    summary = null; // not a saga this reader understands — not listed
  }
  summaries.set(real, { mtimeMs: st.mtimeMs, size: st.size, summary });
  return summary;
}

/**
 * Scan the roots for sagas. Returns the campaigns and one registry record per mission the
 * editor can open (source `install`, the saga as its file, `member` naming the mission).
 */
export async function scanCampaigns(
  roots: readonly (string | ScanRoot)[],
): Promise<{ campaigns: InstallCampaign[]; records: ScenarioRecord[] }> {
  const campaigns: InstallCampaign[] = [];
  const records: ScenarioRecord[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const { path, modId } = typeof root === "string" ? { path: root, modId: undefined } : root;
    const found: string[] = [];
    await walk(path, found);
    for (const file of found) {
      try {
        const real = await realpath(file);
        if (seen.has(real)) continue; // taken from an earlier root (a mod's own folder first)
        seen.add(real);
        const st = await stat(real);
        const summary = await summarize(real, st);
        if (!summary) continue;
        const missions = summary.missions.map((m, index) => {
          if (m.format !== "sg") return m;
          const mapId = missionMapId(real, index, m.fileName);
          records.push({
            id: mapId,
            realPath: real,
            source: "install",
            mtimeMs: st.mtimeMs,
            modId,
            member: { index, name: m.fileName },
          });
          return { ...m, mapId };
        });
        campaigns.push({ ...summary, id: idForPath(real), realPath: real, modId, missions });
      } catch {
        continue; // one unreadable file must not break the listing
      }
    }
  }
  for (const path of summaries.keys()) if (!seen.has(path)) summaries.delete(path);
  campaigns.sort((a, b) => (a.modId ?? "").localeCompare(b.modId ?? "") || a.header.name.localeCompare(b.header.name));
  return { campaigns, records };
}
