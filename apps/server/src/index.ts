/**
 * Bootstrap: build the Fastify app, attach socket.io to its HTTP server, and
 * listen. Stage 1 is read-only — the realtime layer manages rooms/presence and
 * rejects edits.
 */

import { buildApp } from "./app.js";
import { createIo } from "./realtime/io.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  const { app, store } = await buildApp();

  // Ensure the HTTP server exists before socket.io attaches to it.
  await app.ready();
  const { io } = createIo(app.server, store);

  await app.listen({ port: config.PORT, host: config.HOST });

  // eslint-disable-next-line no-console
  console.log(
    `[@d2/server] listening on http://localhost:${config.PORT} ` +
      `(assets: ${config.ASSETS_DIR})`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[@d2/server] ${signal} -> shutting down`);
    io.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[@d2/server] fatal:", err);
  process.exit(1);
});
