/**
 * A tiny synthetic asset store (mods/index.json + mods/<id>/mod.json + blobs/) for tests,
 * shaped exactly like what tools/asset-pipeline/build_mod.py writes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export interface FixtureMod {
  id: string;
  name?: string;
  family?: string;
  familyOrder?: number;
  status?: "ready" | "data-only";
  /** logical name -> content (objects are JSON-encoded) */
  files: Record<string, unknown>;
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/** Write one blob, return its store-relative path. */
export function putBlob(root: string, logical: string, content: unknown): string {
  const data = Buffer.isBuffer(content)
    ? content
    : Buffer.from(typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  const sha = sha256(data);
  const dot = logical.lastIndexOf(".");
  const rel = `blobs/${sha.slice(0, 2)}/${sha}.${dot < 0 ? "bin" : logical.slice(dot + 1).toLowerCase()}`;
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return rel;
}

/** Write (or overwrite) a store with the given mods. */
export function writeModStore(root: string, mods: readonly FixtureMod[], defaultModId?: string): void {
  const rows = [];
  for (const mod of mods) {
    const files: Record<string, string> = {};
    for (const [logical, content] of Object.entries(mod.files)) files[logical] = putBlob(root, logical, content);
    const row = {
      id: mod.id,
      name: mod.name ?? mod.id,
      family: mod.family ?? mod.id,
      familyOrder: mod.familyOrder ?? 0,
      status: mod.status ?? "ready",
      contentFingerprint: sha256(mod.id),
    };
    const manifest = { schemaVersion: 1, ...row, pipelineVersion: "test", source: {}, capabilities: [], files };
    mkdirSync(join(root, "mods", mod.id), { recursive: true });
    writeFileSync(join(root, "mods", mod.id, "mod.json"), JSON.stringify(manifest), "utf-8");
    rows.push(row);
  }
  mkdirSync(join(root, "mods"), { recursive: true });
  writeFileSync(
    join(root, "mods", "index.json"),
    JSON.stringify({ schemaVersion: 1, defaultModId, mods: rows }),
    "utf-8",
  );
}

/** Id tables of a mod: table code -> ids. */
export const idSets = (tables: Record<string, string[]>): unknown => ({ schemaVersion: 1, tables });
