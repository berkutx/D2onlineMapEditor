/**
 * Map document routes.
 *  GET /api/maps/:id        -> MapDocument (+ ETag, revalidation)
 *  GET /api/maps/:id/meta   -> MapMeta
 *
 * Documents are parsed lazily and cached in the MapStore (LRU by id+mtime). The
 * ETag is id+mtime derived, so `If-None-Match` short-circuits to 304.
 */

import type { FastifyInstance } from "fastify";
import { REST } from "@d2/socket-contract";
import type { MapStore } from "../maps/mapStore.js";

export async function registerMapRoutes(
  app: FastifyInstance,
  store: MapStore,
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    REST.map(":id"),
    async (req, reply) => {
      const { id } = req.params;

      // cheap revalidation: compute ETag without forcing a parse
      const currentEtag = await store.etagFor(id);
      if (!currentEtag) {
        return reply.code(404).send({ error: "map not found" });
      }
      const inm = req.headers["if-none-match"];
      if (inm && inm === currentEtag) {
        return reply
          .code(304)
          .header("etag", currentEtag)
          .header("cache-control", "no-cache")
          .send();
      }

      const loaded = await store.getMap(id);
      if (!loaded) {
        return reply.code(404).send({ error: "map not found" });
      }
      return reply
        .header("etag", loaded.etag)
        .header("cache-control", "no-cache")
        .send(loaded.doc);
    },
  );

  app.get<{ Params: { id: string } }>(
    REST.mapMeta(":id"),
    async (req, reply) => {
      const { id } = req.params;
      const meta = await store.getMeta(id);
      if (!meta) {
        return reply.code(404).send({ error: "map not found" });
      }
      return meta;
    },
  );
}
