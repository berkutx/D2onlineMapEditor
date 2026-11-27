/**
 * Share keys of the mod comparison (config.MOD_SHARE_KEYS): a hidden mod does not exist for
 * a request without a key — its passport, file list, files and the blobs only it names
 * answer 404 — and with a key (the header, or the cookie the server hands back for the
 * page's pictures) it is listed and served. Static files and the mod routes run over a
 * synthetic store.
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
import { SHARE_KEY_COOKIE, hasShareKey, headerHasShareKey, shareKeyCookie } from "../src/mods/shareKey";
import { writeModStore } from "./modStoreFixture";

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const UNITS = Buffer.from("the closed beta's own units table");
const LRACE = Buffer.from("a race table both mods have");
const CAPITAL = Buffer.from("closed capital screens");
const SHEET = Buffer.from("a picture only the closed beta has");
const SHARED_SHEET = Buffer.from("a picture both mods have");
const ALPHA_UNITS = [{ id: "G000UU0001" }];
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
        files: {
          "unitCatalog.json": ALPHA_UNITS,
          "tables/Gunits.dbf": UNITS,
          "tables/Lrace.dbf": LRACE,
          "capital.dat": CAPITAL,
          "sheets/own.png": SHEET,
          "sheets/shared.png": SHARED_SHEET,
        },
      },
      { id: "beta", files: { "unitCatalog.json": [], "tables/Lrace.dbf": LRACE, "sheets/shared.png": SHARED_SHEET } },
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
/** A request with the key only in the cookie, the way the page's pictures ask. */
const withCookie = (url: string, key: string) => app.inject({ method: "GET", url, headers: { cookie: `theme=dark; ${SHARE_KEY_COOKIE}=${key}` } });
const assetBase = (id: string) => mods.get(id).info.assetBase;
const blobUrl = (data: Buffer | string, ext: string) => {
  const sha = sha256(data);
  return `/assets/blobs/${sha.slice(0, 2)}/${sha}.${ext}`;
};
const ALPHA_ONLY = ["unitCatalog.json", "tables/Gunits.dbf", "capital.dat", "sheets/own.png"];
const alphaOnlyBlobs = () => [blobUrl(JSON.stringify(ALPHA_UNITS), "json"), blobUrl(UNITS, "dbf"), blobUrl(CAPITAL, "dat"), blobUrl(SHEET, "png")];

describe("a hidden mod without a key", () => {
  it("does not exist: no passport, no file list, no file, no blob only it has", async () => {
    keys.push(KEY);
    const list = await get(REST.mods);
    expect((list.json() as ModList).mods.map((m) => m.id)).toEqual(["beta"]);
    expect(list.headers["set-cookie"]).toBeUndefined();
    expect(list.headers.vary).toBe(`${MOD_SHARE_KEY_HEADER}, cookie`);
    const passport = await get(REST.mod("alpha"));
    expect(passport.statusCode).toBe(404);
    expect(passport.headers.vary).toBe(`${MOD_SHARE_KEY_HEADER}, cookie`);
    expect((await get(REST.modFiles("alpha"))).statusCode).toBe(404);
    for (const name of [...ALPHA_ONLY, "tables/Lrace.dbf", "sheets/shared.png"]) {
      expect((await get(`${assetBase("alpha")}/${name}`)).statusCode, name).toBe(404);
    }
    for (const url of alphaOnlyBlobs()) expect((await get(url)).statusCode, url).toBe(404);
    // a file a shown mod has too is public through that mod anyway
    expect((await get(blobUrl(LRACE, "dbf"))).statusCode).toBe(200);
    expect((await get(blobUrl(SHARED_SHEET, "png"))).statusCode).toBe(200);
    expect((await get(`${assetBase("beta")}/tables/Lrace.dbf`)).statusCode).toBe(200);
  });

  it("a wrong key, in the header or the cookie, or a key when none is configured, changes nothing", async () => {
    expect(((await get(REST.mods, KEY)).json() as ModList).mods.map((m) => m.id)).toEqual(["beta"]);
    expect((await get(REST.mods, KEY)).headers["set-cookie"]).toBeUndefined();
    expect((await get(blobUrl(UNITS, "dbf"), KEY)).statusCode).toBe(404);
    expect((await withCookie(blobUrl(SHEET, "png"), KEY)).statusCode).toBe(404);
    keys.push(KEY);
    const wrong = await get(REST.mods, KEY + "x");
    expect((wrong.json() as ModList).mods.map((m) => m.id)).toEqual(["beta"]);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    expect((await get(`${assetBase("alpha")}/tables/Gunits.dbf`, KEY.slice(0, -1))).statusCode).toBe(404);
    expect((await get(REST.modFiles("alpha"), "nope")).statusCode).toBe(404);
    expect((await withCookie(blobUrl(SHEET, "png"), KEY.slice(1))).statusCode).toBe(404);
    expect((await withCookie(REST.mod("alpha"), "")).statusCode).toBe(404);
  });
});

