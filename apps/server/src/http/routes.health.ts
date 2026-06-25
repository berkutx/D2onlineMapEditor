/** GET /api/health -> { ok, version, uptime }. */

import type { FastifyInstance } from "fastify";
import { REST, SOCKET_CONTRACT_VERSION } from "@d2/socket-contract";

const startedAt = Date.now();

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get(REST.health, async () => ({
    ok: true,
    version: SOCKET_CONTRACT_VERSION,
    uptime: (Date.now() - startedAt) / 1000,
  }));
}
