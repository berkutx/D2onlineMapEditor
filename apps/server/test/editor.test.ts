/**
 * Editor routes: GET /raw, POST /validate, POST /export. Driven via app.inject().
 * Proves the server-side writer + validator pipeline end to end on Riders.sg.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { REST, type ScenarioEntry, type ValidationReport } from "@d2/socket-contract";
import { buildApp } from "../src/app";
import { config } from "../src/config";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

describe("POST /api/maps/:id/generate", () => {
  it("wall_maze generates wall landmark ops that validate green", async () => {
    const res = await postJson(REST.mapGenerate(id), {
      project: project(),
      recipeId: "wall_maze",
      region: { x: 5, y: 5, w: 15, h: 15 },
      seed: 1,
    });
    expect(res.statusCode).toBe(200);
    const r = res.json() as { ops: { kind: string; object?: { type?: string } }[]; report: ValidationReport };
    expect(r.ops.length).toBeGreaterThan(0);
    expect(r.ops.some((o) => o.kind === "addObject" && o.object?.type === "landmark")).toBe(true);
    expect(r.report.ok).toBe(true);
  });

  it("snow_overlay (fill recipe) generates setCell ops that validate green", async () => {
    const res = await postJson(REST.mapGenerate(id), {
      project: project(),
      recipeId: "snow_overlay",
      region: { x: 5, y: 5, w: 10, h: 10 },
      seed: 1,
    });
    expect(res.statusCode).toBe(200);
    const r = res.json() as { ops: { kind: string }[]; report: ValidationReport };
    expect(r.ops.length).toBeGreaterThan(0);
    expect(r.ops.every((o) => o.kind === "setCell")).toBe(true);
    expect(r.report.ok).toBe(true);
  });

  it("400s on an unknown recipe", async () => {
    const res = await postJson(REST.mapGenerate(id), {
      project: project(),
      recipeId: "does_not_exist",
      region: { x: 1, y: 1, w: 5, h: 5 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/maps/:id/copilot (LLM file bridge)", () => {
  const reqDir = join(config.LLM_DIR, "requests");
  const resDir = join(config.LLM_DIR, "responses");

  /** Start a copilot request (long-polls), then act as the agent: read the request file,
   *  write a response plan, and resolve with the route's result + the request it saw. */
  async function bridge(text: string, plan: unknown): Promise<{ res: Awaited<ReturnType<typeof postJson>>; request: Record<string, unknown> }> {
    await rm(reqDir, { recursive: true, force: true });
    await mkdir(reqDir, { recursive: true });
    const pending = postJson(REST.mapCopilot(id), { project: project(), text });
    // wait for the server to write the request file, then "be the LLM"
    let requestId: string | null = null;
    for (let i = 0; i < 150 && !requestId; i++) {
      await sleep(100);
      const files = await readdir(reqDir).catch(() => [] as string[]);
      const f = files.find((n) => n.endsWith(".json"));
      if (f) requestId = f.replace(/\.json$/, "");
    }
    if (!requestId) throw new Error("server never wrote a request file");
    const request = JSON.parse(await readFile(join(reqDir, `${requestId}.json`), "utf-8")) as Record<string, unknown>;
    await mkdir(resDir, { recursive: true });
    await writeFile(join(resDir, `${requestId}.json`), JSON.stringify(plan), "utf-8");
    return { res: await pending, request };
  }

  it("writes a request with map context, then runs the agent's registered-recipe plan", async () => {
    const { res, request } = await bridge("озеро в центре", {
      reasoning: "Поставил озеро в центре.",
      steps: [{ recipeId: "water_lake", region: { x: 20, y: 20, w: 12, h: 12 } }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ops: unknown[]; report: ValidationReport; reasoning?: string };
    expect(body.report.ok).toBe(true);
    expect(body.ops.length).toBeGreaterThan(0);
    expect(body.reasoning).toBe("Поставил озеро в центре.");
    // the request file gave the agent real context
    expect(request.text).toBe("озеро в центре");
    expect(request.size).toBe(72);
    expect((request.terrain as { rows: string[] }).rows.length).toBe(72);
  });

  it("runs an INLINE LLM-authored recipe + decode table (Phase-5 style)", async () => {
    const { res } = await bridge("залей центр пустошью", {
      reasoning: "Залил undead-пустошью.",
      steps: [
        {
          recipe: { kind: "fill", fillSymbol: "U" },
          decode: { U: { kind: "terrain", terrain: 4 } }, // 4 = undead/waste tileset
          region: { x: 30, y: 30, w: 8, h: 8 },
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ops: { kind: string }[]; report: ValidationReport };
    expect(body.report.ok).toBe(true);
    expect(body.ops.length).toBeGreaterThan(0);
    expect(body.ops.every((o) => o.kind === "setCell")).toBe(true);
  });

  it("400s when the agent's plan step has an invalid region", async () => {
    const { res } = await bridge("плохой план", {
      steps: [{ recipeId: "water_lake", region: { x: 0, y: 0, w: 0, h: 5 } }],
    });
    expect(res.statusCode).toBe(400);
  });
});
