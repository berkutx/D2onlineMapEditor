/**
 * GET /api/assets/manifest[?mod=<id>] -> the atlas manifest (manifest.json) of a mod; the
 * default mod when `mod` is omitted (what clients that predate mods ask for).
 *
 * The file is read fresh (and lightly cached by mtime, see ModContext.manifest) so a
 * pipeline rebuild is picked up without restarting the server.
 */

import type { FastifyInstance } from "fastify";
import { REST } from "@d2/socket-contract";
import type { ModRegistry } from "../mods/modRegistry.js";

export async function registerAssetRoutes(app: FastifyInstance, mods: ModRegistry): Promise<void> {
  app.get<{ Querystring: { mod?: string } }>(REST.assetsManifest, async (req, reply) => {
    mods.refresh();
    const wanted = typeof req.query.mod === "string" && req.query.mod ? req.query.mod : undefined;
    if (wanted !== undefined && !mods.has(wanted)) {
      return reply.code(404).send({ error: `unknown mod '${wanted}'` });
    }
    try {
      const json = await mods.get(wanted).manifest();
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
