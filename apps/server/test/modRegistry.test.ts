/**
 * ModContext / ModRegistry: everything the server derives from a mod's generated files is
 * cached per mod; a missing catalog degrades instead of failing, and a failed read is never
 * cached. The registry serves the mods of the asset store, or — when ASSETS_DIR still has
 * the flat pre-multi-mod layout — one implicit `default` mod. No game install needed: the
 * catalogs are tiny synthetic files in a temp dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModContext, ModRegistry, DEFAULT_MOD_ID } from "../src/mods/modRegistry";
import { writeModStore, idSets } from "./modStoreFixture";

let dir: string;
let otherDir: string;

const writeJson = (root: string, name: string, value: unknown): void =>
  writeFileSync(join(root, name), JSON.stringify(value), "utf-8");

const DECOR = {
  G000MG0001: { id: "g000mg0001", cx: 2, cy: 3, shape: "ruin" },
  G000MG0002: { id: "G000MG0002", shape: "rock" },
};

/** A length-prefixed id field as the game writes it into a .sg. */
const idField = (id: string): number[] => [0x0b, 0, 0, 0, ...[...id].map((c) => c.charCodeAt(0)), 0];
const mapBytes = (...ids: string[]): Uint8Array => new Uint8Array(ids.flatMap(idField));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "d2-mod-test-"));
  otherDir = mkdtempSync(join(tmpdir(), "d2-mod-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of [dir, otherDir]) rmSync(d, { recursive: true, force: true });
});

describe("ModContext catalogs (flat layout)", () => {
  it("reads the talisman template set from itemCatalog.json", async () => {
    writeJson(dir, "itemCatalog.json", [
      { id: "G000IG9001", catKey: "L_TALISMAN" },
      { id: "G000IG0001", catKey: "L_ARMOR" },
    ]);
    const mod = ModContext.flat("m", dir);
    expect([...(await mod.talismanTemplates())]).toEqual(["G000IG9001"]);
  });

  it("degrades to an empty talisman set with ONE warning, and recovers once the catalog exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = ModContext.flat("m", dir);
    expect((await mod.talismanTemplates()).size).toBe(0);
    expect((await mod.talismanTemplates()).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);

    writeJson(dir, "itemCatalog.json", [{ id: "G000IG9001", catKey: "L_TALISMAN" }]);
    expect((await mod.talismanTemplates()).has("G000IG9001")).toBe(true);
  });

  it("builds landmark footprints keyed by UPPERCASE id, defaulting to 1×1", async () => {
    writeJson(dir, "decorCatalog.json", DECOR);
    const mod = ModContext.flat("m", dir);
    const { landmarkSizes, decor } = await mod.catalogSets();
    expect(landmarkSizes["G000MG0001"]).toEqual([2, 3]);
    expect(landmarkSizes["G000MG0002"]).toEqual([1, 1]);
    expect(decor["rock"]).toEqual(["G000MG0002"]);

    const size = await mod.landmarkSizeFn();
    expect(size("g000mg0001")).toEqual([2, 3]);
    expect(size("G000MG9999")).toBeUndefined();
  });

  it("catalogSets throws without decorCatalog.json; landmarkSizeFn degrades but does not latch", async () => {
    const mod = ModContext.flat("m", dir);
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
    const { talismanTemplates, landmarkSize } = await ModContext.flat("m", dir).validationInputs();
    expect(talismanTemplates.has("G000IG9001")).toBe(true);
    expect(landmarkSize("G000MG0001")).toEqual([2, 3]);
  });

  it("serves the manifest and re-reads it when the file changes", async () => {
    const mod = ModContext.flat("m", dir);
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
    const a = ModContext.flat("a", dir);
    const b = ModContext.flat("b", otherDir);
    expect((await a.landmarkSizeFn())("G000MG0001")).toEqual([2, 3]);
    expect((await b.landmarkSizeFn())("G000MG0001")).toEqual([4, 4]);
  });
});

