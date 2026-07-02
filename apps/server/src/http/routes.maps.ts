/**
 * Map document routes.
 *  GET  /api/maps/:id           -> MapDocument (+ ETag, revalidation)
 *  GET  /api/maps/:id/meta      -> MapMeta
 *  GET  /api/maps/:id/raw       -> original .sg bytes (the editor's patch base)
 *  POST /api/maps/:id/validate  -> ValidationReport (apply EditorProject, validate, no bytes)
 *  POST /api/maps/:id/export    -> .sg bytes when valid, else 422 + ValidationReport
 *
 * Documents are parsed lazily and cached in the MapStore (LRU by id+mtime). The
 * ETag is id+mtime derived, so `If-None-Match` short-circuits to 304.
 */

import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { REST, Region, type ValidationReport } from "@d2/socket-contract";
import {
  parseScenario,
  parseScenarioRaw,
  roundTripIdentity,
  validateMap,
  createBlankMap,
  TERRAIN_FILLS,
  type TerrainFill,
} from "@d2/sg-parser";
import {
  EditorProject,
  activeOps,
  foldOps,
  applyOps,
  pushCommit,
  applyEditsToBytes,
  roundTripSemantic,
  buildWallSet,
  buildDecorSet,
  DECODE_TABLES,
  type WallSet,
  type DecorSet,
} from "@d2/map-edit";
import { getRecipe } from "@d2/mapgen";
import { clientIdOf } from "./routes.scenarios.js";
import { runGenerationSteps, type PlanStep } from "../maps/generation.js";
import { config } from "../config.js";
import type { MapDocument } from "@d2/map-schema";
import type { MapStore } from "../maps/mapStore.js";

const FILLS: readonly TerrainFill[] = TERRAIN_FILLS;
const sanitize = (s: string): string => s.replace(/[^\w.-]+/g, "_").slice(0, 40) || "blank";

/**
 * Apply an EditorProject's active ops to a base map and run all validator tiers.
 * Returns the produced bytes (when the build succeeded) alongside the report.
 */
function buildAndValidate(
  baseBytes: Uint8Array,
  project: EditorProject,
): { report: ValidationReport; bytes?: Uint8Array } {
  const { doc, raw } = parseScenarioRaw(baseBytes);
  // Fold add→delete pairs (a collab undo of a placement) BEFORE the byte writer: it cannot
  // delete pre-existing blocks (M4), but a never-appended object needs no delete at all.
  // Semantics-preserving, and the SAME folded ops feed the semantic tier for consistency.
  const ops = foldOps(activeOps(project));

  // Tier 1: base pass-through is byte-exact (BlockComparator equivalent).
  const identity = roundTripIdentity(baseBytes);

  let bytes: Uint8Array | undefined;
  let buildError: string | undefined;
  try {
    bytes = applyEditsToBytes(raw, ops);
  } catch (e) {
    buildError = e instanceof Error ? e.message : String(e);
  }

  // Tier 2 + 3 require a successful build.
  const semantic = bytes
    ? roundTripSemantic(doc, bytes, ops)
    : { ok: false, reason: buildError ?? "build failed" };
  const structural = bytes
    ? validateMap(parseScenario(bytes))
    : { ok: false, errors: [buildError ?? "build failed"], warnings: [] };

  const report: ValidationReport = {
    ok: Boolean(bytes) && identity && semantic.ok && structural.ok,
    identity,
    semantic,
    structural,
    opCount: ops.length,
    byteLength: bytes?.length ?? 0,
  };
  if (!report.ok) {
    // surface WHY in the server log (docker logs d2editor) — not just which tier
    // eslint-disable-next-line no-console
    console.warn(
      `[validate] FAILED opCount=${ops.length} identity=${identity}` +
        (semantic.ok ? "" : ` | semantic: ${semantic.reason ?? "?"}`) +
        (structural.ok ? "" : ` | structural: ${structural.errors.slice(0, 6).join(" ; ")}`),
    );
  }
  return { report, bytes };
}

/** Lazily load + cache the decoration catalog as a wall set (by iso orient) + a decor set
 *  (1×1 by shape), both from public/assets/decorCatalog.json (read once). */
