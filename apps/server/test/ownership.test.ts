/**
 * Per-user privacy (v0.2): uploaded/new maps are LISTED only for their owner (the anonymous
 * x-client-id), install maps for everyone; the uploads registry persists across a server
 * restart (registry.json); direct by-id access stays open (capability share links).
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { REST, type ScenarioEntry } from "@d2/socket-contract";
import { buildApp } from "../src/app";
import { MapStore } from "../src/maps/mapStore";

let app: FastifyInstance;

const OWNER = "test-owner-aaaa";
const STRANGER = "test-stranger-bbbb";

async function createMap(clientId?: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: REST.mapNew,
    headers: clientId ? { "x-client-id": clientId } : {},
    payload: { size: 48, fill: "default", name: `own-${clientId ?? "anon"}`, races: ["empire"] },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function listFor(clientId?: string): Promise<ScenarioEntry[]> {
  const res = await app.inject({
    method: "GET",
    url: REST.scenarios,
    headers: clientId ? { "x-client-id": clientId } : {},
  });
  expect(res.statusCode).toBe(200);
  return res.json() as ScenarioEntry[];
}

beforeAll(async () => {
  ({ app } = await buildApp());
  await app.ready();
});

describe("POST /api/maps/new — race gate", () => {
  // 0-race maps are unloadable by the game (from-scratch maps are the product's core path),
  // so the server refuses them outright.
  it("rejects a raceless map with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: REST.mapNew,
      headers: { "x-client-id": OWNER },
      payload: { size: 48, fill: "default", name: "no-races" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("фракци");
  });
});

describe("owner-scoped scenario listing", () => {
  it("lists an owned new map ONLY to its owner; installs to everyone; owner token never serialized", async () => {
    const id = await createMap(OWNER);

    const mine = await listFor(OWNER);
    const theirs = await listFor(STRANGER);
    const anon = await listFor();

    expect(mine.some((e) => e.id === id)).toBe(true);
    expect(theirs.some((e) => e.id === id)).toBe(false);
    expect(anon.some((e) => e.id === id)).toBe(false);

    // install maps stay public for all three
    for (const list of [mine, theirs, anon]) {
      expect(list.some((e) => e.source === "install")).toBe(true);
    }
    // the owner token is the caller's secret — it must never come back in a listing
    expect(mine.every((e) => (e as { owner?: string }).owner === undefined)).toBe(true);
  });

  it("keeps by-id access open for non-owners (capability share links)", async () => {
    const id = await createMap(OWNER);
    const res = await app.inject({
      method: "GET",
      url: REST.map(id),
      headers: { "x-client-id": STRANGER },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { size: number }).size).toBe(48);
  });

  it("ownerless maps are hidden from every listing (private by default)", async () => {
    const id = await createMap(undefined);
    for (const who of [OWNER, STRANGER, undefined]) {
      const list = await listFor(who);
      expect(list.some((e) => e.id === id)).toBe(false);
    }
  });
});

describe("POST /api/maps/:id/clone", () => {
  it("makes a byte-exact copy owned by the caller; source untouched; distinct id", async () => {
    const srcId = await createMap(OWNER);
    const res = await app.inject({
      method: "POST",
      url: REST.mapClone(srcId),
      headers: { "x-client-id": STRANGER }, // anyone with the id can clone (capability model)
    });
    expect(res.statusCode).toBe(201);
    const copyId = (res.json() as { id: string }).id;
    expect(copyId).not.toBe(srcId);

    // byte-exact copy
    const a = await app.inject({ method: "GET", url: REST.mapRaw(srcId) });
    const b = await app.inject({ method: "GET", url: REST.mapRaw(copyId) });
    expect(b.rawPayload.equals(a.rawPayload)).toBe(true);

    // listed for the cloner, not for the source owner
    expect((await listFor(STRANGER)).some((e) => e.id === copyId)).toBe(true);
    expect((await listFor(OWNER)).some((e) => e.id === copyId)).toBe(false);
  });

  it("404s for an unknown source id", async () => {
    const res = await app.inject({ method: "POST", url: REST.mapClone("nope"), headers: { "x-client-id": OWNER } });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET/PUT /api/maps/:id/project (server-saved EditorProject)", () => {
  it("round-trips a project per (mapId, clientId); other clients see 404; validates shape", async () => {
    const mapId = await createMap(OWNER);
    const project = {
      version: 2,
      baseScenarioId: mapId,
      relations: [],
      journal: [[{ kind: "setCell", x: 1, y: 1, value: 5 }]],
      cursor: 1,
      captions: { X: "метка" },
      meta: {},
    };
    const put = await app.inject({
      method: "PUT",
      url: REST.mapProject(mapId),
      headers: { "x-client-id": OWNER, "content-type": "application/json" },
      payload: project,
    });
    expect(put.statusCode).toBe(200);

    const got = await app.inject({
      method: "GET",
      url: REST.mapProject(mapId),
      headers: { "x-client-id": OWNER },
    });
    expect(got.statusCode).toBe(200);
    // the server zod-normalizes on PUT: editor-only fields get their schema defaults
    expect(got.json()).toEqual({ ...project, anchors: {}, autoVars: [] });

    // another visitor has no saved project for this map
    const other = await app.inject({
      method: "GET",
      url: REST.mapProject(mapId),
      headers: { "x-client-id": STRANGER },
    });
    expect(other.statusCode).toBe(404);

    // no identity -> 400; wrong base id -> 400; garbage -> 400
    expect((await app.inject({ method: "GET", url: REST.mapProject(mapId) })).statusCode).toBe(400);
    const wrongBase = await app.inject({
      method: "PUT",
      url: REST.mapProject(mapId),
      headers: { "x-client-id": OWNER, "content-type": "application/json" },
      payload: { ...project, baseScenarioId: "other" },
    });
    expect(wrongBase.statusCode).toBe(400);
    const garbage = await app.inject({
      method: "PUT",
      url: REST.mapProject(mapId),
      headers: { "x-client-id": OWNER, "content-type": "application/json" },
      payload: { nope: 1 },
    });
    expect(garbage.statusCode).toBe(400);
  });
});

describe("ephemeral TTL sweeper (temporary first-visit copies)", () => {
  it("sweeps an expired ephemeral clone; permanent maps survive; access refreshes TTL", async () => {
    const permanentId = await createMap(OWNER); // Новая карта — permanent
    const srcId = await createMap(OWNER);
    const cloneRes = await app.inject({
      method: "POST",
      url: REST.mapClone(srcId),
      headers: { "x-client-id": OWNER },
    });
    const cloneId = (cloneRes.json() as { id: string }).id;

    const store = new MapStore(); // fresh instance reading registry.json
    // clone was JUST accessed (registered) -> a 2-day TTL sweeps nothing
    expect(await store.sweepEphemeral(2 * 24 * 3600 * 1000)).toBe(0);
    // ttl=0 -> anything not accessed "within 0ms" expires; permanent maps are untouched
    await new Promise((r) => setTimeout(r, 5));
    const swept = await store.sweepEphemeral(0);
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await store.resolve(cloneId)).toBeUndefined(); // clone gone (file + registry)
    expect(await store.resolve(permanentId)).toBeTruthy(); // Новая карта survives
    expect(await store.resolve(srcId)).toBeTruthy(); // clone source survives

    // and a FRESH store agrees (the sweep persisted to registry.json)
    const store2 = new MapStore();
    expect(await store2.resolve(cloneId)).toBeUndefined();
    expect(await store2.resolve(permanentId)).toBeTruthy();
  });
});

describe("uploads registry persistence (registry.json)", () => {
  it("a FRESH MapStore (server restart) still resolves + lists an owned map", async () => {
    const id = await createMap(OWNER);

    const fresh = new MapStore(); // simulates a restarted process (memory gone)
    const rec = await fresh.resolve(id);
    expect(rec).toBeTruthy();
    expect(rec!.source).toBe("upload");
    expect(rec!.owner).toBe(OWNER);

    const entries = await fresh.listScenarios();
    const entry = entries.find((e) => e.id === id);
    expect(entry).toBeTruthy();
    expect(entry!.owner).toBe(OWNER);
  });
});
