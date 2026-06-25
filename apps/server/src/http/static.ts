/**
 * Static atlas serving. Mounts the generated `public/assets/**` at `/assets/*`
 * with long, immutable cache headers and directory listing disabled.
 *
 * NOTE: the manifest's `image`/`meta` fields are bare filenames (e.g.
 * "iso-terrn-0.png"), so the web renderer should request them at
 * `/assets/<image>`. The mount root is config.ASSETS_DIR (absolute).
 */

import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "../config.js";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export async function registerStatic(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: config.ASSETS_DIR,
    prefix: "/assets/",
    index: false,
    list: false,
    redirect: false,
    immutable: true,
    maxAge: ONE_YEAR_SECONDS * 1000, // @fastify/static expects ms
    cacheControl: true,
  });
}
