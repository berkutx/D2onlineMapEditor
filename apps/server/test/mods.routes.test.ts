/**
 * Mods over HTTP, against a synthetic two-mod asset store: the mod list, a mod's files by
 * logical name (immutable under the current revision), and how a map gets its mod — the
 * mod's own scenario folder, an explicit choice, or detection from the ids it references.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { join, dirname } from "node:path";
import { REST, type MapMeta, type ModList, type ScenarioEntry } from "@d2/socket-contract";

// ASSETS_DIR has to point at the synthetic store BEFORE config.ts is evaluated.
const storeDir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const dir = mkdtempSync(j(tmpdir(), "d2-mod-store-"));
  process.env.ASSETS_DIR = dir;
  return dir;
});

import { rmSync, utimesSync } from "node:fs";
import { collectGlobalIds, createBlankMap } from "@d2/sg-parser";
import { emptyProject } from "@d2/map-edit";
import { buildApp } from "../src/app";
import { config } from "../src/config";
import { installScenarioFixture } from "./scenarioFixture";
import { idSets, writeModStore } from "./modStoreFixture";

let app: FastifyInstance;
let restoreScenarioRoots: (() => void) | undefined;
let fixtureId = "";
let mods: ModList;
/** What the realtime layer is told: every change of the mod a map is opened against. */
const changes: { id: string; modId: string }[] = [];

const OWNER = "mod-owner-aaaa";
const STRANGER = "mod-stranger-bbbb";
const ICON = Buffer.from("icon-bytes");

const get = (url: string, clientId?: string) =>
  app.inject({ method: "GET", url, headers: clientId ? { "x-client-id": clientId } : {} });
const metaOf = async (id: string, clientId?: string): Promise<MapMeta> => {
  const res = await get(REST.mapMeta(id), clientId);
  expect(res.statusCode).toBe(200);
  return res.json() as MapMeta;
};
const newMap = (payload: Record<string, unknown>, clientId = OWNER) =>
  app.inject({
    method: "POST",
    url: REST.mapNew,
    headers: { "x-client-id": clientId },
    payload: { size: 48, fill: "default", name: "mod-test", races: ["empire"], ...payload },
  });
const infoOf = (id: string) => mods.mods.find((m) => m.id === id)!;

beforeAll(async () => {
  // alpha defines every id a blank empire map references; beta lacks the units
  const refs = collectGlobalIds(createBlankMap({ size: 48, name: "probe", races: ["empire"] }));
  expect(refs["UU"]?.length ?? 0).toBeGreaterThan(0);
  writeModStore(
    storeDir,
    [
      {
        id: "alpha",
        name: "Alpha",
        family: "a",
        familyOrder: 1,
        files: {
          "ids.json": idSets(refs),
          "unitCatalog.json": [{ id: "G000UU0001", name: "alpha unit" }],
          "itemCatalog.json": [],
          "decorCatalog.json": {},
          "manifest.json": { manifestVersion: "0.1.0", of: "alpha" },
          "itemicons/g000ig0001.png": ICON,
          // alpha's own tables: the empire's guardian has 250 hit points, not the reference 900
          "profile.json": {
            schemaVersion: 1,
            races: [
              {
                key: "empire", raceId: "G000RR0000", raceType: 0, name: "Империя", playable: true,
                guardian: "G000UU3001", guardianHp: 250, leader: "G000UU0019", leaderHp: 150,
                lord: "G000LR0003", terrain: 1,
              },
            ],
          },
        },
      },
      {
        id: "beta",
        name: "Beta",
        family: "b",
        files: {
          "ids.json": idSets({ ...refs, UU: [] }),
          "unitCatalog.json": [{ id: "G000UU0001", name: "beta unit" }],
          "manifest.json": { manifestVersion: "0.1.0", of: "beta" },
          "itemicons/g000ig0001.png": ICON,
        },
      },
    ],
    "beta",
  );
  const fixture = await installScenarioFixture();
  restoreScenarioRoots = fixture.restore;
  const built = await buildApp();
  app = built.app;
  built.store.onModChanged((id, modId) => changes.push({ id, modId }));
  await app.ready();
  mods = (await get(REST.mods)).json() as ModList;
  const list = (await get(REST.scenarios)).json() as ScenarioEntry[];
  fixtureId = list.find((e) => e.source === "install")!.id;
});

afterAll(async () => {
  try {
    if (app) await app.close();
  } finally {
    restoreScenarioRoots?.();
    rmSync(storeDir, { recursive: true, force: true });
  }
});

