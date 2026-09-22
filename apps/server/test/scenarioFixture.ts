import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createBlankMap } from "@d2/sg-parser";
import { config } from "../src/config.js";

/** One real on-disk install map for HTTP ownership/upload tests. These tests exercise
 * discovery and parsing, but their cost must not scale with the developer's game library.
 * setup.dirs.ts owns and removes the per-file base; other suites retain their real roots. */
export async function installScenarioFixture(): Promise<{ bytes: Buffer; restore: () => void }> {
  const base = dirname(config.UPLOAD_DIR);
  if (!/^d2-server-test-[^/\\]+$/.test(relative(tmpdir(), base))) {
    throw new Error("Scenario fixtures require the isolated server test storage setup");
  }
  const root = join(base, "install-scenarios");
  const bytes = Buffer.from(createBlankMap({ size: 48, name: "HTTP fixture", races: ["empire"] }));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "fixture.sg"), bytes);
  // config modules are isolated per test file by Vitest. Change only this suite's
  // roots, leaving the production scanner/router and all storage configuration real.
  const originalRoots = config.SCENARIO_ROOTS.slice();
  config.SCENARIO_ROOTS.splice(0, config.SCENARIO_ROOTS.length, root);
  return {
    bytes,
    restore: () => { config.SCENARIO_ROOTS.splice(0, config.SCENARIO_ROOTS.length, ...originalRoots); },
  };
}
