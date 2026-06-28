/**
 * Editor routes: GET /raw, POST /validate, POST /export. Driven via app.inject().
 * Proves the server-side writer + validator pipeline end to end on Riders.sg.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { REST, type ScenarioEntry, type ValidationReport } from "@d2/socket-contract";
import { buildApp } from "../src/app";

let app: FastifyInstance;
let id: string;
let mapDoc: { size: number; terrain: { cells: { value: number }[] } };

const SG_MAGIC = "D2EESFISIG";

function project(over: Record<string, unknown> = {}) {
  return {
    version: 2, // EditorProject PROJECT_VERSION (grouped journal)
    baseScenarioId: id,
    relations: [],
    journal: [] as unknown[],
    cursor: 0,
    meta: {},
    ...over,
  };
}

function postJson(url: string, body: unknown) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

beforeAll(async () => {
  ({ app } = await buildApp());
  await app.ready();
  const list = await app.inject({ method: "GET", url: REST.scenarios });
  const entries = list.json() as ScenarioEntry[];
  id = entries.find((e) => /^Riders\.sg$/i.test(e.fileName))!.id;
  mapDoc = (await app.inject({ method: "GET", url: REST.map(id) })).json();
});

describe("GET /api/maps/:id/raw", () => {
  it("returns the original .sg bytes with the magic header", async () => {
    const res = await app.inject({ method: "GET", url: REST.mapRaw(id) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/octet-stream/);
    expect(res.rawPayload.subarray(0, SG_MAGIC.length).toString("ascii")).toBe(SG_MAGIC);
    expect(res.rawPayload.length).toBeGreaterThan(1000);
  });

  it("404s for an unknown id", async () => {
    const res = await app.inject({ method: "GET", url: REST.mapRaw("ZZZZZZZZ") });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/maps/:id/validate", () => {
  it("a no-op project validates green (identity + structural)", async () => {
    const res = await postJson(REST.mapValidate(id), project());
    expect(res.statusCode).toBe(200);
    const r = res.json() as ValidationReport;
    expect(r.ok).toBe(true);
    expect(r.identity).toBe(true);
    expect(r.semantic.ok).toBe(true);
    expect(r.opCount).toBe(0);
  });

  it("a setCell edit validates green", async () => {
    const size = mapDoc.size;
    const cur = mapDoc.terrain.cells[10 * size + 10]!.value;
    const op = { kind: "setCell", x: 10, y: 10, value: (cur ^ 0x7) | 0 };
    const res = await postJson(REST.mapValidate(id), project({ journal: [[op]], cursor: 1 }));
    expect(res.statusCode).toBe(200);
    const r = res.json() as ValidationReport;
    expect(r.semantic.ok).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.opCount).toBe(1);
    expect(r.byteLength).toBeGreaterThan(0);
  });

  it("rejects a project whose baseScenarioId mismatches the URL", async () => {
    const res = await postJson(REST.mapValidate(id), project({ baseScenarioId: "OTHER" }));
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/maps/:id/export", () => {
  it("a no-op export returns bytes identical to the original", async () => {
    const raw = await app.inject({ method: "GET", url: REST.mapRaw(id) });
    const res = await postJson(REST.mapExport(id), project());
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/octet-stream/);
    expect(res.rawPayload.length).toBe(raw.rawPayload.length);
    expect(res.rawPayload.equals(raw.rawPayload)).toBe(true);
  });

  it("fails closed (422) on a resizing op", async () => {
    const op = {
      kind: "addObject",
      object: { type: "tomb", id: "S143XX9999", pos: { x: 1, y: 1 } },
    };
    const res = await postJson(REST.mapExport(id), project({ journal: [[op]], cursor: 1 }));
    expect(res.statusCode).toBe(422);
    const r = res.json() as ValidationReport;
    expect(r.ok).toBe(false);
  });
});
