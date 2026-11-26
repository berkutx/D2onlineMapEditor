/**
 * Campaigns a visitor made, copied or uploaded: a header and the ids of the mission maps in
 * play order, one JSON file each in UPLOAD_DIR/campaigns. Listed only to the owner (the
 * anonymous x-client-id); opened by anyone who has the id, like a map's share link.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CampaignInput } from "@d2/socket-contract";
import { config } from "../config.js";
import { idForPath } from "../ingest/idCodec.js";

export interface StoredCampaign {
  id: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
  header: CampaignInput["header"];
  /** Map ids, in play order. */
  missions: string[];
  /** The file names missions had in the saga they came from (an upload), by map id: an
   *  export keeps them where the game can find them. */
  fileNames?: Record<string, string>;
}

const dir = (): string => join(config.UPLOAD_DIR, "campaigns");
const fileOf = (id: string): string => join(dir(), `${id.replace(/[^a-z0-9]/g, "")}.json`);

export async function getUserCampaign(id: string): Promise<StoredCampaign | undefined> {
  try {
    const c = JSON.parse(await readFile(fileOf(id), "utf-8")) as StoredCampaign;
    return c && c.id === id ? c : undefined;
  } catch {
    return undefined;
  }
}

export async function listUserCampaigns(owner: string): Promise<StoredCampaign[]> {
  let names: string[];
  try {
    names = await readdir(dir());
  } catch {
    return [];
  }
  const out: StoredCampaign[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const c = await getUserCampaign(n.slice(0, -5));
    if (c && c.owner === owner) out.push(c);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function save(c: StoredCampaign): Promise<void> {
  await mkdir(dir(), { recursive: true });
  const tmp = `${fileOf(c.id)}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(c, null, 2), "utf-8");
  await rename(tmp, fileOf(c.id));
}

export async function createUserCampaign(
  owner: string,
  input: CampaignInput,
  fileNames?: Record<string, string>,
): Promise<StoredCampaign> {
  const now = Date.now();
  const c: StoredCampaign = {
    id: idForPath(`campaign:${randomUUID()}`),
    owner,
    createdAt: now,
    updatedAt: now,
    header: input.header,
    missions: input.missions,
    fileNames,
  };
  await save(c);
  return c;
}

export async function updateUserCampaign(c: StoredCampaign, input: CampaignInput): Promise<StoredCampaign> {
  const next: StoredCampaign = { ...c, header: input.header, missions: input.missions, updatedAt: Date.now() };
  await save(next);
  return next;
}

export async function removeUserCampaign(id: string): Promise<void> {
  await rm(fileOf(id), { force: true });
}
