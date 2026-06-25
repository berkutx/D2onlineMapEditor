/**
 * Scenario discovery routes.
 *  GET /api/scenarios        -> ScenarioEntry[]
 *  GET /api/scenarios/:id    -> ScenarioEntry
 *
 * Listings come from the MapStore (which rescans the configured roots). Raw
 * filesystem paths are never exposed — only the opaque id.
 */

import type { FastifyInstance } from "fastify";
import { REST } from "@d2/socket-contract";
import type { MapStore } from "../maps/mapStore.js";

export async function registerScenarioRoutes(
  app: FastifyInstance,
  store: MapStore,
): Promise<void> {
  app.get(REST.scenarios, async () => {
    return store.listScenarios();
  });

  app.get<{ Params: { id: string } }>(
    REST.scenario(":id"),
    async (req, reply) => {
      const { id } = req.params;
      const entries = await store.listScenarios();
      const entry = entries.find((e) => e.id === id);
      if (!entry) {
        return reply.code(404).send({ error: "scenario not found" });
      }
      return entry;
    },
  );
}
