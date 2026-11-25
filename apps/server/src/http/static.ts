/**
 * Static asset serving. Mounts the generated `ASSETS_DIR/**` at `/assets/*` with directory
 * listing disabled. Two kinds of files live there, with two cache policies:
 *
 *  - STORE BLOBS (`blobs/<xx>/<sha256>.<ext>`) are named by the hash of their bytes and never
 *    change, so they are cached for a year, `immutable`: after the first load a map costs no
 *    asset request at all, and mods that share a file share its cache entry.
 *
 *  - The FLAT pre-multi-mod layout (atlas pages, catalogs by plain name). A map load pulls
 *    HUNDREDS of small atlas files, each paying a round-trip through the public reverse
 *    proxy — so `no-cache` (revalidate-every-file-every-load) was the dominant load cost.
 *    These names are NOT content-hashed (a pipeline rebuild overwrites them in place), so
 *    they can't be `immutable`; instead we cache a day and `stale-while-revalidate` for a
 *    week: repeat loads hit the disk cache with ZERO network, while a rare pipeline rebuild
 *    self-heals within a day. @fastify/static still emits ETag/Last-Modified, so a
 *    revalidation is a cheap 304.
 *
 * NOTE: the flat manifest's `image`/`meta` fields are bare filenames (e.g. "iso-terrn-0.png"),
 * so the web renderer requests them at `<assetBase>/<image>`. The mount root is
 * config.ASSETS_DIR (absolute).
 */

import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "../config.js";

/** Flat-layout cache: fresh for a day, then serve-stale-while-revalidating for a week. */
const ATLAS_CACHE = "public, max-age=86400, stale-while-revalidate=604800";
/** Content-addressed blobs: the URL names the bytes. */
const BLOB_CACHE = "public, max-age=31536000, immutable";

/** True for a file inside the store's `blobs/` directory. */
export function isBlobPath(filePath: string): boolean {
  return /[\\/]blobs[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}\.[a-z0-9]+$/.test(filePath);
}

export async function registerStatic(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: config.ASSETS_DIR,
    prefix: "/assets/",
    index: false,
    list: false,
    redirect: false,
    cacheControl: true,
    maxAge: 86400_000,
    immutable: false,
    setHeaders: (res, filePath) =>
      res.setHeader("cache-control", isBlobPath(filePath) ? BLOB_CACHE : ATLAS_CACHE),
  });
}
