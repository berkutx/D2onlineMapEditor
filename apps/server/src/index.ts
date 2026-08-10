/**
 * Bootstrap: build the Fastify app, attach socket.io to its HTTP server, and
 * listen. Stage 1 is read-only — the realtime layer manages rooms/presence and
 * rejects edits.
 */

import { buildApp } from "./app.js";
import { createIo } from "./realtime/io.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  const { app, store, log } = await buildApp();

  // Ensure the HTTP server exists before socket.io attaches to it.
  await app.ready();
  // Preload upload policies before accepting socket edits. This makes the per-op preview
  // read-only guard synchronous (no filesystem await on every brush cell) even after restart.
  await store.refresh();
  const { io, snapshots, evictor } = createIo(app.server, store, log);

  await app.listen({ port: config.PORT, host: config.HOST });

  // Temporary storage watcher: editing clones use a sliding TTL; external previews use a
  // fixed one-hour deadline. Resolve() also enforces preview expiry synchronously, while this
  // minute sweep removes files even when nobody tries the old link again.
  const sweep = async (): Promise<void> => {
    try {
      const n = await store.sweepEphemeral(config.EPHEMERAL_TTL_MS);
      const previews = await store.sweepExpiredPreviews();
      // eslint-disable-next-line no-console
      if (n > 0) console.log(`[@d2/server] swept ${n} expired ephemeral map(s)`);
      // eslint-disable-next-line no-console
      if (previews > 0) console.log(`[@d2/server] swept ${previews} expired preview map(s)`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[@d2/server] ephemeral sweep failed:", e);
    }
  };
  void sweep();
  const sweeper = setInterval(() => void sweep(), 60 * 1000);

  // eslint-disable-next-line no-console
  console.log(
    `[@d2/server] listening on http://localhost:${config.PORT} ` +
      `(assets: ${config.ASSETS_DIR})`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[@d2/server] ${signal} -> shutting down`);
    clearInterval(sweeper);
    evictor.dispose(); // cancel any pending room evictions (their timers are unref'd anyway)
    io.close();
    await app.close();
    // Flush pending durable op-log writes BEFORE exit — otherwise a just-acked edit whose
    // appendFile is still queued is lost on restart (the very event the log must survive).
    try {
      await log.flush();
      await snapshots.flush(); // persist any in-flight gz snapshot too (derived, but avoids a re-fold)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[@d2/server] EditLog flush failed on shutdown:", e);
    }
    log.dispose(); // stop the retry/fsync timers now that the tail is flushed
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
