/**
 * GET /api/assets/manifest -> the contents of public/assets/manifest.json.
 *
 * The file is read fresh (and lightly cached by mtime) so a pipeline rebuild is
 * picked up without restarting the server. Raw bytes are passed through as JSON.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { REST } from "@d2/socket-contract";
import { config } from "../config.js";

const MANIFEST_PATH = join(config.ASSETS_DIR, "manifest.json");

let cache: { mtimeMs: number; json: unknown } | null = null;

export async function registerAssetRoutes(app: FastifyInstance): Promise<void> {
  app.get(REST.assetsManifest, async (_req, reply) => {
    try {
      const st = await stat(MANIFEST_PATH);
      if (!cache || cache.mtimeMs !== st.mtimeMs) {
        const raw = await readFile(MANIFEST_PATH, "utf8");
        cache = { mtimeMs: st.mtimeMs, json: JSON.parse(raw) };
      }
      return reply
        .header("cache-control", "no-cache")
        .send(cache.json);
    } catch {
      return reply
        .code(503)
        .send({ error: "asset manifest not available" });
    }
  });
}
