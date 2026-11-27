/**
 * Share keys of the mod comparison (config.MOD_SHARE_KEYS): a hidden mod's full tables are
 * served only to a request with a key, by logical name and by hash alike; with a key the
 * hidden mods are listed too. Static files and the mod routes run over a synthetic store.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";

// ASSETS_DIR (the static root) has to point at the synthetic store BEFORE config.ts is evaluated.
const storeDir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const dir = mkdtempSync(j(tmpdir(), "d2-mod-share-"));
  process.env.ASSETS_DIR = dir;
  return dir;
});

import { rmSync } from "node:fs";
import { MOD_SHARE_KEY_HEADER, REST, type ModFileList, type ModList } from "@d2/socket-contract";
import { config } from "../src/config";
import { registerModRoutes } from "../src/http/routes.mods";
import { registerStatic } from "../src/http/static";
import { ModRegistry } from "../src/mods/modRegistry";
import { hasShareKey } from "../src/mods/shareKey";
import { writeModStore } from "./modStoreFixture";

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const UNITS = Buffer.from("the closed beta's own units table");
const LRACE = Buffer.from("a race table both mods have");
const CAPITAL = Buffer.from("closed capital screens");
const KEY = "k".repeat(20) + "-share-key-for-tests-0123456789";
const keys = config.MOD_SHARE_KEYS as string[];

let app: FastifyInstance;
let mods: ModRegistry;

beforeAll(async () => {
  writeModStore(
    storeDir,
    [
      {
        id: "alpha",
        files: { "unitCatalog.json": [{ id: "G000UU0001" }], "tables/Gunits.dbf": UNITS, "tables/Lrace.dbf": LRACE, "capital.dat": CAPITAL },
      },
      { id: "beta", files: { "unitCatalog.json": [], "tables/Lrace.dbf": LRACE } },
    ],
    "beta",
  );
  mods = new ModRegistry(storeDir, ["alpha"]);
  app = Fastify();
  await registerStatic(app, { isPrivateBlob: (b) => mods.isPrivateBlob(b), hasKey: (req) => hasShareKey(req) });
  await registerModRoutes(app, mods);
  await app.ready();
});

afterEach(() => {
  keys.length = 0;
});

afterAll(async () => {
  await app.close();
  rmSync(storeDir, { recursive: true, force: true });
});

const get = (url: string, key?: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers: key ? { [MOD_SHARE_KEY_HEADER]: key, ...headers } : headers });
const assetBase = (id: string) => mods.get(id).info.assetBase;
const blobUrl = (data: Buffer, ext: string) => {
  const sha = sha256(data);
  return `/assets/blobs/${sha.slice(0, 2)}/${sha}.${ext}`;
};

describe("a hidden mod's full tables", () => {
  it("are not listed or served without a key, by name or by hash", async () => {
    keys.push(KEY);
    const list = (await get(REST.mods)).json() as ModList;
    expect(list.mods.map((m) => m.id)).toEqual(["beta"]);
    const files = await get(REST.modFiles("alpha"));
    expect(files.statusCode).toBe(200);
    expect(Object.keys((files.json() as ModFileList).files)).toEqual(["unitCatalog.json"]);
    expect(files.headers.vary).toBe(MOD_SHARE_KEY_HEADER);
    expect(files.headers.etag).toBe(`"${mods.get("alpha").rev}"`);
    // its other files answer as before (hidden for the eye only)
    expect((await get(`${assetBase("alpha")}/unitCatalog.json`)).statusCode).toBe(200);
    for (const name of ["tables/Gunits.dbf", "tables/Lrace.dbf", "capital.dat"]) {
      expect((await get(`${assetBase("alpha")}/${name}`)).statusCode).toBe(404);
    }
    expect((await get(blobUrl(UNITS, "dbf"))).statusCode).toBe(404);
    expect((await get(blobUrl(CAPITAL, "dat"))).statusCode).toBe(404);
    // a table a shown mod has too is public through that mod anyway
    expect((await get(blobUrl(LRACE, "dbf"))).statusCode).toBe(200);
    expect((await get(`${assetBase("beta")}/tables/Lrace.dbf`)).statusCode).toBe(200);
  });

  it("a wrong key, or a key when none is configured, changes nothing", async () => {
    expect(((await get(REST.mods, KEY)).json() as ModList).mods.map((m) => m.id)).toEqual(["beta"]);
    expect((await get(blobUrl(UNITS, "dbf"), KEY)).statusCode).toBe(404);
    keys.push(KEY);
    expect(((await get(REST.mods, KEY + "x")).json() as ModList).mods.map((m) => m.id)).toEqual(["beta"]);
    expect((await get(`${assetBase("alpha")}/tables/Gunits.dbf`, KEY.slice(0, -1))).statusCode).toBe(404);
    expect(Object.keys(((await get(REST.modFiles("alpha"), "nope")).json() as ModFileList).files)).toEqual(["unitCatalog.json"]);
  });

  it("are listed and served with a key, privately", async () => {
    keys.push(KEY);
    const list = (await get(REST.mods, KEY)).json() as ModList;
    expect(list.mods.map((m) => m.id).sort()).toEqual(["alpha", "beta"]);

    const files = await get(REST.modFiles("alpha"), KEY);
    expect((files.json() as ModFileList).files).toEqual({
      "unitCatalog.json": sha256(JSON.stringify([{ id: "G000UU0001" }])),
      "tables/Gunits.dbf": sha256(UNITS),
      "tables/Lrace.dbf": sha256(LRACE),
      "capital.dat": sha256(CAPITAL),
    });
    // its own ETag: a keyless answer cached by the browser is never revalidated into it
    const rev = mods.get("alpha").rev;
    expect(files.headers.etag).toBe(`"${rev}-k"`);
    expect((await get(REST.modFiles("alpha"), KEY, { "if-none-match": `"${rev}"` })).statusCode).toBe(200);
    expect((await get(REST.modFiles("alpha"), KEY, { "if-none-match": `"${rev}-k"` })).statusCode).toBe(304);

    const units = await get(`${assetBase("alpha")}/tables/Gunits.dbf`, KEY);
    expect(units.statusCode).toBe(200);
    expect(units.rawPayload.equals(UNITS)).toBe(true);
    expect(units.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    const byHash = await get(blobUrl(CAPITAL, "dat"), KEY);
    expect(byHash.statusCode).toBe(200);
    expect(byHash.rawPayload.equals(CAPITAL)).toBe(true);
    expect(byHash.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    // a public blob stays public
    expect((await get(blobUrl(LRACE, "dbf"), KEY)).headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("a shown mod's tables need no key", async () => {
    const files = (await get(REST.modFiles("beta"))).json() as ModFileList;
    expect(Object.keys(files.files).sort()).toEqual(["tables/Lrace.dbf", "unitCatalog.json"]);
  });
});

describe("hasShareKey", () => {
  it("matches only a configured key, exactly", () => {
    const req = (v?: string | string[]) => ({ headers: v === undefined ? {} : { [MOD_SHARE_KEY_HEADER]: v } });
    expect(hasShareKey(req(KEY), [KEY])).toBe(true);
    expect(hasShareKey(req([KEY, "x"]), [KEY])).toBe(true);
    expect(hasShareKey(req(KEY), [])).toBe(false);
    expect(hasShareKey(req(), [KEY])).toBe(false);
    expect(hasShareKey(req(""), [KEY])).toBe(false);
    expect(hasShareKey(req(KEY.toUpperCase()), [KEY])).toBe(false);
    expect(hasShareKey(req("x".repeat(300)), ["x".repeat(300)])).toBe(false);
  });
});
