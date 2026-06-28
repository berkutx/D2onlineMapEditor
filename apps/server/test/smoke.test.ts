/**
 * Stage-1 smoke test: drive the real Fastify app via app.inject() (no socket).
 * Asserts health, a non-empty real scenario scan (Riders.sg present), and that
 * the Riders MapDocument loads (size === 72) and validates against Contract A.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { MapDocument } from "@d2/map-schema";
import { REST, type ScenarioEntry } from "@d2/socket-contract";
import { buildApp } from "../src/app";

let app: FastifyInstance;

beforeAll(async () => {
  ({ app } = await buildApp());
  await app.ready();
});

describe("GET /api/health", () => {
  it("returns ok with version and uptime", async () => {
    const res = await app.inject({ method: "GET", url: REST.health });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
  });
});

describe("GET /api/scenarios", () => {
  it("scans the real game install and includes Riders.sg", async () => {
    const res = await app.inject({ method: "GET", url: REST.scenarios });
    expect(res.statusCode).toBe(200);
    const entries = res.json() as ScenarioEntry[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);

    const riders = entries.find((e) => /^Riders\.sg$/i.test(e.fileName));
    expect(riders, "Riders.sg should be discovered").toBeTruthy();
    expect(riders!.mapSize).toBe(72);
    expect(riders!.players).toBe(3);
    // never leak raw paths
    expect(JSON.stringify(entries)).not.toMatch(/GOG Games/i);
  });
});

describe("GET /api/maps/:id (Riders)", () => {
  it("returns a MapDocument with size 72 that validates against the schema", async () => {
    const list = await app.inject({ method: "GET", url: REST.scenarios });
    const entries = list.json() as ScenarioEntry[];
    const riders = entries.find((e) => /^Riders\.sg$/i.test(e.fileName))!;

    const res = await app.inject({ method: "GET", url: REST.map(riders.id) });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag, "should send an ETag").toBeTruthy();

    const doc = res.json();
    expect(doc.size).toBe(72);
    const parsed = MapDocument.parse(doc);
    expect(parsed.terrain.cells.length).toBe(parsed.size * parsed.size);
    expect(parsed.players.length).toBe(3);
  });

  it("honors If-None-Match with a 304", async () => {
    const list = await app.inject({ method: "GET", url: REST.scenarios });
    const entries = list.json() as ScenarioEntry[];
    const riders = entries.find((e) => /^Riders\.sg$/i.test(e.fileName))!;

    const first = await app.inject({ method: "GET", url: REST.map(riders.id) });
    const etag = first.headers.etag as string;
    const second = await app.inject({
      method: "GET",
      url: REST.map(riders.id),
      headers: { "if-none-match": etag },
    });
    expect(second.statusCode).toBe(304);
  });
});

describe("GET /api/maps/:id/meta (Riders)", () => {
  it("returns MapMeta", async () => {
    const list = await app.inject({ method: "GET", url: REST.scenarios });
    const entries = list.json() as ScenarioEntry[];
    const riders = entries.find((e) => /^Riders\.sg$/i.test(e.fileName))!;

    const res = await app.inject({ method: "GET", url: REST.mapMeta(riders.id) });
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.size).toBe(72);
    expect(meta.players).toBe(3);
    expect(meta.name).toBe("Riders");
  });
});

describe("GET /api/assets/manifest", () => {
  it("serves the generated manifest", async () => {
    const res = await app.inject({ method: "GET", url: REST.assetsManifest });
    expect(res.statusCode).toBe(200);
    const manifest = res.json();
    expect(Array.isArray(manifest.spritesheets)).toBe(true);
    expect(manifest.spritesheets.length).toBeGreaterThan(0);
  });
});

describe("static /assets/*", () => {
  it("serves an atlas PNG with revalidating cache headers (no-cache + ETag)", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/iso-terrn-0.png" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    // atlas filenames are not content-hashed -> no-cache (see static.ts rationale)
    expect(String(res.headers["cache-control"])).toMatch(/no-cache/);
    expect(res.headers.etag).toBeTruthy();
  });
});
