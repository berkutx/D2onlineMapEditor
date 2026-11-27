/**
 * Mod routes.
 *  GET /api/mods                         -> ModList (the mod data sets this server serves)
 *  GET /api/mods/:modId                  -> ModPassport (one mod and where its data came from)
 *  GET /api/mods/:modId/files[?prefix=]  -> ModFileList (logical name -> sha256 of the file)
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
 *
 * A hidden mod (config HIDDEN_MODS) is private: without a share key (shareKey.ts, in the
 * header or its cookie) its passport, file list and files answer 404, as an unknown mod's do.
 * With one, the hidden mods are listed too and their files come with `cache-control:
 * private`. Answers that depend on the key say `vary: x-mod-share-key, cookie`, and a keyed
 * file list of a hidden mod has its own ETag, so a cache never hands a keyless answer to a
 * keyed request or the other way round.
 */

import { basename, dirname } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { MOD_SHARE_KEY_HEADER, REST, type ModFileList, type ModList } from "@d2/socket-contract";
import { config } from "../config.js";
import type { ModRegistry } from "../mods/modRegistry.js";
import { hasShareKey, headerHasShareKey, shareKeyCookie } from "../mods/shareKey.js";

/** Answers that differ with the share key (the header, or the cookie it was handed to). */
const VARY = `${MOD_SHARE_KEY_HEADER}, cookie`;

/** A logical file name: relative, forward-slashed, no empty / dot segments. */
function isLogicalName(name: string): boolean {
  if (!name || name.length > 300 || name.includes("\\") || name.includes("\0")) return false;
  return name.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

export async function registerModRoutes(app: FastifyInstance, mods: ModRegistry): Promise<void> {
  /** True for a mod this request may not see: unknown, or hidden and asked without a key. */
  const unseen = (modId: string, req: FastifyRequest): boolean =>
    !mods.has(modId) || (mods.isHidden(modId) && !hasShareKey(req));

  app.get(REST.mods, async (req, reply) => {
    mods.refresh();
    const list: ModList = {
      defaultModId: mods.default().id,
      // a hidden mod (config HIDDEN_MODS) is listed only for a request with a share key
      mods: (hasShareKey(req) ? mods.list() : mods.visible()).map((m) => m.info),
    };
    // the page's first request: hand its key to the picture requests that cannot send a header
    if (headerHasShareKey(req)) reply.header("set-cookie", shareKeyCookie(req));
    return reply.header("cache-control", "no-cache").header("vary", VARY).send(list);
  });

  // One mod's passport. It changes exactly when the mod is rebuilt, which is what `rev`
  // says, so `rev` is the ETag: a client revalidates for free until then.
  app.get<{ Params: { modId: string } }>(REST.mod(":modId"), async (req, reply) => {
    mods.refresh();
    const { modId } = req.params;
    reply.header("vary", VARY);
    if (unseen(modId, req)) return reply.code(404).send({ error: `unknown mod '${modId}'` });
    const mod = mods.get(modId);
    const etag = `"${mod.rev}"`;
    reply.header("cache-control", "no-cache").header("etag", etag);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.send(mod.passport);
  });

  // The sha256 of each of a mod's files, read off its blob path (blobs/<xx>/<sha256>.<ext>):
  // equal hashes in two mods mean the same bytes, so a comparison downloads only what
  // differs. Like the passport, it changes only with `rev`, which is the ETag.
  app.get<{ Params: { modId: string }; Querystring: { prefix?: unknown } }>(
    REST.modFiles(":modId"),
    async (req, reply) => {
      mods.refresh();
      const { modId } = req.params;
      reply.header("vary", VARY);
      if (unseen(modId, req)) return reply.code(404).send({ error: `unknown mod '${modId}'` });
      const prefix = req.query.prefix ?? "";
      if (typeof prefix !== "string") return reply.code(400).send({ error: "prefix must be one string" });
      const mod = mods.get(modId);
      // a hidden mod's list is a keyed answer: its own ETag, so a list a browser kept from
      // before (when a keyless request got it without the tables) is never revalidated into it
      const etag = mods.isHidden(modId) ? `"${mod.rev}-k"` : `"${mod.rev}"`;
      reply.header("cache-control", "no-cache").header("etag", etag);
      if (req.headers["if-none-match"] === etag) return reply.code(304).send();
      const files: ModFileList["files"] = {};
      for (const [name, blob] of Object.entries(mod.files)) {
        const sha = /^blobs\/[0-9a-f]{2}\/([0-9a-f]{64})\.[a-z0-9]+$/.exec(blob)?.[1];
        if (sha && name.startsWith(prefix)) files[name] = sha;
      }
      const body: ModFileList = { files };
      return reply.send(body);
    },
  );

  app.get<{ Params: { modId: string; rev: string; "*": string } }>(
    "/assets/mods/:modId/:rev/*",
    async (req, reply) => {
      mods.refresh();
      const { modId, rev } = req.params;
      const name = req.params["*"];
      // a hidden mod's files: only with a share key (the same 404 as a missing file)
      if (unseen(modId, req) || !isLogicalName(name)) {
        return reply.code(404).send({ error: "not found" });
      }
      const mod = mods.get(modId);
      const path = mod.isFlat ? undefined : mod.filePath(name);
      if (!path) return reply.code(404).send({ error: "not found" });
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
