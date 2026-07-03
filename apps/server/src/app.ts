/**
 * Build the Fastify app: register CORS, multipart, static atlases, and all REST
 * routes. The app is created without listening so tests can drive it via
 * `app.inject()`. A shared MapStore instance is attached for reuse.
 */

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { MapStore } from "./maps/mapStore.js";
import { registerStatic } from "./http/static.js";
import { registerSpa } from "./http/spa.js";
import { registerHealthRoutes } from "./http/routes.health.js";
import { registerScenarioRoutes } from "./http/routes.scenarios.js";
import { registerMapRoutes } from "./http/routes.maps.js";
import { registerAssetRoutes } from "./http/routes.assets.js";
import { registerUploadRoute } from "./http/routes.upload.js";

/**
 * In production the app is served under config.BASE_PATH ("/map") behind the Cloudflare
 * Tunnel, which forwards d2mapeditor.online/map/* unchanged. Strip the prefix before routing
 * so every route/static mount stays at its root path. No-op when BASE_PATH is empty (dev).
 * (socket.io is NOT affected — it intercepts upgrades before Fastify; its path is namespaced
 * in io.ts instead.)
 */
function makeRewriteUrl(base: string): ((req: { url?: string }) => string) | undefined {
  if (!base) return undefined;
  return (req: { url?: string }): string => {
    const url = req.url ?? "/";
    if (url === base) return "/";
    if (url.startsWith(base + "/")) return url.slice(base.length) || "/";
    return url;
  };
}

export interface BuiltApp {
  app: FastifyInstance;
  store: MapStore;
}

export async function buildApp(): Promise<BuiltApp> {
  const app = Fastify({
    logger: false,
    // MapDocument for a 72x72 map is multi-MB of JSON; raise body limit for uploads
    bodyLimit: config.UPLOAD_MAX_BYTES,
    // strip the deploy base ("/map") in production so all routes/static stay at root
    rewriteUrl: makeRewriteUrl(config.BASE_PATH),
  });

  // origin: "*" (static), NOT true (reflect). Reflecting the Origin makes @fastify/cors add
  // `Vary: Origin` to EVERY response — including the static atlases. That Vary is a browser-cache
  // footgun: once assets became `max-age`-cacheable (was `no-cache`), the browser tries to reuse
  // the cached copy directly, and the Vary:Origin key (esp. for the pixi worker's fetch) can miss
  // → full 200 re-download instead of a cache hit. Assets/API are public + credential-free
  // (x-client-id header, no cookies), so a wildcard is safe and drops the Vary entirely.
  await app.register(cors, { origin: "*" });
  await app.register(multipart, {
    limits: { fileSize: config.UPLOAD_MAX_BYTES, files: 1 },
  });

  const store = new MapStore();

  await registerStatic(app);
  await registerHealthRoutes(app);
  await registerScenarioRoutes(app, store);
  await registerMapRoutes(app, store);
  await registerAssetRoutes(app);
  await registerUploadRoute(app, store);
  // SPA last: serves apps/web/dist + history fallback in production (no-op in dev).
  await registerSpa(app);

  return { app, store };
}
