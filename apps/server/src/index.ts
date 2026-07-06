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
  const { io, log } = createIo(app.server, store);

  await app.listen({ port: config.PORT, host: config.HOST });

  // The temporary-copy watcher: ephemeral first-visit clones are deleted EPHEMERAL_TTL_MS
  // (default 2 days) after their last access. Hourly + once at boot.
  const sweep = async (): Promise<void> => {
    try {
      const n = await store.sweepEphemeral(config.EPHEMERAL_TTL_MS);
      // eslint-disable-next-line no-console
      if (n > 0) console.log(`[@d2/server] swept ${n} expired ephemeral map(s)`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[@d2/server] ephemeral sweep failed:", e);
    }
  };
  void sweep();
  const sweeper = setInterval(() => void sweep(), 60 * 60 * 1000);

  // eslint-disable-next-line no-console
  console.log(
    `[@d2/server] listening on http://localhost:${config.PORT} ` +
      `(assets: ${config.ASSETS_DIR})`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[@d2/server] ${signal} -> shutting down`);
    clearInterval(sweeper);
    io.close();
    await app.close();
    // Flush pending durable op-log writes BEFORE exit — otherwise a just-acked edit whose
    // appendFile is still queued is lost on restart (the very event the log must survive).
    try {
      await log.flush();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[@d2/server] EditLog flush failed on shutdown:", e);
    }
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
