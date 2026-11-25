/**
 * Mod routes.
 *  GET /api/mods                         -> ModList (the mod data sets this server serves)
 *  GET /assets/mods/:modId/:rev/<name>   -> one file of a mod, by its LOGICAL name
 *
 * A mod's files live in the content-addressed store (blobs/<xx>/<sha256>.<ext>); its
 * manifest maps logical names ("unitCatalog.json", "itemicons/g000ig0001.png", an atlas page)
 * to blobs. The browser keeps asking for logical names under the mod's `assetBase`, and this
 * route answers with the blob. `rev` is a hash of the mod's manifest: a URL that carries the
 * current rev names content that can never change, so it is served `immutable`; a rebuild of
 * the mod changes the rev, and with it every URL.
 *
 * The store's own bookkeeping files (mods/index.json, mods/<id>/mod.json) are not public.
 */

import { basename, dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import { REST, type ModList } from "@d2/socket-contract";
import { config } from "../config.js";
import type { ModRegistry } from "../mods/modRegistry.js";

/** A logical file name: relative, forward-slashed, no empty / dot segments. */
function isLogicalName(name: string): boolean {
  if (!name || name.length > 300 || name.includes("\\") || name.includes("\0")) return false;
  return name.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

export async function registerModRoutes(app: FastifyInstance, mods: ModRegistry): Promise<void> {
  app.get(REST.mods, async (_req, reply) => {
    mods.refresh();
    const list: ModList = {
      defaultModId: mods.default().id,
      mods: mods.list().map((m) => m.info),
    };
    return reply.header("cache-control", "no-cache").send(list);
  });

  app.get<{ Params: { modId: string; rev: string; "*": string } }>(
    "/assets/mods/:modId/:rev/*",
    async (req, reply) => {
      mods.refresh();
      const { modId, rev } = req.params;
      const name = req.params["*"];
      if (!mods.has(modId) || !isLogicalName(name)) {
        return reply.code(404).send({ error: "not found" });
      }
      const mod = mods.get(modId);
      const path = mod.isFlat ? undefined : mod.filePath(name);
      if (!path) {
        return reply.code(404).send({ error: "not found" });
      }
      if (rev !== mod.rev) {
        // a page loaded before the mod was rebuilt: send it to the current revision's URL
        // (never cache the detour — the next rebuild moves it again)
        const target = `${config.BASE_PATH}${mod.info.assetBase}/${name.split("/").map(encodeURIComponent).join("/")}`;
        return reply.header("cache-control", "no-cache").redirect(target, 302);
      }
      // the blob path ends in /blobs/<xx>/<sha>.<ext>: the static plugin's header hook marks
      // it immutable (see static.ts), and the extension gives the content type
      return reply.sendFile(basename(path), dirname(path));
    },
  );

  // Everything else under /assets/mods/ is the store's bookkeeping — not served.
  app.get("/assets/mods/*", async (_req, reply) => reply.code(404).send({ error: "not found" }));
}
