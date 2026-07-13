import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Give each test FILE its own UPLOAD_DIR/PROJECTS_DIR/ROOMS_DIR (tmpdir) so concurrently-run
    // files don't race the shared var/uploads/registry.json — the lost update that flaked the
    // ephemeral-sweeper test. Runs before each file imports config.ts (see the file's header).
    setupFiles: ["./test/setup.dirs.ts"],
    // generation.audit.test.ts runs ~60 MarkovJunior generations and starves parallel
    // test files of CPU — the default 5s timeout flaked ownership listings. 30s is not
    // a license for slow tests; it absorbs the parallel-file contention.
    testTimeout: 30_000,
    // beforeAll hooks parse full scenarios; the full model parse (players/subraces/satellites)
    // legitimately costs more than the 10s default under parallel-file CPU contention.
    hookTimeout: 30_000,
  },
});
