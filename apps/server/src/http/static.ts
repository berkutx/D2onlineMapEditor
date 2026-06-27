/**
 * Static atlas serving. Mounts the generated `public/assets/**` at `/assets/*`
 * with directory listing disabled.
 *
 * Cache policy: the atlas filenames are NOT content-hashed (e.g. "iso-unit.png"),
 * so an asset-pipeline rebuild overwrites them in place. `immutable` would then pin
 * a stale atlas in the browser forever. We instead use `no-cache` (must-revalidate):
 * @fastify/static still emits ETag + Last-Modified, so an unchanged file revalidates
 * to a cheap 304 while a regenerated file is re-fetched. Matches the manifest route.
 *
 * NOTE: the manifest's `image`/`meta` fields are bare filenames (e.g.
 * "iso-terrn-0.png"), so the web renderer requests them at `/assets/<image>`.
 * The mount root is config.ASSETS_DIR (absolute).
 */

import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "../config.js";

export async function registerStatic(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: config.ASSETS_DIR,
    prefix: "/assets/",
    index: false,
    list: false,
    redirect: false,
    cacheControl: true,
    maxAge: 0,
    immutable: false,
    // force revalidation so a pipeline rebuild is picked up (ETag/Last-Modified -> 304)
    setHeaders: (res) => res.setHeader("cache-control", "no-cache"),
  });
}
