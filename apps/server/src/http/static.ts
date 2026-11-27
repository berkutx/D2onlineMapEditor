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

import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "../config.js";

/** Flat-layout cache: fresh for a day, then serve-stale-while-revalidating for a week. */
const ATLAS_CACHE = "public, max-age=86400, stale-while-revalidate=604800";
/** Content-addressed blobs: the URL names the bytes. */
const BLOB_CACHE = "public, max-age=31536000, immutable";
/** A private blob (served with a share key only): the browser keeps it, a shared cache never. */
const PRIVATE_BLOB_CACHE = "private, max-age=31536000, immutable";

/** True for a file inside the store's `blobs/` directory. */
export function isBlobPath(filePath: string): boolean {
  return /[\\/]blobs[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}\.[a-z0-9]+$/.test(filePath);
}

/** The store name ("blobs/<xx>/<sha256>.<ext>") of a blob file path, or null for any other file. */
export function blobName(filePath: string): string | null {
  const m = /[\\/]blobs[\\/]([0-9a-f]{2})[\\/]([0-9a-f]{64}\.[a-z0-9]+)$/.exec(filePath);
  return m ? `blobs/${m[1]}/${m[2]}` : null;
}

export interface StaticAccess {
  /** True for a blob only a share key may fetch (a file only hidden mods have). */
  isPrivateBlob(blob: string): boolean;
  /** True when the request carries a share key (in the header or its cookie). */
  hasKey(req: FastifyRequest): boolean;
}

const NO_PRIVATE: StaticAccess = { isPrivateBlob: () => false, hasKey: () => false };

export async function registerStatic(app: FastifyInstance, access: StaticAccess = NO_PRIVATE): Promise<void> {
  const isPrivate = (filePath: string) => {
    const blob = blobName(filePath);
    return !!blob && access.isPrivateBlob(blob);
  };
  await app.register(fastifyStatic, {
    root: config.ASSETS_DIR,
    prefix: "/assets/",
    index: false,
    list: false,
    redirect: false,
    cacheControl: true,
    maxAge: 86400_000,
    immutable: false,
    // a private blob answers only to a request with a share key: by its hash under
    // /assets/blobs/ and through reply.sendFile alike (the mod file route)
    allowedPath: (pathName, root, req) => !isPrivate(join(root ?? config.ASSETS_DIR, pathName)) || access.hasKey(req),
    setHeaders: (res, filePath) =>
      res.setHeader("cache-control", !isBlobPath(filePath) ? ATLAS_CACHE : isPrivate(filePath) ? PRIVATE_BLOB_CACHE : BLOB_CACHE),
  });
}