let wallSetCache: WallSet | null = null;
let decorSetCache: DecorSet | null = null;
async function loadCatalogSets(): Promise<{ walls: WallSet; decor: DecorSet }> {
  if (!wallSetCache || !decorSetCache) {
    const path = join(config.ASSETS_DIR, "decorCatalog.json");
    const json = JSON.parse(await readFile(path, "utf-8")) as never;
    wallSetCache = buildWallSet(json);
    decorSetCache = buildDecorSet(json);
  }
  return { walls: wallSetCache, decor: decorSetCache };
}

/** Parse a hand-drawn cell mask (body.cells = [[x,y],…]) into an "x,y" Set; undefined if empty. */
function parseMask(raw: unknown): Set<string> | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const s = new Set<string>();
  for (const p of raw as unknown[]) {
    if (Array.isArray(p) && Number.isInteger(p[0]) && Number.isInteger(p[1])) s.add(`${p[0]},${p[1]}`);
  }
  return s.size ? s : undefined;
}

/** A cell is "protected" if it currently holds water (ground==3) or a mountain stamp (37). */
function isProtectedCell(value: number): boolean {
  return ((value >> 3) & 7) === 3 || value === 37;
}

/** Count protected (water/mountain) cells inside a region (or a drawn mask) — for debug. */
function countProtected(
  doc: MapDocument,
  region: { x: number; y: number; w: number; h: number },
  mask?: Set<string>,
): number {
  const n = doc.size;
  let c = 0;
  const test = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < n && y < n && isProtectedCell(doc.terrain.cells[y * n + x]!.value)) c++;
  };
  if (mask) for (const k of mask) { const [x, y] = k.split(",").map(Number) as [number, number]; test(x, y); }
  else for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) test(x, y);
  return c;
}

// --- Copilot LLM file bridge (Phase-4 POC) -----------------------------------
let copilotReqCounter = 0;

/** Compact one-char-per-cell terrain map for the LLM: W=water, F=forest, S=snow, .=other land. */
function terrainAscii(doc: MapDocument): { legend: Record<string, string>; rows: string[] } {
  const n = doc.size;
  const rows: string[] = [];
  for (let y = 0; y < n; y++) {
    let s = "";
    for (let x = 0; x < n; x++) {
      const v = doc.terrain.cells[y * n + x]!.value;
      const ground = (v >> 3) & 7;
      const forest = v >>> 26;
      const terr = v & 7;
      s += ground === 3 ? "W" : forest > 0 ? "F" : terr === 2 ? "S" : ".";
    }
    rows.push(s);
  }
  return {
    legend: { W: "water", F: "forest", S: "snow/Mountain-Clans", ".": "other land (grass/dirt/faction)" },
    rows,
  };
}

/** Coarse object list (type + cell) so the LLM knows what is already placed. Capped. */
function objectsSummary(doc: MapDocument): { type: string; x: number; y: number }[] {
  return doc.objects.slice(0, 200).map((o) => ({ type: o.type, x: o.pos.x, y: o.pos.y }));
}

