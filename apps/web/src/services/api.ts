/**
 * Typed REST helpers for the @d2/server. Routes come from the FROZEN Contract C
 * (`@d2/socket-contract` -> `REST`); response shapes come from Contracts A & B.
 *
 * In dev these are same-origin relative URLs proxied to :3000 by Vite (see
 * vite.config.ts). In prod they are served by the same Fastify instance.
 */
import { REST } from "@d2/socket-contract";
import type { ScenarioEntry, MapMeta, ValidationReport } from "@d2/socket-contract";
import type { MapDocument } from "@d2/map-schema";
import type { EditorProject } from "@d2/map-edit";
import type { AssetManifest } from "@d2/asset-manifest";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(
      `GET ${url} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

/** GET /api/scenarios -> ScenarioEntry[] */
export function fetchScenarios(): Promise<ScenarioEntry[]> {
  return getJson<ScenarioEntry[]>(REST.scenarios);
}

/** GET /api/scenarios/:id -> ScenarioEntry */
export function fetchScenario(id: string): Promise<ScenarioEntry> {
  return getJson<ScenarioEntry>(REST.scenario(id));
}

/** GET /api/maps/:id -> MapDocument (the render-ready neutral document) */
export function fetchMapDocument(id: string): Promise<MapDocument> {
  return getJson<MapDocument>(REST.map(id));
}

/** GET /api/maps/:id/meta -> MapMeta (cheap header for listings) */
export function fetchMapMeta(id: string): Promise<MapMeta> {
  return getJson<MapMeta>(REST.mapMeta(id));
}

/** GET /api/assets/manifest -> AssetManifest (fetched once, cached in the store) */
export function fetchAssetManifest(): Promise<AssetManifest> {
  return getJson<AssetManifest>(REST.assetsManifest);
}

/** POST /api/maps/:id/validate -> ValidationReport (apply the project's ops, validate, no bytes). */
export async function validateProject(
  id: string,
  project: EditorProject,
): Promise<ValidationReport> {
  const res = await fetch(REST.mapValidate(id), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(project),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`validate failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as ValidationReport;
}

/** Result of an export attempt: the `.sg` blob when valid, else the failing report. */
export type ExportResult =
  | { ok: true; blob: Blob; filename: string }
  | { ok: false; report: ValidationReport };

/**
 * POST /api/maps/:id/export. On success (200) returns the `.sg` bytes as a Blob;
 * on a validation failure (422) returns the report so the UI can explain why.
 */
export async function exportProject(id: string, project: EditorProject): Promise<ExportResult> {
  const res = await fetch(REST.mapExport(id), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(project),
  });
  if (res.status === 422) {
    return { ok: false, report: (await res.json()) as ValidationReport };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`export failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }
  const disp = res.headers.get("content-disposition") ?? "";
  const m = /filename="?([^"]+)"?/.exec(disp);
  const filename = m ? decodeURIComponent(m[1]!) : `${id}-edited.sg`;
  return { ok: true, blob: await res.blob(), filename };
}

/** POST /api/maps/new -> { id }. Generates a from-scratch blank terrain map server-side. */
export async function createNewMap(opts: {
  size: number;
  fill: string; // a TerrainFill id; the server validates + defaults
  name: string;
}): Promise<string> {
  const res = await fetch(REST.mapNew, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`new map failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }
  return ((await res.json()) as { id: string }).id;
}

/** Base URL the AssetStore prepends to every manifest-relative path. */
export const ASSET_BASE_URL = "/assets";
