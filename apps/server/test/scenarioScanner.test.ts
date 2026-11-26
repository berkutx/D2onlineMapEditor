/**
 * Scenario discovery: the per-mod folders of MOD_SCENARIO_DIR, and the header cache — a
 * listing reads a file again only when it changed (mtime/size) and forgets files that are gone.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlankMap } from "@d2/sg-parser";
import { modScenarioDirRoots } from "../src/config";
import { scanScenarios } from "../src/ingest/scenarioScanner";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "d2-scan-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MOD_SCENARIO_DIR", () => {
  it("makes every sub-folder the mod its name says", async () => {
    const root = join(dir, "mods");
    await mkdir(join(root, "semga-2", "Campaign"), { recursive: true });
    await mkdir(join(root, "nazar-legacy", "Exports"), { recursive: true });
    await mkdir(join(root, ".partial"), { recursive: true });
    await writeFile(join(root, "README.txt"), "not a mod");
    expect(modScenarioDirRoots(root)).toEqual([
      { modId: "nazar-legacy", path: join(root, "nazar-legacy") },
      { modId: "semga-2", path: join(root, "semga-2") },
    ]);
  });

  it("is empty while the folder does not exist", () => {
    expect(modScenarioDirRoots(join(dir, "nowhere"))).toEqual([]);
  });
});

describe("scanScenarios", () => {
  it("lists a mod's map under its saga and sees it change and go", async () => {
    const saga = join(dir, "scan", "semga-2", "Campaign", "Империя");
    await mkdir(saga, { recursive: true });
    const file = join(saga, "1.sg");
    const roots = [{ path: join(dir, "scan", "semga-2"), modId: "semga-2" }];

    await writeFile(file, createBlankMap({ size: 48, name: "Первая", races: ["empire"] }));
    const first = await scanScenarios(roots);
    expect(first.entries.map((e) => [e.name, e.campaign, e.mapSize])).toEqual([["Первая", "Империя", 48]]);
    expect([...first.registry.values()].map((r) => r.modId)).toEqual(["semga-2"]);

    // the same path, new content: the cached header must not outlive the change
    await writeFile(file, createBlankMap({ size: 72, name: "Вторая", races: ["empire"] }));
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    const second = await scanScenarios(roots);
    expect(second.entries.map((e) => [e.name, e.mapSize])).toEqual([["Вторая", 72]]);

    await rm(file);
    expect((await scanScenarios(roots)).entries).toEqual([]);
  });

  it("groups a map by its folders below the root, so same-named sagas stay apart", async () => {
    const root = join(dir, "groups", "semga-2");
    const put = async (rel: string[], name: string) => {
      await mkdir(join(root, ...rel.slice(0, -1)), { recursive: true });
      await writeFile(join(root, ...rel), createBlankMap({ size: 48, name, races: ["empire"] }));
    };
    await put(["Campaign", "Империя", "1.sg"], "Одна");
    await put(["Campaign", "Возвращение Галлеана", "Империя", "1.SG"], "Другая");
    await put(["Exports", "x.sg"], "Своя");
    await put(["top.sg"], "Сверху");
    const { entries } = await scanScenarios([{ path: root, modId: "semga-2" }]);
    expect(Object.fromEntries(entries.map((e) => [e.name, e.campaign]))).toEqual({
      Одна: "Империя",
      Другая: "Возвращение Галлеана / Империя",
      Своя: "Exports",
      Сверху: "semga-2",
    });
  });
});
