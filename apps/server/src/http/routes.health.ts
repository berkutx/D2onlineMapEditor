/** GET /api/health -> { ok, version, uptime, degradedRooms }. */

import type { FastifyInstance } from "fastify";
import { REST, SOCKET_CONTRACT_VERSION } from "@d2/socket-contract";
import type { EditLog } from "../realtime/EditLog.js";

const startedAt = Date.now();

export async function registerHealthRoutes(app: FastifyInstance, log?: EditLog): Promise<void> {
  app.get(REST.health, async () => {
    const degradedRooms = log?.degradedCount() ?? 0;
    return {
      // degraded rooms = durability failing (disk full/IO): the service still serves reads,
      // but edits are rejected there — surface it as NOT-ok so monitoring pages someone.
      ok: degradedRooms === 0,
      version: SOCKET_CONTRACT_VERSION,
      uptime: (Date.now() - startedAt) / 1000,
      degradedRooms,
    };
  });
}
