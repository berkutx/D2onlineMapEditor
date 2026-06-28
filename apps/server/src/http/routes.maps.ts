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

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { REST, type ValidationReport } from "@d2/socket-contract";
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
  applyEditsToBytes,
  roundTripSemantic,
} from "@d2/map-edit";
import { config } from "../config.js";
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
  const ops = activeOps(project);

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
  return { report, bytes };
}

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
      const rec = await store.registerUpload(file);
      return reply.code(201).send({ id: rec.id });
    },
  );

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
}
