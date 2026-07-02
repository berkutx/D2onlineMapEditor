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
    payload: { size: 48, fill: "default", name: `own-${clientId ?? "anon"}` },
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
