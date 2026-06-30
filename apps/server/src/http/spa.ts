/**
 * Production SPA serving. Serves the built Vue app (apps/web/dist) so a single Fastify
 * instance hosts the editor + its REST API + atlases + socket.io. In dev this is a no-op
 * (the dir doesn't exist; Vite serves the SPA), so the server stays dev-friendly.
 *
 * The SPA's own JS/CSS live under /app/ (Vite `build.assetsDir: 'app'`), so they never
 * collide with the atlas mount at /assets/. Unknown GET paths (SPA history routes) fall back
 * to index.html. Behind the tunnel the app is reached at /map/*, but Fastify's `rewriteUrl`
 * (see app.ts) has already stripped the base by the time anything here runs.
 */

import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

export async function registerSpa(app: FastifyInstance): Promise<void> {
  const dist = config.WEB_DIST;
  if (!dist || !existsSync(join(dist, "index.html"))) return; // dev: Vite owns the SPA

  // Serve real built files (/index.html, /app/*.js, /app/*.css). wildcard:false → a missing
  // path 404s through to the SPA fallback below instead of being swallowed by a catch-all.
  await app.register(fastifyStatic, {
    root: dist,
    prefix: "/",
    index: ["index.html"],
    wildcard: false,
    decorateReply: false, // /assets already added reply.sendFile
    cacheControl: true,
    setHeaders: (res) => res.setHeader("cache-control", "no-cache"),
  });

  // SPA history fallback: any other GET (not API / atlases / socket.io) returns index.html.
  const indexHtml = readFileSync(join(dist, "index.html"));
  app.setNotFoundHandler((req, reply) => {
    if (
      req.method === "GET" &&
      !req.url.startsWith("/api") &&
      !req.url.startsWith("/assets") &&
      !req.url.startsWith("/socket.io")
    ) {
      reply.type("text/html").send(indexHtml);
      return;
    }
    reply.code(404).send({ error: "Not Found" });
  });
}
