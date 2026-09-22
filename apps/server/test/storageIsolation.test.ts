import { describe, expect, it } from "vitest";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../src/config.js";

describe("server test writable storage isolation", () => {
  it("keeps every writable service directory inside the per-file temporary sandbox", () => {
    const roots = [config.UPLOAD_DIR, config.PROJECTS_DIR, config.ROOMS_DIR, config.LLM_DIR];
    const base = dirname(config.UPLOAD_DIR);
    const temporaryName = relative(tmpdir(), base);
    expect(temporaryName).toMatch(/^d2-server-test-[^/\\]+$/);
    expect(new Set(roots).size).toBe(roots.length);
    for (const root of roots) {
      expect(dirname(root)).toBe(base);
      const inside = relative(base, root);
      expect(isAbsolute(inside)).toBe(false);
      expect(inside.startsWith(`..${sep}`)).toBe(false);
      const fromRepo = relative(config.repoRoot, root);
      expect(isAbsolute(fromRepo) || fromRepo === ".." || fromRepo.startsWith(`..${sep}`)).toBe(true);
    }
  });
});
