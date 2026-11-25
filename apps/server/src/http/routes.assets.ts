/**
 * GET /api/assets/manifest -> the atlas manifest (manifest.json) of the default mod.
 *
 * The file is read fresh (and lightly cached by mtime, see ModContext.manifest) so a
 * pipeline rebuild is picked up without restarting the server.
 */

import type { FastifyInstance } from "fastify";
import { REST } from "@d2/socket-contract";
import type { ModRegistry } from "../mods/modRegistry.js";

export async function registerAssetRoutes(app: FastifyInstance, mods: ModRegistry): Promise<void> {
  app.get(REST.assetsManifest, async (_req, reply) => {
    try {
      const json = await mods.default().manifest();
      return reply
        .header("cache-control", "no-cache")
        .send(json);
    } catch {
      return reply
        .code(503)
        .send({ error: "asset manifest not available" });
    }
  });
}
