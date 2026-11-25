/**
 * ModContext / ModRegistry: everything the server derives from a mod's generated catalogs is
 * cached per mod, a missing catalog degrades instead of failing, and a failed read is never
 * cached — a catalog that appears later (a finished pipeline run) is picked up without a
 * restart. No game install needed: the catalogs are tiny synthetic files in a temp dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModContext, ModRegistry, DEFAULT_MOD_ID } from "../src/mods/modRegistry";

let dir: string;
let otherDir: string;

const writeJson = (root: string, name: string, value: unknown): void =>
  writeFileSync(join(root, name), JSON.stringify(value), "utf-8");

const DECOR = {
  G000MG0001: { id: "g000mg0001", cx: 2, cy: 3, shape: "ruin" },
  G000MG0002: { id: "G000MG0002", shape: "rock" },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "d2-mod-test-"));
  otherDir = mkdtempSync(join(tmpdir(), "d2-mod-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of [dir, otherDir]) rmSync(d, { recursive: true, force: true });
});

describe("ModContext catalogs", () => {
  it("reads the talisman template set from itemCatalog.json", async () => {
    writeJson(dir, "itemCatalog.json", [
      { id: "G000IG9001", catKey: "L_TALISMAN" },
      { id: "G000IG0001", catKey: "L_ARMOR" },
    ]);
    const mod = new ModContext("m", dir);
    expect([...(await mod.talismanTemplates())]).toEqual(["G000IG9001"]);
  });

  it("degrades to an empty talisman set with ONE warning, and recovers once the catalog exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = new ModContext("m", dir);
    expect((await mod.talismanTemplates()).size).toBe(0);
    expect((await mod.talismanTemplates()).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);

    writeJson(dir, "itemCatalog.json", [{ id: "G000IG9001", catKey: "L_TALISMAN" }]);
    expect((await mod.talismanTemplates()).has("G000IG9001")).toBe(true);
  });

  it("builds landmark footprints keyed by UPPERCASE id, defaulting to 1×1", async () => {
    writeJson(dir, "decorCatalog.json", DECOR);
    const mod = new ModContext("m", dir);
    const { landmarkSizes, decor } = await mod.catalogSets();
    expect(landmarkSizes["G000MG0001"]).toEqual([2, 3]);
    expect(landmarkSizes["G000MG0002"]).toEqual([1, 1]);
    expect(decor["rock"]).toEqual(["G000MG0002"]);

    const size = await mod.landmarkSizeFn();
    expect(size("g000mg0001")).toEqual([2, 3]);
    expect(size("G000MG9999")).toBeUndefined();
  });

  it("catalogSets throws without decorCatalog.json; landmarkSizeFn degrades but does not latch", async () => {
    const mod = new ModContext("m", dir);
    await expect(mod.catalogSets()).rejects.toThrow();

    const degraded = await mod.landmarkSizeFn();
    expect(degraded("G000MG0001")).toBeUndefined();

    // the catalog appears later: the SAME context must now resolve real footprints
    writeJson(dir, "decorCatalog.json", DECOR);
    const size = await mod.landmarkSizeFn();
    expect(size("G000MG0001")).toEqual([2, 3]);
  });

  it("validationInputs bundles the talisman set and the footprint resolver", async () => {
    writeJson(dir, "itemCatalog.json", [{ id: "G000IG9001", catKey: "L_TALISMAN" }]);
    writeJson(dir, "decorCatalog.json", DECOR);
    const { talismanTemplates, landmarkSize } = await new ModContext("m", dir).validationInputs();
    expect(talismanTemplates.has("G000IG9001")).toBe(true);
    expect(landmarkSize("G000MG0001")).toEqual([2, 3]);
  });

  it("serves the manifest and re-reads it when the file changes", async () => {
    const mod = new ModContext("m", dir);
    await expect(mod.manifest()).rejects.toThrow();

    writeJson(dir, "manifest.json", { manifestVersion: "0.1.0", n: 1 });
    expect(await mod.manifest()).toEqual({ manifestVersion: "0.1.0", n: 1 });

    writeJson(dir, "manifest.json", { manifestVersion: "0.1.0", n: 2 });
    // force a different mtime even on coarse-grained filesystems
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, "manifest.json"), later, later);
    expect(await mod.manifest()).toEqual({ manifestVersion: "0.1.0", n: 2 });
  });

  it("keeps the data of two mods apart", async () => {
    writeJson(dir, "decorCatalog.json", DECOR);
    writeJson(otherDir, "decorCatalog.json", { G000MG0001: { id: "G000MG0001", cx: 4, cy: 4 } });
    const a = new ModContext("a", dir);
    const b = new ModContext("b", otherDir);
    expect((await a.landmarkSizeFn())("G000MG0001")).toEqual([2, 3]);
    expect((await b.landmarkSizeFn())("G000MG0001")).toEqual([4, 4]);
  });
});

describe("ModRegistry", () => {
  it("has one implicit default mod on the given assets dir, used for every map", () => {
    const mods = new ModRegistry(dir);
    expect(mods.list().map((m) => m.id)).toEqual([DEFAULT_MOD_ID]);
    expect(mods.default().assetsDir).toBe(dir);
    expect(mods.forMap("any-map-id")).toBe(mods.default());
  });

  it("resolves an unknown or missing id to the default mod", () => {
    const mods = new ModRegistry(dir);
    expect(mods.get(DEFAULT_MOD_ID)).toBe(mods.default());
    expect(mods.get("no-such-mod")).toBe(mods.default());
    expect(mods.get(undefined)).toBe(mods.default());
    expect(mods.get(null)).toBe(mods.default());
  });
});
