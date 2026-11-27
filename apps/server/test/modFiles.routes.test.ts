/**
 * GET /api/mods/:id/files: a mod's logical names with the sha256 of each, read off the blob
 * paths of its mod.json. Only the mod routes run here, over registries of a synthetic store.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REST, ModFileList, type ModList } from "@d2/socket-contract";
import { registerModRoutes } from "../src/http/routes.mods";
import { ModRegistry } from "../src/mods/modRegistry";
import { writeModStore } from "./modStoreFixture";

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const UNITS = Buffer.from("alpha units table");
const LRACE = Buffer.from("the same race table in both mods");
const CAPITAL = Buffer.from("capital screens");

let storeDir: string;
let flatDir: string;
const apps: FastifyInstance[] = [];

async function serve(registry: ModRegistry): Promise<FastifyInstance> {
  const app = Fastify();
  await registerModRoutes(app, registry);
  await app.ready();
  apps.push(app);
  return app;
}

beforeAll(() => {
  storeDir = mkdtempSync(join(tmpdir(), "d2-mod-files-"));
  flatDir = mkdtempSync(join(tmpdir(), "d2-mod-files-flat-"));
  writeModStore(
    storeDir,
    [
      {
        id: "alpha",
        files: {
          "unitCatalog.json": [{ id: "G000UU0001" }],
          "tables/Gunits.dbf": UNITS,
          "tables/Lrace.dbf": LRACE,
          "capital.dat": CAPITAL,
        },
      },
      { id: "beta", files: { "unitCatalog.json": [], "tables/Lrace.dbf": LRACE } },
    ],
    "beta",
  );
});

afterAll(async () => {
  for (const app of apps) await app.close();
  for (const d of [storeDir, flatDir]) rmSync(d, { recursive: true, force: true });
});

describe("GET /api/mods/:id/files", () => {
  it("lists every logical name with the sha256 of its bytes", async () => {
    const app = await serve(new ModRegistry(storeDir, []));
    const res = await app.inject({ method: "GET", url: REST.modFiles("alpha") });
    expect(res.statusCode).toBe(200);
    const body = ModFileList.parse(res.json());
    expect(body.files).toEqual({
      "unitCatalog.json": sha256(JSON.stringify([{ id: "G000UU0001" }])),
      "tables/Gunits.dbf": sha256(UNITS),
      "tables/Lrace.dbf": sha256(LRACE),
      "capital.dat": sha256(CAPITAL),
    });
    // a table two mods share has one hash: nothing to download to see it did not change
    const beta = ModFileList.parse((await app.inject({ method: "GET", url: REST.modFiles("beta") })).json());
    expect(beta.files["tables/Lrace.dbf"]).toBe(body.files["tables/Lrace.dbf"]);
  });

  it("keeps only the names that start with the prefix", async () => {
    const app = await serve(new ModRegistry(storeDir, []));
    const res = await app.inject({ method: "GET", url: `${REST.modFiles("alpha")}?prefix=tables/` });
    expect(res.statusCode).toBe(200);
    expect(Object.keys((res.json() as ModFileList).files).sort()).toEqual(["tables/Gunits.dbf", "tables/Lrace.dbf"]);
    const none = await app.inject({ method: "GET", url: `${REST.modFiles("alpha")}?prefix=nope/` });
    expect(none.json()).toEqual({ files: {} });
    const twice = await app.inject({ method: "GET", url: `${REST.modFiles("alpha")}?prefix=a&prefix=b` });
    expect(twice.statusCode).toBe(400);
  });

  it("is revalidated by the mod's revision, like the passport", async () => {
    const app = await serve(new ModRegistry(storeDir, []));
    const mods = (await app.inject({ method: "GET", url: REST.mods })).json() as ModList;
    const rev = mods.mods.find((m) => m.id === "alpha")!.rev;
    const res = await app.inject({ method: "GET", url: `${REST.modFiles("alpha")}?prefix=tables/` });
    expect(res.headers.etag).toBe(`"${rev}"`);
    expect(res.headers["cache-control"]).toBe("no-cache");
    const again = await app.inject({
      method: "GET",
      url: `${REST.modFiles("alpha")}?prefix=tables/`,
      headers: { "if-none-match": `"${rev}"` },
    });
    expect(again.statusCode).toBe(304);
  });

  it("404s for an unknown mod", async () => {
    const app = await serve(new ModRegistry(storeDir, []));
    const res = await app.inject({ method: "GET", url: REST.modFiles("gamma") });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: REST.mod("gamma") })).statusCode).toBe(404);
  });

  it("404s for a hidden mod, as its passport does (a share key opens both: modShareKey.routes.test.ts)", async () => {
    const app = await serve(new ModRegistry(storeDir, ["alpha"]));
    const list = (await app.inject({ method: "GET", url: REST.mods })).json() as ModList;
    expect(list.mods.map((m) => m.id)).toEqual(["beta"]);
    expect((await app.inject({ method: "GET", url: REST.mod("alpha") })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: REST.modFiles("alpha") })).statusCode).toBe(404);
  });

  it("the flat legacy mod has no files to list", async () => {
    const app = await serve(new ModRegistry(flatDir, []));
    const res = await app.inject({ method: "GET", url: REST.modFiles("default") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ files: {} });
    expect(res.headers.etag).toBe('"flat"');
  });
});