describe("GET /api/mods", () => {
  it("lists the store's mods with their asset base and the default mod", async () => {
    const res = await get(REST.mods);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(mods.defaultModId).toBe("beta");
    expect(mods.mods.map((m) => m.id)).toEqual(["alpha", "beta"]);
    const alpha = infoOf("alpha");
    expect(alpha).toMatchObject({ name: "Alpha", family: "a", familyOrder: 1, status: "ready" });
    expect(alpha.assetBase).toBe(`/assets/mods/alpha/${alpha.rev}`);
    expect(alpha.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a mod's files", () => {
  it("serves a file by logical name, immutable under the current revision", async () => {
    const res = await get(`${infoOf("alpha").assetBase}/unitCatalog.json`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual([{ id: "G000UU0001", name: "alpha unit" }]);

    // the same logical name is a different file in the other mod
    expect((await get(`${infoOf("beta").assetBase}/unitCatalog.json`)).json()).toEqual([
      { id: "G000UU0001", name: "beta unit" },
    ]);
    const icon = await get(`${infoOf("alpha").assetBase}/itemicons/g000ig0001.png`);
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/png");
    expect(icon.rawPayload.equals(ICON)).toBe(true);
  });

  it("redirects a stale revision to the current one without caching the detour", async () => {
    const res = await get("/assets/mods/alpha/000000000000/unitCatalog.json");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${infoOf("alpha").assetBase}/unitCatalog.json`);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("404s for unknown mods and files, and never serves the store's bookkeeping", async () => {
    const base = infoOf("alpha").assetBase;
    for (const url of [
      `${base}/nope.json`,
      `/assets/mods/gamma/${infoOf("alpha").rev}/unitCatalog.json`,
      `${base}/..%2F..%2Findex.json`,
      "/assets/mods/index.json",
      "/assets/mods/alpha/mod.json",
    ]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
  });

  it("serves the atlas manifest per mod", async () => {
    expect((await get(`${REST.assetsManifest}?mod=alpha`)).json()).toEqual({ manifestVersion: "0.1.0", of: "alpha" });
    expect((await get(REST.assetsManifest)).json()).toEqual({ manifestVersion: "0.1.0", of: "beta" }); // default mod
    expect((await get(`${REST.assetsManifest}?mod=gamma`)).statusCode).toBe(404);
  });
});

describe("the mod of a map", () => {
  it("detects the mod of a map from the ids it references", async () => {
    const meta = await metaOf(fixtureId);
    expect(meta.mod).toMatchObject({ id: "alpha", source: "detected", missing: 0, scriptMissing: 0 });
    expect(meta.mod!.candidates!.map((c) => c.modId)).toEqual(["alpha", "beta"]);
    expect(meta.mod!.candidates![1]!.missing).toBeGreaterThan(0);
    expect(meta.modEditable).toBeUndefined(); // an install map: nobody's to re-assign

    const list = (await get(REST.scenarios)).json() as ScenarioEntry[];
    expect(list.find((e) => e.id === fixtureId)!.mod).toBe("alpha");
  });

  it("a map in a mod's own scenario folder is that mod's, whatever its ids say", async () => {
    const root = join(dirname(config.UPLOAD_DIR), "install-scenarios");
    const roots = config.MOD_SCENARIO_ROOTS as { path: string; modId: string }[];
    roots.push({ path: root, modId: "beta" });
    try {
      await get(REST.scenarios); // rescan: the folder now belongs to beta
      const meta = await metaOf(fixtureId);
      expect(meta.mod).toMatchObject({ id: "beta", source: "install" });
      expect(meta.mod!.missing).toBeGreaterThan(0);
      expect(Object.keys(meta.mod!.missingByTable!)).toEqual(["UU"]);
    } finally {
      roots.length = 0;
      await get(REST.scenarios); // rescan without the mod root
    }
    expect((await metaOf(fixtureId)).mod).toMatchObject({ id: "alpha", source: "detected" });
  });

  it("a new map records the mod it was made for; an unknown mod is refused", async () => {
    expect((await newMap({ modId: "gamma" })).statusCode).toBe(400);

    const created = await newMap({ modId: "beta" });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    const meta = await metaOf(id, OWNER);
    expect(meta.mod).toMatchObject({ id: "beta", source: "choice" });
    expect(meta.mod!.missing).toBeGreaterThan(0); // beta lacks the units the blank map uses
    expect(meta.modEditable).toBe(true);
    expect((await metaOf(id, STRANGER)).modEditable).toBeUndefined();

    // without a choice the server's default mod is recorded
    const plain = (await newMap({})).json() as { id: string };
    expect((await metaOf(plain.id, OWNER)).mod).toMatchObject({ id: "beta", source: "choice" });
  });

  it("only the owner re-assigns an uploaded map's mod; clearing it falls back to detection", async () => {
    const id = ((await newMap({ modId: "beta" })).json() as { id: string }).id;
    const put = (modId: unknown, clientId?: string) =>
      app.inject({
        method: "PUT",
        url: REST.mapMod(id),
        headers: clientId ? { "x-client-id": clientId } : {},
        payload: { modId },
      });

    expect((await put("alpha", STRANGER)).statusCode).toBe(403);
    expect((await put("alpha")).statusCode).toBe(403);
    expect((await put("gamma", OWNER)).statusCode).toBe(400);

    const changed = await put("alpha", OWNER);
    expect(changed.statusCode).toBe(200);
    expect((changed.json() as MapMeta).mod).toMatchObject({ id: "alpha", source: "choice", missing: 0 });

    const cleared = await put(null, OWNER);
    expect((cleared.json() as MapMeta).mod).toMatchObject({ id: "alpha", source: "detected" });

    // The open editors of the map are told — once per change of the mod IN EFFECT. Clearing
    // the choice above kept the map on alpha (now by detection), so that was not one; the
    // refused requests were not either.
    expect(changes.filter((c) => c.id === id)).toEqual([{ id, modId: "alpha" }]);
    changes.length = 0;
    await put("beta", OWNER);
    await put("beta", OWNER); // same mod again: nothing to tell
    expect(changes).toEqual([{ id, modId: "beta" }]);

    // an install map has no owner
    const install = await app.inject({
      method: "PUT",
      url: REST.mapMod(fixtureId),
      headers: { "x-client-id": OWNER },
      payload: { modId: "beta" },
    });
    expect(install.statusCode).toBe(403);
  });

  it("a clone stays on its source's mod", async () => {
    const id = ((await newMap({ modId: "beta" })).json() as { id: string }).id;
    const res = await app.inject({ method: "POST", url: REST.mapClone(id), headers: { "x-client-id": STRANGER } });
    expect(res.statusCode).toBe(201);
    const copy = (res.json() as { id: string }).id;
    expect((await metaOf(copy, STRANGER)).mod).toMatchObject({ id: "beta", source: "choice" });
  });

  it("builds a new map from the faction data of the mod it is made for", async () => {
    const hpOfCapitalGuard = async (modId: string): Promise<number> => {
      const id = ((await newMap({ modId })).json() as { id: string }).id;
      const doc = (await get(REST.map(id), OWNER)).json() as {
        objects: { type: string; garrison?: ({ hp: number } | null)[] }[];
      };
      return doc.objects.find((o) => o.type === "capital")!.garrison!.find(Boolean)!.hp;
    };
    expect(await hpOfCapitalGuard("alpha")).toBe(250); // alpha's profile
    expect(await hpOfCapitalGuard("beta")).toBe(900); // beta has no profile: the reference table
  });

  it("validates a map with its own mod's catalogs", async () => {
    const id = ((await newMap({ modId: "alpha" })).json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: REST.mapValidate(id),
      headers: { "x-client-id": OWNER },
      payload: emptyProject(id),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, identity: true });
  });
});

// LAST: this block rebuilds the store with a different set of mods.
describe("a mod whose graphics are not built yet (data-only)", () => {
  it("cannot be assigned to a map, and a map known to it is matched among the ready mods", async () => {
    const refs = collectGlobalIds(createBlankMap({ size: 48, name: "probe", races: ["empire"] }));
    writeModStore(
      storeDir,
      [
        {
          id: "alpha",
          family: "a",
          familyOrder: 1,
          files: { "ids.json": idSets(refs), "itemCatalog.json": [], "decorCatalog.json": {}, "manifest.json": {} },
        },
        { id: "alpha-2", family: "a", familyOrder: 2, status: "data-only", files: { "ids.json": idSets(refs) } },
      ],
      "alpha",
    );
    const later = new Date(Date.now() + 5000);
    utimesSync(join(storeDir, "mods", "index.json"), later, later);
    await new Promise((r) => setTimeout(r, 1100)); // the registry re-checks the index once a second

    expect((await newMap({ modId: "alpha-2" })).statusCode).toBe(400);
    const id = ((await newMap({ modId: "alpha" })).json() as { id: string }).id;
    const put = await app.inject({
      method: "PUT",
      url: REST.mapMod(id),
      headers: { "x-client-id": OWNER },
      payload: { modId: "alpha-2" },
    });
    expect(put.statusCode).toBe(400);

    const roots = config.MOD_SCENARIO_ROOTS as { path: string; modId: string }[];
    roots.push({ path: join(dirname(config.UPLOAD_DIR), "install-scenarios"), modId: "alpha-2" });
    try {
      await get(REST.scenarios); // rescan: the folder now belongs to the data-only mod
      const meta = await metaOf(fixtureId);
      expect(meta.mod).toMatchObject({ id: "alpha", source: "detected", missing: 0 });
      expect(meta.mod!.candidates!.map((c) => c.modId)).toEqual(["alpha-2", "alpha"]);
    } finally {
      roots.length = 0;
    }
  });
});