describe("a hidden mod with a key", () => {
  it("is listed and served, privately; the key goes into a cookie for the pictures", async () => {
    keys.push(KEY);
    const list = await get(REST.mods, KEY);
    expect((list.json() as ModList).mods.map((m) => m.id).sort()).toEqual(["alpha", "beta"]);
    expect(list.headers["set-cookie"]).toBe(`${SHARE_KEY_COOKIE}=${KEY}; Path=/; HttpOnly; SameSite=Strict`);
    expect((await get(REST.mod("alpha"), KEY)).statusCode).toBe(200);

    const files = await get(REST.modFiles("alpha"), KEY);
    expect((files.json() as ModFileList).files).toEqual({
      "unitCatalog.json": sha256(JSON.stringify(ALPHA_UNITS)),
      "tables/Gunits.dbf": sha256(UNITS),
      "tables/Lrace.dbf": sha256(LRACE),
      "capital.dat": sha256(CAPITAL),
      "sheets/own.png": sha256(SHEET),
      "sheets/shared.png": sha256(SHARED_SHEET),
    });
    // its own ETag: a list a browser kept from before (without the tables) is never revalidated into it
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

  it("the cookie alone opens its files and pictures, and lists it, without setting the cookie again", async () => {
    keys.push(KEY);
    for (const url of alphaOnlyBlobs()) expect((await withCookie(url, KEY)).statusCode, url).toBe(200);
    const sheet = await withCookie(`${assetBase("alpha")}/sheets/own.png`, KEY);
    expect(sheet.statusCode).toBe(200);
    expect(sheet.rawPayload.equals(SHEET)).toBe(true);
    expect(sheet.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect((await withCookie(REST.modFiles("alpha"), KEY)).statusCode).toBe(200);
    const list = await withCookie(REST.mods, KEY);
    expect((list.json() as ModList).mods.map((m) => m.id).sort()).toEqual(["alpha", "beta"]);
    expect(list.headers["set-cookie"]).toBeUndefined();
  });

  it("a shown mod needs no key", async () => {
    const files = (await get(REST.modFiles("beta"))).json() as ModFileList;
    expect(Object.keys(files.files).sort()).toEqual(["sheets/shared.png", "tables/Lrace.dbf", "unitCatalog.json"]);
  });
});

describe("hasShareKey", () => {
  it("matches only a configured key, exactly, in the header or the cookie", () => {
    const req = (v?: string | string[]) => ({ headers: v === undefined ? {} : { [MOD_SHARE_KEY_HEADER]: v } });
    const cookie = (v: string) => ({ headers: { cookie: v } });
    expect(hasShareKey(req(KEY), [KEY])).toBe(true);
    expect(hasShareKey(req([KEY, "x"]), [KEY])).toBe(true);
    expect(hasShareKey(req(KEY), [])).toBe(false);
    expect(hasShareKey(req(), [KEY])).toBe(false);
    expect(hasShareKey(req(""), [KEY])).toBe(false);
    expect(hasShareKey(req(KEY.toUpperCase()), [KEY])).toBe(false);
    expect(hasShareKey(req("x".repeat(300)), ["x".repeat(300)])).toBe(false);

    expect(hasShareKey(cookie(`${SHARE_KEY_COOKIE}=${KEY}`), [KEY])).toBe(true);
    expect(hasShareKey(cookie(`a=1;  ${SHARE_KEY_COOKIE}=${encodeURIComponent(KEY)} ; b=2`), [KEY])).toBe(true);
    expect(hasShareKey(cookie(`other_${SHARE_KEY_COOKIE}=${KEY}`), [KEY])).toBe(false);
    expect(hasShareKey(cookie(`${SHARE_KEY_COOKIE}=%E0%A4%A`), [KEY])).toBe(false);
    expect(hasShareKey(cookie(`${SHARE_KEY_COOKIE}=${KEY}`), [])).toBe(false);
    // the cookie counts for access, but only the header hands out a cookie
    expect(headerHasShareKey(cookie(`${SHARE_KEY_COOKIE}=${KEY}`), [KEY])).toBe(false);
    expect(headerHasShareKey(req(KEY), [KEY])).toBe(true);
  });

  it("puts the cookie on the site's path", () => {
    const req = { headers: { [MOD_SHARE_KEY_HEADER]: KEY } };
    expect(shareKeyCookie(req, "/map")).toBe(`${SHARE_KEY_COOKIE}=${KEY}; Path=/map/; HttpOnly; SameSite=Strict`);
    expect(shareKeyCookie(req, "")).toBe(`${SHARE_KEY_COOKIE}=${KEY}; Path=/; HttpOnly; SameSite=Strict`);
  });
});
