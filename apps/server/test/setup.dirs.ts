/**
 * Per-test-FILE on-disk isolation.
 *
 * MapStore + EditLog persist to config.UPLOAD_DIR / PROJECTS_DIR / ROOMS_DIR, which default to a
 * FIXED repo path (var/uploads, …). vitest runs test files concurrently, so every file that
 * registers a map did a read-modify-write on the SAME var/uploads/registry.json — a lost update
 * that intermittently flaked the ephemeral-sweeper test (a fresh MapStore re-read a registry a
 * concurrent file had clobbered, so a permanent map went missing). It only reproduced under
 * full-suite load; in isolation nothing else touched the file.
 *
 * This setupFile runs BEFORE the test file imports config.ts (which reads these envs at module-eval
 * time), and vitest isolates modules per file (isolate: true, the default), so config picks up a
 * UNIQUE dir per file. mkdtemp gives one base per file; it's removed after the file's tests.
 */
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "d2-server-test-"));
process.env.UPLOAD_DIR = join(base, "uploads");
process.env.PROJECTS_DIR = join(base, "projects");
process.env.ROOMS_DIR = join(base, "rooms");

afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});
