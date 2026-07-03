/**
 * Static atlas serving. Mounts the generated `public/assets/**` at `/assets/*`
 * with directory listing disabled.
 *
 * Cache policy: a map load pulls HUNDREDS of small atlas files, each paying a round-trip
 * through the Cloudflare Tunnel — so `no-cache` (revalidate-every-file-every-load) was the
 * dominant load cost. The atlas filenames are NOT content-hashed (a pipeline rebuild
 * overwrites them in place), so we can't go fully `immutable`; instead we cache a day and
 * `stale-while-revalidate` for a week: repeat loads (and same-session reloads) hit the disk
 * cache with ZERO network, while a rare pipeline rebuild self-heals within a day (swr serves
 * the old file once, revalidates in the background). @fastify/static still emits ETag/
 * Last-Modified, so a revalidation is a cheap 304.
 *
 * NOTE: the manifest's `image`/`meta` fields are bare filenames (e.g.
 * "iso-terrn-0.png"), so the web renderer requests them at `/assets/<image>`.
 * The mount root is config.ASSETS_DIR (absolute).
 */

import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "../config.js";

/** Atlas cache: fresh for a day, then serve-stale-while-revalidating for a week. */
const ATLAS_CACHE = "public, max-age=86400, stale-while-revalidate=604800";

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
    setHeaders: (res) => res.setHeader("cache-control", ATLAS_CACHE),
  });
}