/** Poll for the agent's response file; tolerate ENOENT (not ready) + partial writes. */
async function waitForResponse(
  file: string,
  timeoutMs: number,
): Promise<{ reasoning?: string; steps?: unknown[] } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let raw: string | null = null;
    try {
      raw = await readFile(file, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (raw !== null) {
      try {
        return JSON.parse(raw) as { reasoning?: string; steps?: unknown[] };
      } catch {
        /* partial write — retry next tick */
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** The self-describing contract written into every request file (so the agent knows the shape). */
const COPILOT_RESPONSE_SPEC = {
  note:
    "You are the LLM for a Disciples-2 map editor. Read this request and write your answer to " +
    "var/llm/responses/<requestId>.json. Coordinates are CARTESIAN cells (x=col 0..size-1, y=row, " +
    "origin top-left). Compose terrain ONLY (water/snow/forest/grass/other land + walls); no units/buildings.",
  responseShape: {
    reasoning: "string — one short sentence shown to the user",
    steps:
      "array — each step paints one region. Use a registered recipe OR an inline recipe you author.",
  },
  step_registered: { recipeId: "water_lake|water_isles|river|decor_forest|forest_scatter|forest_clearings|mountain_fill|relief_ridge|relief_hills|hedge_maze|mountain_maze|wall_maze|road_path|decor_rocks|decor_bushes|decor_ruins|decor_graves|snow_overlay|snow_patches|snow_scatter|grass_fill", region: { x: 0, y: 0, w: 10, h: 10 } },
  step_inline_fill: {
    recipe: { kind: "fill", fillSymbol: "X" },
    decode: { X: { kind: "terrain", terrain: 4 } },
    region: { x: 0, y: 0, w: 10, h: 10 },
    hint: "terrain ids: 1=empire/green 2=snow 3=legions 4=undead/waste 5=neutral 6=elf/forest-land; or {kind:'water'} / {kind:'forest'} / {kind:'wall'} / {kind:'skip'}",
  },
  step_inline_mj: {
    recipe: { kind: "mj", xml: "<one values=\"BWA\" in=\"WBB\" out=\"WAW\" origin=\"True\"/>" },
    decode: { B: { kind: "wall" }, W: { kind: "skip" }, A: { kind: "skip" } },
    region: { x: 0, y: 0, w: 15, h: 15 },
  },
} as const;

export async function registerMapRoutes(
  app: FastifyInstance,
  store: MapStore,
): Promise<void> {
  app.get<{ Params: { id: string } }>(REST.map(":id"), async (req, reply) => {
    const { id } = req.params;

    // cheap revalidation: compute ETag without forcing a parse
    const currentEtag = await store.etagFor(id);
    if (!currentEtag) {
      return reply.code(404).send({ error: "map not found" });
    }
    const inm = req.headers["if-none-match"];
    if (inm && inm === currentEtag) {
      return reply
        .code(304)
        .header("etag", currentEtag)
        .header("cache-control", "no-cache")
        .send();
    }

    const loaded = await store.getMap(id);
    if (!loaded) {
      return reply.code(404).send({ error: "map not found" });
    }
    return reply
      .header("etag", loaded.etag)
      .header("cache-control", "no-cache")
      .send(loaded.doc);
  });

  app.get<{ Params: { id: string } }>(REST.mapMeta(":id"), async (req, reply) => {
    const { id } = req.params;
    const meta = await store.getMeta(id);
    if (!meta) {
      return reply.code(404).send({ error: "map not found" });
    }
    return meta;
  });

  app.get<{ Params: { id: string } }>(REST.mapRaw(":id"), async (req, reply) => {
    const { id } = req.params;
    const raw = await store.getRawBytes(id);
    if (!raw) {
      return reply.code(404).send({ error: "map not found" });
    }
    return reply
      .header("etag", raw.etag)
      .header("cache-control", "no-cache")
      .header("content-type", "application/octet-stream")
      .send(Buffer.from(raw.bytes));
  });

  // POST /api/maps/new -> generate a from-scratch blank terrain map, register it, return its id.
  app.post<{ Body: { size?: number; fill?: string; name?: string } }>(
    REST.mapNew,
    async (req, reply) => {
      const body = req.body ?? {};
      const size = Number(body.size);
      const fill = (FILLS.includes(body.fill as TerrainFill) ? body.fill : "default") as TerrainFill;
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "New map";
      if (!Number.isInteger(size) || size <= 0 || size % 8 !== 0) {
        return reply.code(400).send({ error: "size must be a positive multiple of 8" });
      }
      let bytes: Uint8Array;
      try {
        bytes = createBlankMap({ size, fill, name, author: "web-editor" });
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
      }
      await mkdir(config.UPLOAD_DIR, { recursive: true });
      const file = join(config.UPLOAD_DIR, `new-${sanitize(name)}-${size}-${Date.now()}.sg`);
      await writeFile(file, bytes);
      const rec = await store.registerUpload(file, clientIdOf(req));
      return reply.code(201).send({ id: rec.id });
    },
  );

  // POST /api/maps/:id/clone -> byte-exact personal copy of any accessible map, owned by the
  // caller (x-client-id). This is how a new visitor gets their OWN copy of the reference map
  // (the install stays pristine; each copy is a separate room/base for the diff journal).
  app.post<{ Params: { id: string } }>(REST.mapClone(":id"), async (req, reply) => {
    const { id } = req.params;
    const src = await store.getRawBytes(id);
    if (!src) {
      return reply.code(404).send({ error: "map not found" });
    }
    await mkdir(config.UPLOAD_DIR, { recursive: true });
    const file = join(config.UPLOAD_DIR, `copy-${id.slice(0, 8)}-${Date.now()}.sg`);
    await writeFile(file, src.bytes);
    const rec = await store.registerUpload(file, clientIdOf(req));
    return reply.code(201).send({ id: rec.id });
  });

  // POST /validate and /export share the same build+validate pipeline.
  for (const action of ["validate", "export"] as const) {
    const url = action === "validate" ? REST.mapValidate(":id") : REST.mapExport(":id");
    app.post<{ Params: { id: string } }>(url, async (req, reply) => {
      const { id } = req.params;

      const parsed = EditorProject.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid EditorProject", detail: parsed.error.message });
      }
      const project = parsed.data;
      if (project.baseScenarioId !== id) {
        return reply
          .code(400)
          .send({ error: `project baseScenarioId ${project.baseScenarioId} != ${id}` });
      }

      const base = await store.getRawBytes(id);
      if (!base) {
        return reply.code(404).send({ error: "map not found" });
      }

      const { report, bytes } = buildAndValidate(base.bytes, project);

      if (action === "validate") {
        return reply.send(report);
      }
      // export: gate bytes on a clean report
      if (!report.ok || !bytes) {
        return reply.code(422).send(report);
      }
      const fileName = `${project.meta.name ?? id}-edited.sg`;
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="${encodeURIComponent(fileName)}"`)
        .header("x-validation-ok", "1")
        .send(Buffer.from(bytes));
    });
  }

  // POST /api/maps/:id/generate -> run a MarkovJunior recipe over a region, decode to
  // EditOps against the current project, validate, return { ops, report }. The client
  // commits the ops (one undo step). The LLM/keyword router (client) only picks recipe+region.
  app.post<{ Params: { id: string } }>(REST.mapGenerate(":id"), async (req, reply) => {
    const { id } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const projParsed = EditorProject.safeParse(body.project);
    if (!projParsed.success) {
      return reply.code(400).send({ error: "invalid EditorProject", detail: projParsed.error.message });
    }
    const project = projParsed.data;
    if (project.baseScenarioId !== id) {
      return reply.code(400).send({ error: `project baseScenarioId ${project.baseScenarioId} != ${id}` });
    }
    const regParsed = Region.safeParse(body.region);
    if (!regParsed.success) {
      return reply.code(400).send({ error: "invalid region", detail: regParsed.error.message });
    }
    const region = regParsed.data;
    const recipeId = String(body.recipeId ?? "");
    if (!getRecipe(recipeId) || !DECODE_TABLES[recipeId]) {
      return reply.code(400).send({ error: `unknown recipe '${recipeId}'` });
    }

    const base = await store.getRawBytes(id);
    if (!base) {
      return reply.code(404).send({ error: "map not found" });
    }

    // current document = base + the project's active ops (so ids/cells are up to date)
    const { doc } = parseScenarioRaw(base.bytes);
    const liveDoc = applyOps(doc, activeOps(project));

    const seed = Number.isInteger(body.seed) ? Number(body.seed) : Date.now() & 0x7fffffff;
    const mask = parseMask(body.cells);
    const protect = body.protect === true;
    const t0 = Date.now();
    let ops;
    try {
      const { walls, decor } = await loadCatalogSets();
      ops = await runGenerationSteps(liveDoc, [{ recipeId, region, seed }], walls, seed, mask, protect, decor);
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }

    // validate the generated ops as one more commit on top of the project
    const augmented = ops.length ? pushCommit(project, ops) : project;
    const { report } = buildAndValidate(base.bytes, augmented);
    const debug = {
      serverMs: Date.now() - t0,
      opCount: ops.length,
      recipe: recipeId,
      protect,
      protectedInRegion: protect ? countProtected(liveDoc, region, mask) : undefined,
      validation: { ok: report.ok, identity: report.identity, semantic: report.semantic.ok, structural: report.structural.ok },
    };
    return reply.send({ ops, report, debug });
  });

  // POST /api/maps/:id/copilot -> the Phase-4 LLM bridge (POC). Writes the natural-language
  // command + map context to var/llm/requests/<id>.json, then LONG-POLLS for the agent's
  // response (a generation plan) at var/llm/responses/<id>.json. The plan's steps run through
  // the SAME generation executor + 3-tier validator as /generate; the client commits {ops}
  // as one undoable edit. (Stands in for a real LLM endpoint, none configured.)
  app.post<{ Params: { id: string } }>(REST.mapCopilot(":id"), async (req, reply) => {
    // The LLM bridge needs a local agent watching var/llm — absent in production. Disabled
    // there (COPILOT_LLM=off); the no-LLM recipe/keyword generation (/generate) still works.
    if (!config.COPILOT_LLM) {
      return reply.code(503).send({ error: "LLM Copilot disabled on this deployment" });
    }
    const { id } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const projParsed = EditorProject.safeParse(body.project);
    if (!projParsed.success) {
      return reply.code(400).send({ error: "invalid EditorProject", detail: projParsed.error.message });
    }
    const project = projParsed.data;
    if (project.baseScenarioId !== id) {
      return reply.code(400).send({ error: `project baseScenarioId ${project.baseScenarioId} != ${id}` });
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return reply.code(400).send({ error: "text required" });
    }
    const selParsed = body.selection == null ? null : Region.safeParse(body.selection);
    const selection = selParsed && selParsed.success ? selParsed.data : null;

    const base = await store.getRawBytes(id);
    if (!base) {
      return reply.code(404).send({ error: "map not found" });
    }
    const { doc } = parseScenarioRaw(base.bytes);
    const liveDoc = applyOps(doc, activeOps(project));

    // 1) write the request file (the "LLM prompt") with rich map context
    const reqDir = join(config.LLM_DIR, "requests");
    const resDir = join(config.LLM_DIR, "responses");
    const arcDir = join(config.LLM_DIR, "archive");
    await mkdir(reqDir, { recursive: true });
    await mkdir(resDir, { recursive: true });
    await mkdir(arcDir, { recursive: true });
    const requestId = `${Date.now()}-${(copilotReqCounter++).toString(36)}`;
    const reqFile = join(reqDir, `${requestId}.json`);
    const resFile = join(resDir, `${requestId}.json`);
    const requestDoc = {
      requestId,
      mapId: id,
      text,
      size: liveDoc.size,
      selection,
      terrain: terrainAscii(liveDoc),
      objects: objectsSummary(liveDoc),
      registeredRecipes: [
        "water_lake (organic blob)", "water_isles (archipelago)", "river (winding)",
        "decor_forest (groves)", "forest_scatter (sparse trees)", "forest_clearings (forest+glades)",
        "mountain_fill (massif)", "relief_ridge (mountain ridge)", "relief_hills (scattered hills)",
        "hedge_maze (forest)", "mountain_maze (stone)", "wall_maze (fence objects)",
        "road_path (winding road)", "decor_rocks", "decor_bushes", "decor_ruins", "decor_graves",
        "snow_overlay (solid wash)", "snow_patches (organic)", "snow_scatter (sparse)",
        "grass_fill (wash)",
      ],
      respondTo: resFile,
      spec: COPILOT_RESPONSE_SPEC,
      createdAt: new Date().toISOString(),
    };
    await writeFile(reqFile, JSON.stringify(requestDoc, null, 2), "utf-8");

    // 2) wait for the agent (acting as the LLM) to drop the response plan
    const plan = await waitForResponse(resFile, 150_000);
    if (!plan || !Array.isArray(plan.steps)) {
      return reply
        .code(504)
        .send({ error: "no LLM response (is the agent watching var/llm/requests?)", requestId });
    }

    // 3) validate + execute the plan steps through the shared generation pipeline
    const steps: PlanStep[] = [];
    for (const s of plan.steps as Record<string, unknown>[]) {
      const reg = Region.safeParse(s?.region);
      if (!reg.success) {
        return reply.code(400).send({ error: "plan step has an invalid region", detail: reg.error.message, requestId });
      }
      steps.push({ ...(s as object), region: reg.data } as PlanStep);
    }
    const { walls, decor } = await loadCatalogSets();
    const seed = Date.now() & 0x7fffffff;
    const mask = parseMask(body.cells);
    const protect = body.protect === true;
    const t0 = Date.now();
    let ops;
    try {
      ops = await runGenerationSteps(liveDoc, steps, walls, seed, mask, protect, decor);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e), requestId });
    }

    const augmented = ops.length ? pushCommit(project, ops) : project;
    const { report } = buildAndValidate(base.bytes, augmented);
    const debug = {
      serverMs: Date.now() - t0,
      opCount: ops.length,
      steps: steps.length,
      protect,
      validation: { ok: report.ok, identity: report.identity, semantic: report.semantic.ok, structural: report.structural.ok },
    };

    // 4) archive the exchange for inspection, then return the result
    try {
      await rename(reqFile, join(arcDir, `${requestId}.request.json`));
      await rename(resFile, join(arcDir, `${requestId}.response.json`));
    } catch {
      /* best-effort cleanup */
    }

    return reply.send({
      ops,
      report,
      reasoning: typeof plan.reasoning === "string" ? plan.reasoning : undefined,
      steps: plan.steps,
      debug,
    });
  });
}
