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
import { registerHealthRoutes } from "./http/routes.health.js";
import { registerScenarioRoutes } from "./http/routes.scenarios.js";
import { registerMapRoutes } from "./http/routes.maps.js";
import { registerAssetRoutes } from "./http/routes.assets.js";
import { registerUploadRoute } from "./http/routes.upload.js";

export interface BuiltApp {
  app: FastifyInstance;
  store: MapStore;
}

export async function buildApp(): Promise<BuiltApp> {
  const app = Fastify({
    logger: false,
    // MapDocument for a 72x72 map is multi-MB of JSON; raise body limit for uploads
    bodyLimit: config.UPLOAD_MAX_BYTES,
  });

  await app.register(cors, { origin: true });
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

  return { app, store };
}
