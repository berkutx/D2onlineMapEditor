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
  verifyBlockIntegrity,
  parsePlanEntries,
  serializeMapFromModelBytes,
  createBlankMap,
  TERRAIN_FILLS,
  RACE_KEYS,
  type RaceKey,
  type TerrainFill,
} from "@d2/sg-parser";
import {
  EditorProject,
  emptyProject,
  activeOps,
  foldOps,
  applyOps,
  pushCommit,
  materializeForExport,
  roundTripSemantic,
  buildWallSet,
  buildDecorSet,
  validateMechanics,
  occupancyErrors,
  planCoverageErrors,
  DECODE_TABLES,
  type WallSet,
  type DecorSet,
} from "@d2/map-edit";
import { getRecipe } from "@d2/mapgen";
import { clientIdOf } from "./routes.scenarios.js";
import { runGenerationSteps, type PlanStep } from "../maps/generation.js";
import { config } from "../config.js";
import { roomKey } from "../realtime/RoomManager.js";
import type { EditLog } from "../realtime/EditLog.js";
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
  talismanTemplates?: ReadonlySet<string>,
  landmarkSize?: (baseType: string) => readonly [number, number] | undefined,
): { report: ValidationReport; bytes?: Uint8Array } {
  const { doc } = parseScenarioRaw(baseBytes);
  // Fold add→delete pairs (a collab undo of a placement) into the model rebuild: a never-appended
  // object needs no delete at all. The SAME folded ops feed the semantic tier for consistency.
  const ops = foldOps(activeOps(project));

  // Tier 1: base pass-through is byte-exact (BlockComparator equivalent).
  const identity = roundTripIdentity(baseBytes);

  // EXPORT = FULL MODEL-REBUILD. The loaded .sg is a codec only — after loading, the MODEL is the
  // single source of truth and the whole file is rebuilt FROM it. No byte patch, no skeleton
  // fallback:
  //   1. materializeForExport turns the edited model into a self-describing one — mints the
  //      serialization-derived state the live model doesn't hold (MidItem/MidUnit instance ids,
  //      MidgardPlan footprints, MidRoad, MidTalismanCharges rows, template slots), as the
  //      reference editor mints at save.
  //   2. serializeMapFromModelBytes re-serialises EVERY block payload from that model (drops
  //      deleted, appends added), reusing `baseBytes` only for the header + original block order.
  // Every content block comes from the model; a block it can't reproduce THROWS (never a silent
  // fallback), failing the validator below (422). Byte-identical to the original on a no-op.
  // the scenario name/desc/author also live at fixed offsets in the FILE HEADER (the game's
  // map-select list reads them there); collect any that an edit changed so serializeMapFromModel
  // re-stamps ONLY those (an unedited field keeps its exact original header bytes).
  const headerText: { name?: string; description?: string; author?: string } = {};
  for (const op of ops) {
    if (op.kind !== "setScenarioInfo") continue;
    if (op.fields.name !== undefined) headerText.name = op.fields.name;
    if (op.fields.description !== undefined) headerText.description = op.fields.description;
    if (op.fields.author !== undefined) headerText.author = op.fields.author;
  }
  let bytes: Uint8Array | undefined;
  let buildError: string | undefined;
  try {
    const materialized = materializeForExport(doc, ops, { talismanTemplates, landmarkSize });
    bytes = serializeMapFromModelBytes(baseBytes, materialized, headerText);
  } catch (e) {
    buildError = e instanceof Error ? e.message : String(e);
  }

  // Tier 2 + 3 require a successful build.
  const semantic = bytes
    ? roundTripSemantic(doc, bytes, ops)
    : { ok: false, reason: buildError ?? "build failed" };
  // Tier 3 = document sanity + BYTE-level block integrity (OB0000 count + dangling internal
  // refs — the defect classes only the GAME editor used to catch; see the ScenEdit gold check).
  let structural: { ok: boolean; errors: string[]; warnings: string[] };
  if (bytes) {
    const built = parseScenario(bytes);
    const doc3 = validateMap(built);
    const integ = verifyBlockIntegrity(bytes);
    // game-MECHANICS warnings (our addition — the reference validator checks only db
    // refs): cities on water / roads under water. Calibrated to be SILENT on all 52
    // shipped campaign maps, so any hit is a real editing accident.
    const mech = validateMechanics(built, { landmarkSize });
    // occupancy overlap = a HARD error (two objects on one cell is an unplayable map; the
    // game editor forbids it — zero overlaps across all 59 shipped campaign maps).
    const occErr = occupancyErrors(built, { landmarkSize });
    // plan↔footprint = a HARD error: mirrors the GAME's native landmark isValid (reversed from
    // ScenEdit CMidLandmark::isValid @0x4F30CB). A landmark whose footprint isn't fully owned in
    // the MidgardPlan makes the real editor refuse to save ("Scenario object <id> is invalid").
    // Catches the pre-landmarkSize 1×1-plan bug even on maps loaded with a stale plan.
    const planErr = planCoverageErrors(built, parsePlanEntries(bytes), { landmarkSize });
    structural = {
      ok: doc3.ok && integ.ok && occErr.length === 0 && planErr.length === 0,
      errors: [...doc3.errors, ...integ.errors, ...occErr, ...planErr],
      warnings: [...doc3.warnings, ...integ.warnings, ...mech],
    };
  } else {
    structural = { ok: false, errors: [buildError ?? "build failed"], warnings: [] };
  }

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

/** Lazily load + cache the TALISMAN template-id set from public/assets/itemCatalog.json
 *  (catKey L_TALISMAN) — the byte writer adds a MidTalismanCharges entry per minted talisman
 *  instance (the reference's addItem cascade). A missing catalog degrades to an empty set
 *  (entries simply not added) with one warning — asset volumes without the catalog stay usable. */
let talismanSetCache: ReadonlySet<string> | null = null;
async function loadTalismanTemplates(): Promise<ReadonlySet<string>> {
  if (!talismanSetCache) {
    try {
      const path = join(config.ASSETS_DIR, "itemCatalog.json");
      const items = JSON.parse(await readFile(path, "utf-8")) as { id: string; catKey?: string }[];
      talismanSetCache = new Set(items.filter((i) => i.catKey === "L_TALISMAN").map((i) => i.id));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[maps] itemCatalog.json unavailable — talisman charges entries disabled (${String(e)})`);
      talismanSetCache = new Set();
    }
  }
  return talismanSetCache;
}

/** Lazily load + cache the decoration catalog as a wall set (by iso orient) + a decor set
 *  (1×1 by shape) + landmark footprints (UPPERCASE id → [cx,cy], for the generation
 *  occupancy guard), all from public/assets/decorCatalog.json (read once). */
let wallSetCache: WallSet | null = null;
let decorSetCache: DecorSet | null = null;
let landmarkSizesCache: Record<string, readonly [number, number]> | null = null;
async function loadCatalogSets(): Promise<{
  walls: WallSet;
  decor: DecorSet;
  landmarkSizes: Record<string, readonly [number, number]>;
}> {
  if (!wallSetCache || !decorSetCache || !landmarkSizesCache) {
    const path = join(config.ASSETS_DIR, "decorCatalog.json");
    const json = JSON.parse(await readFile(path, "utf-8")) as never;
    wallSetCache = buildWallSet(json);
    decorSetCache = buildDecorSet(json);
    const sizes: Record<string, readonly [number, number]> = {};
    const entries = Array.isArray(json)
      ? (json as { id: string; cx?: number; cy?: number }[])
      : Object.values(json as Record<string, { id: string; cx?: number; cy?: number }>);
    for (const e of entries) sizes[e.id.toUpperCase()] = [e.cx ?? 1, e.cy ?? 1];
    landmarkSizesCache = sizes;
  }
  return { walls: wallSetCache, decor: decorSetCache, landmarkSizes: landmarkSizesCache };
}

/** A baseType → GLmark `[w,h]` resolver for the byte writer's plan footprints + the mechanics
 *  overlap check. Degrades to `undefined` (⇒ 1×1) when the catalog is missing, so asset
 *  volumes without decorCatalog.json validate exactly as before. */
let landmarkSizeFnCache: ((baseType: string) => readonly [number, number] | undefined) | null = null;
async function loadLandmarkSizeFn(): Promise<(baseType: string) => readonly [number, number] | undefined> {
  if (!landmarkSizeFnCache) {
    try {
      const { landmarkSizes } = await loadCatalogSets();
      landmarkSizeFnCache = (baseType: string) => landmarkSizes[(baseType ?? "").toUpperCase()];
    } catch {
      landmarkSizeFnCache = () => undefined;
    }
  }
  return landmarkSizeFnCache;
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
  step_registered: { recipeId: "water_lake|water_isles|water_islands|river|decor_forest|forest_scatter|forest_clearings|mountain_fill|mountain_blob|relief_ridge|relief_hills|wall_maze|road_path|decor_rocks|decor_bushes|decor_ruins|decor_graves|snow_overlay|snow_patches|snow_scatter|grass_fill", region: { x: 0, y: 0, w: 10, h: 10 } },
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
  log: EditLog,
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
  app.post<{ Body: { size?: number; fill?: string; name?: string; races?: string[] } }>(
    REST.mapNew,
    async (req, reply) => {
      const body = req.body ?? {};
      const size = Number(body.size);
      const fill = (FILLS.includes(body.fill as TerrainFill) ? body.fill : "default") as TerrainFill;
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "New map";
      if (!Number.isInteger(size) || size <= 0 || size % 8 !== 0) {
        return reply.code(400).send({ error: "size must be a positive multiple of 8" });
      }
      // playable races (the addRace port): validated against the RACES table, deduped.
      // At least ONE is required — a 0-race scenario is not a valid game map (gold check:
      // the game editor only accepts maps with playable races).
      const races = Array.isArray(body.races)
        ? [...new Set(body.races)].filter((r): r is RaceKey => RACE_KEYS.includes(r as RaceKey))
        : [];
      if (races.length === 0) {
        return reply.code(400).send({ error: "выберите хотя бы одну фракцию (карта без игроков не загрузится в игре)" });
      }
      let bytes: Uint8Array;
      try {
        bytes = createBlankMap({ size, fill, name, author: "web-editor", races });
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
  // (the install stays pristine). The copy is EPHEMERAL: swept EPHEMERAL_TTL_MS (2 days)
  // after the visitor's last access — every open/edit refreshes the timer.
  app.post<{ Params: { id: string } }>(REST.mapClone(":id"), async (req, reply) => {
    const { id } = req.params;
    const src = await store.getRawBytes(id);
    if (!src) {
      return reply.code(404).send({ error: "map not found" });
    }
    await mkdir(config.UPLOAD_DIR, { recursive: true });
    const file = join(config.UPLOAD_DIR, `copy-${id.slice(0, 8)}-${Date.now()}.sg`);
    await writeFile(file, src.bytes);
    const rec = await store.registerUpload(file, clientIdOf(req), { ephemeral: true });
    return reply.code(201).send({ id: rec.id });
  });

  // GET/PUT /api/maps/:id/project — server-saved EditorProject (the diff journal), keyed by
  // (mapId, x-client-id). Durability beyond the browser's localStorage: a new browser (or a
  // cleared one) restores the user's edits. The project is per-visitor — no cross-user reads.
  const projectPath = (mapId: string, clientId: string): string =>
    join(config.PROJECTS_DIR, sanitize(mapId), `${sanitize(clientId)}.json`);

  app.get<{ Params: { id: string } }>(REST.mapProject(":id"), async (req, reply) => {
    const clientId = clientIdOf(req);
    if (!clientId) return reply.code(400).send({ error: "x-client-id required" });
    try {
      const text = await readFile(projectPath(req.params.id, clientId), "utf-8");
      return reply.header("cache-control", "no-store").type("application/json").send(text);
    } catch {
      // "no saved project yet" is the NORMAL first-visit answer, not an error — 204 keeps the
      // browser console clean (it logs every 4xx fetch as an error even when the client handles it)
      return reply.code(204).send();
    }
  });

  app.put<{ Params: { id: string } }>(REST.mapProject(":id"), async (req, reply) => {
    const clientId = clientIdOf(req);
    if (!clientId) return reply.code(400).send({ error: "x-client-id required" });
    const parsed = EditorProject.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid EditorProject", detail: parsed.error.message });
    }
    if (parsed.data.baseScenarioId !== req.params.id) {
      return reply.code(400).send({ error: "project baseScenarioId mismatch" });
    }
    const path = projectPath(req.params.id, clientId);
    await mkdir(join(config.PROJECTS_DIR, sanitize(req.params.id)), { recursive: true });
    // atomic-ish write: tmp + rename so a crash never leaves a torn JSON
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(parsed.data), "utf-8");
    await rename(tmp, path);
    return { ok: true };
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

      const { report, bytes } = buildAndValidate(base.bytes, project, await loadTalismanTemplates(), await loadLandmarkSizeFn());

      if (action === "validate") {
        return reply.send(report);
      }
      // export: `bytes` is already the MODEL-REBUILT output (see buildAndValidate). Gate on a
      // clean report — a map the model can't faithfully reproduce fails here, never ships.
      if (!report.ok || !bytes) {
        return reply.code(422).send(report);
      }
      const fileName = `${project.meta.name ?? id}-edited.sg`;
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="${encodeURIComponent(fileName)}"`)
        .header("x-validation-ok", "1")
        .header("x-export-mode", "rebuild")
        .send(Buffer.from(bytes));
    });
  }

  // GET /api/maps/:id/export-at?channel&seq -> the .sg of the ROOM's durable op-log applied to
  // the base map up to `seq` ("выкачать промежуток": download the map as it was at a history
  // point). Uses the server log (the shared timeline), not the caller's journal. Validated
  // like /export; a non-clean point 422s with the report.
  app.get<{ Params: { id: string }; Querystring: { channel?: string; seq?: string } }>(
    REST.mapExportAt(":id"),
    async (req, reply) => {
      const { id } = req.params;
      try {
        const channel = typeof req.query.channel === "string" && req.query.channel ? req.query.channel : undefined;
        const key = roomKey(id, channel);
        await log.ensureLoaded(key);
        const head = log.head(key);
        const seqRaw = req.query.seq;
        const seq = seqRaw !== undefined && seqRaw !== "" ? Math.floor(Number(seqRaw)) : head;
        if (!Number.isFinite(seq) || seq < 0) {
          return reply.code(400).send({ error: "bad seq" });
        }
        const base = await store.getRawBytes(id);
        if (!base) {
          return reply.code(404).send({ error: "map not found" });
        }
        // ops with seq <= target (the log is seq-ordered; a preserved gap just means fewer ops)
        const ops = log.all(key).filter((e) => e.seq <= seq).map((e) => e.op);
        const proj: EditorProject = { ...emptyProject(id), journal: ops.length ? [ops] : [], cursor: ops.length ? 1 : 0 };
        const { report, bytes } = buildAndValidate(base.bytes, proj, await loadTalismanTemplates(), await loadLandmarkSizeFn());
        if (!report.ok || !bytes) {
          return reply.code(422).send(report);
        }
        const fileName = `${id}-seq${seq}.sg`;
        return reply
          .header("content-type", "application/octet-stream")
          .header("content-disposition", `attachment; filename="${encodeURIComponent(fileName)}"`)
          .header("x-validation-ok", "1")
          .send(Buffer.from(bytes));
      } catch (e) {
        return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

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
    // Collab id slot (M4): the client sends the slot the room assigned it, so landmark ids
    // this generation mints fall in that slot's disjoint band (no collision with a peer's
    // concurrent generation). nextTypedId clamps an out-of-range/absent slot to 0.
    const genSlot = Number.isInteger(body.slot) ? Number(body.slot) : 0;
    const t0 = Date.now();
    let ops;
    try {
      const { walls, decor, landmarkSizes } = await loadCatalogSets();
      ops = await runGenerationSteps(liveDoc, [{ recipeId, region, seed }], walls, seed, mask, protect, decor, landmarkSizes, genSlot);
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }

    // validate the generated ops as one more commit on top of the project
    const augmented = ops.length ? pushCommit(project, ops) : project;
    const { report } = buildAndValidate(base.bytes, augmented, await loadTalismanTemplates(), await loadLandmarkSizeFn());
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
        "water_lake (organic blob)", "water_isles (several lakes)",
        "water_islands (water with dry land islands)", "river (crosses the zone)",
        "decor_forest (groves)", "forest_scatter (sparse trees)", "forest_clearings (dense forest+glades)",
        "mountain_fill (solid fill — frame/border)", "mountain_blob (organic massif)",
        "relief_ridge (mountain ridge)", "relief_hills (scattered hills)",
        "wall_maze (stone-wall labyrinth, 2×2 walls + towers)",
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
    const { walls, decor, landmarkSizes } = await loadCatalogSets();
    const seed = Date.now() & 0x7fffffff;
    const mask = parseMask(body.cells);
    const protect = body.protect === true;
    const genSlot = Number.isInteger(body.slot) ? Number(body.slot) : 0;
    const t0 = Date.now();
    let ops;
    try {
      ops = await runGenerationSteps(liveDoc, steps, walls, seed, mask, protect, decor, landmarkSizes, genSlot);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e), requestId });
    }

    const augmented = ops.length ? pushCommit(project, ops) : project;
    const { report } = buildAndValidate(base.bytes, augmented, await loadTalismanTemplates(), await loadLandmarkSizeFn());
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