describe("ModRegistry over the flat layout", () => {
  it("has one implicit default mod on the given assets dir", () => {
    const mods = new ModRegistry(dir);
    expect(mods.list().map((m) => m.id)).toEqual([DEFAULT_MOD_ID]);
    expect(mods.default().assetsDir).toBe(dir);
    expect(mods.default().isFlat).toBe(true);
    expect(mods.default().info).toMatchObject({ id: "default", status: "ready", assetBase: "/assets" });
  });

  it("resolves an unknown or missing id to the default mod", () => {
    const mods = new ModRegistry(dir);
    expect(mods.get(DEFAULT_MOD_ID)).toBe(mods.default());
    expect(mods.get("no-such-mod")).toBe(mods.default());
    expect(mods.get(undefined)).toBe(mods.default());
    expect(mods.get(null)).toBe(mods.default());
    expect(mods.has("no-such-mod")).toBe(false);
  });

  it("has nothing to tell mods apart with", async () => {
    expect(await new ModRegistry(dir).analyze(mapBytes("G000UU0001"))).toBeNull();
  });
});

describe("ModRegistry over the asset store", () => {
  const CORE = ["G000UU0001", "G000UU0002"];
  const store = (): void =>
    writeModStore(
      dir,
      [
        {
          id: "alpha",
          name: "Alpha",
          family: "a",
          familyOrder: 1,
          files: {
            "itemCatalog.json": [{ id: "G000IG0001", catKey: "L_TALISMAN" }],
            "decorCatalog.json": DECOR,
            "manifest.json": { manifestVersion: "0.1.0", of: "alpha" },
            "ids.json": idSets({ UU: [...CORE, "G000UU9001"] }),
            "itemicons/g000ig0001.png": Buffer.from("alpha-icon"),
          },
        },
        {
          id: "alpha-2",
          family: "a",
          familyOrder: 2,
          status: "data-only",
          files: { "ids.json": idSets({ UU: [...CORE, "G000UU9001", "G000UU9002"] }) },
        },
        {
          id: "beta",
          family: "b",
          files: {
            "decorCatalog.json": { G000MG0001: { id: "G000MG0001", cx: 5, cy: 5 } },
            "ids.json": idSets({ UU: [...CORE, "G070UU0001"] }),
            "itemicons/g000ig0001.png": Buffer.from("alpha-icon"), // same bytes as alpha's
          },
        },
      ],
      "beta",
    );

  it("lists the store's mods with a revision and an asset base, and honours the default", () => {
    store();
    const mods = new ModRegistry(dir);
    expect(mods.list().map((m) => m.id)).toEqual(["alpha", "alpha-2", "beta"]);
    expect(mods.default().id).toBe("beta");
    const info = mods.get("alpha").info;
    expect(info).toMatchObject({ id: "alpha", name: "Alpha", family: "a", familyOrder: 1, status: "ready" });
    expect(info.rev).toMatch(/^[0-9a-f]{12}$/);
    expect(info.assetBase).toBe(`/assets/mods/alpha/${info.rev}`);
    expect(mods.get("alpha-2").info.status).toBe("data-only");
    expect(mods.get("alpha").isFlat).toBe(false);
  });

  it("resolves logical names through each mod's file table; identical files share a blob", async () => {
    store();
    const mods = new ModRegistry(dir);
    const a = mods.get("alpha").filePath("itemicons/g000ig0001.png")!;
    const b = mods.get("beta").filePath("itemicons/g000ig0001.png")!;
    expect(readFileSync(a, "utf-8")).toBe("alpha-icon");
    expect(b).toBe(a);
    expect(mods.get("beta").filePath("itemCatalog.json")).toBeUndefined();
    expect(mods.get("alpha").filePath("../mods/index.json")).toBeUndefined();

    expect([...(await mods.get("alpha").talismanTemplates())]).toEqual(["G000IG0001"]);
    expect((await mods.get("alpha").landmarkSizeFn())("G000MG0001")).toEqual([2, 3]);
    expect((await mods.get("beta").landmarkSizeFn())("G000MG0001")).toEqual([5, 5]);
    expect(await mods.get("alpha").manifest()).toEqual({ manifestVersion: "0.1.0", of: "alpha" });
    await expect(mods.get("beta").manifest()).rejects.toThrow();
  });

  it("matches a map against the mods' id tables", async () => {
    store();
    const mods = new ModRegistry(dir);

    const own = await mods.analyze(mapBytes(...CORE, "G070UU0001"));
    expect(own!.detection).toMatchObject({ status: "detected", modId: "beta" });
    expect(own!.all.map((c) => [c.modId, c.missing])).toEqual([["beta", 0], ["alpha-2", 1], ["alpha", 1]]);

    // fits both versions of family a: the data-only one is reported but not chosen
    const fam = await mods.analyze(mapBytes(...CORE, "G000UU9001"));
    expect(fam!.detection).toMatchObject({ status: "detected", modId: "alpha" });
    expect(fam!.all.find((c) => c.modId === "alpha-2")!.missing).toBe(0);

    // ids every mod has: nothing tells the families apart
    const blank = await mods.analyze(mapBytes(...CORE));
    expect(blank!.detection).toMatchObject({ status: "undetermined", modId: null });
  });

  it("keeps a hidden mod out of sight: not shown, not detected, not the default, not openable", async () => {
    store();
    const hidden: string[] = [];
    const mods = new ModRegistry(dir, hidden);
    expect(mods.visible().map((m) => m.id)).toEqual(["alpha", "alpha-2", "beta"]);
    expect(mods.canOpen("beta")).toBe(true);

    hidden.push("beta"); // read live
    expect(mods.isHidden("beta")).toBe(true);
    expect(mods.list().map((m) => m.id)).toEqual(["alpha", "alpha-2", "beta"]); // still installed
    expect(mods.visible().map((m) => m.id)).toEqual(["alpha", "alpha-2"]);
    expect(mods.get("beta").id).toBe("beta"); // its files are still served
    expect(mods.default().id).toBe("alpha"); // the store's default is hidden: the first shown ready mod
    expect(mods.canOpen("beta")).toBe(false);
    expect(mods.canOpen("alpha")).toBe(true);
    expect(mods.canOpen("alpha-2")).toBe(false); // data-only, as before
    expect(mods.canOpen("gamma")).toBe(false);

    // beta's own map is matched among the shown mods only
    const own = await mods.analyze(mapBytes(...CORE, "G070UU0001"));
    expect(own!.all.map((c) => c.modId).sort()).toEqual(["alpha", "alpha-2"]);
    expect(own!.detection.modId).not.toBe("beta");
  });

  it("hides nothing when every installed mod is listed as hidden", () => {
    store();
    const mods = new ModRegistry(dir, ["alpha", "alpha-2", "beta"]);
    expect(mods.isHidden("beta")).toBe(false);
    expect(mods.visible().map((m) => m.id)).toEqual(["alpha", "alpha-2", "beta"]);
    expect(mods.default().id).toBe("beta");
  });

  it("picks up a rebuilt store and changes its revision", () => {
    store();
    const mods = new ModRegistry(dir);
    const before = mods.revision;
    const revBefore = mods.get("alpha").rev;

    writeModStore(dir, [{ id: "alpha", files: { "manifest.json": { manifestVersion: "0.1.0", of: "alpha v2" } } }]);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, "mods", "index.json"), later, later);
    mods.refresh(true);

    expect(mods.revision).toBeGreaterThan(before);
    expect(mods.list().map((m) => m.id)).toEqual(["alpha"]);
    expect(mods.default().id).toBe("alpha"); // no default named: the first ready mod
    expect(mods.get("alpha").rev).not.toBe(revBefore);
  });

  it("skips a mod whose manifest is unusable and falls back to flat when none is left", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store();
    writeFileSync(join(dir, "mods", "beta", "mod.json"), "{ not json", "utf-8");
    const mods = new ModRegistry(dir);
    expect(mods.list().map((m) => m.id)).toEqual(["alpha", "alpha-2"]);
    expect(mods.default().id).toBe("alpha"); // the named default is gone: first READY mod
    expect(warn).toHaveBeenCalled();

    writeFileSync(join(dir, "mods", "index.json"), "garbage", "utf-8");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, "mods", "index.json"), later, later);
    mods.refresh(true);
    expect(mods.list().map((m) => m.id)).toEqual([DEFAULT_MOD_ID]);
    expect(mods.default().isFlat).toBe(true);
  });
});
