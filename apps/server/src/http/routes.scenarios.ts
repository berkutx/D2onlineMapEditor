/**
 * Scenario discovery routes.
 *  GET /api/scenarios        -> ScenarioEntry[]
 *  GET /api/scenarios/:id    -> ScenarioEntry
 *
 * Listings come from the MapStore (which rescans the configured roots). Raw
 * filesystem paths are never exposed — only the opaque id.
 *
 * Privacy (v0.2): install maps are public; an uploaded/new map is LISTED only for its
 * owner (the anonymous `x-client-id` the browser sends). Ownerless legacy uploads are
 * hidden from every listing. Direct access by id (/api/maps/:id …) stays un-gated on
 * purpose — the unguessable id is the capability that makes share links work.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { REST, type ScenarioEntry } from "@d2/socket-contract";
import type { MapStore } from "../maps/mapStore.js";

/** The anonymous browser identity header (see apps/web services/clientId.ts). */
export function clientIdOf(req: FastifyRequest): string | undefined {
  const v = req.headers["x-client-id"];
  return typeof v === "string" && v.length > 0 && v.length <= 128 ? v : undefined;
}

const visibleTo = (e: ScenarioEntry, clientId: string | undefined): boolean =>
  e.source === "install" || (e.owner !== undefined && e.owner === clientId);

export async function registerScenarioRoutes(
  app: FastifyInstance,
  store: MapStore,
): Promise<void> {
  app.get(REST.scenarios, async (req) => {
    const clientId = clientIdOf(req);
    const entries = await store.listScenarios();
    // never serialize the owner token back out — it is the caller's own secret
    return entries.filter((e) => visibleTo(e, clientId)).map(({ owner: _o, ...pub }) => pub);
  });

  app.get<{ Params: { id: string } }>(
    REST.scenario(":id"),
    async (req, reply) => {
      const { id } = req.params;
      const entries = await store.listScenarios();
      const entry = entries.find((e) => e.id === id);
      // by-id lookup honors the capability model: knowing the id grants access
      if (!entry) {
        return reply.code(404).send({ error: "scenario not found" });
      }
      const { owner: _o, ...pub } = entry;
      return pub;
    },
  );
}
