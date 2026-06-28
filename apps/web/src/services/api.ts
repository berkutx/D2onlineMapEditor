/**
 * Typed REST helpers for the @d2/server. Routes come from the FROZEN Contract C
 * (`@d2/socket-contract` -> `REST`); response shapes come from Contracts A & B.
 *
 * In dev these are same-origin relative URLs proxied to :3000 by Vite (see
 * vite.config.ts). In prod they are served by the same Fastify instance.
 */
import { REST } from "@d2/socket-contract";
import type {
  ScenarioEntry,
  MapMeta,
  ValidationReport,
  Region,
  GenerateResult,
  CopilotResult,
} from "@d2/socket-contract";
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

/**
 * POST /api/maps/:id/generate — run a Copilot recipe over `region` against the current
 * project. Returns the new EditOps + their validation report; the caller commits the ops.
 */
export async function generateRegion(
  id: string,
  project: EditorProject,
  recipeId: string,
  region: Region,
  seed?: number,
  cells?: [number, number][] | null,
  protect?: boolean,
): Promise<GenerateResult> {
  const res = await fetch(REST.mapGenerate(id), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ project, recipeId, region, seed, cells: cells ?? undefined, protect: protect || undefined }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`generate failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as GenerateResult;
}

/**
 * POST /api/maps/:id/copilot — the Phase-4 LLM bridge (POC). Sends a natural-language
 * command + the current project; the server file-bridges it to an LLM/agent and returns the
 * resulting EditOps + validation report + the LLM's prose. This call can block for a while
 * (the server long-polls for the agent's reply), so the caller should show a "thinking" state.
 */
export async function copilotLlm(
  id: string,
  project: EditorProject,
  text: string,
  selection?: Region | null,
  cells?: [number, number][] | null,
  protect?: boolean,
  timeoutMs = 175_000,
): Promise<CopilotResult> {
  // Abort if the bridge is unreachable/unresponsive (server long-polls ~150s for the agent).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(REST.mapCopilot(id), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ project, text, selection: selection ?? null, cells: cells ?? undefined, protect: protect || undefined }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(`LLM не ответил за ${Math.round(timeoutMs / 1000)}с (агент не на связи?)`);
    }
    throw new Error(`copilot недоступен: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`copilot failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as CopilotResult;
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
