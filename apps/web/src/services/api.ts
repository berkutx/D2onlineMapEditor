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

import { getClientId } from "./clientId";

// The base path the app is served under: '/' in dev, '/map/' in the production build (Vite
// `base`, surfaced as import.meta.env.BASE_URL). Every same-origin URL the client builds is
// prefixed with it so /api, /assets and /socket.io resolve under /map behind the tunnel.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, ""); // '' or '/map'
/** Prefix an absolute server path (e.g. REST.scenarios) with the deploy base. */
const u = (p: string): string => BASE + p;

/** Anonymous identity header — lets the server scope uploaded/new maps to this browser. */
const idHeaders = (): Record<string, string> => ({ "x-client-id": getClientId() });

/**
 * GET + parse JSON, with a few retries on TRANSIENT failures (network error / empty body /
 * 5xx). In dev the Vite proxy returns ECONNREFUSED/500/empty for a second or two whenever the
 * backend restarts; without a retry that one blip leaves the app blank with no recovery.
 * GETs are idempotent so retrying is safe (POSTs are NOT retried).
 */
async function getJson<T>(url: string, retries = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json", ...idHeaders() } });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `GET ${url} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
        );
      }
      const text = await res.text();
      if (!text) throw new Error(`GET ${url}: empty response (backend restarting?)`);
      return JSON.parse(text) as T;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** GET /api/scenarios -> ScenarioEntry[] */
export function fetchScenarios(): Promise<ScenarioEntry[]> {
  return getJson<ScenarioEntry[]>(u(REST.scenarios));
}

/** GET /api/scenarios/:id -> ScenarioEntry */
export function fetchScenario(id: string): Promise<ScenarioEntry> {
  return getJson<ScenarioEntry>(u(REST.scenario(id)));
}

/** GET /api/maps/:id -> MapDocument (the render-ready neutral document) */
export function fetchMapDocument(id: string): Promise<MapDocument> {
  return getJson<MapDocument>(u(REST.map(id)));
}

/** GET /api/maps/:id/meta -> MapMeta (cheap header for listings) */
export function fetchMapMeta(id: string): Promise<MapMeta> {
  return getJson<MapMeta>(u(REST.mapMeta(id)));
}

/** GET /api/assets/manifest -> AssetManifest (fetched once, cached in the store) */
export function fetchAssetManifest(): Promise<AssetManifest> {
  return getJson<AssetManifest>(u(REST.assetsManifest));
}

/** POST /api/maps/:id/validate -> ValidationReport (apply the project's ops, validate, no bytes).
 *  Pure server-side computation — safe to retry through the dev-proxy flake. */
export async function validateProject(
  id: string,
  project: EditorProject,
): Promise<ValidationReport> {
  return postJsonRetry<ValidationReport>(u(REST.mapValidate(id)), project);
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
  const res = await fetch(u(REST.mapExport(id)), {
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
  // pure computation (ops are only committed client-side afterwards) — retry-safe
  return postJsonRetry<GenerateResult>(u(REST.mapGenerate(id)), {
    project, recipeId, region, seed, cells: cells ?? undefined, protect: protect || undefined,
  });
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
    res = await fetch(u(REST.mapCopilot(id)), {
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

/**
 * POST JSON with the same transient-failure retries as getJson (network error / 5xx /
 * empty body). In dev the Vite proxy intermittently drops loopback connections
 * (ECONNREFUSED/ETIMEDOUT -> 500, empty body); an UN-retried POST here made "Новая карта"
 * silently fail and leave the editor on the previous (dirty) map. Only use for POSTs that
 * are safe to repeat (worst case for map creation: an orphan blank .sg server-side).
 */
async function postJsonRetry<T>(url: string, body: unknown, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...idHeaders() },
        body: JSON.stringify(body),
      });
      if (res.status >= 500) {
        const detail = await res.text().catch(() => "");
        throw new Error(`POST ${url}: ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
      }
      if (!res.ok) {
        // 4xx is a real, non-transient rejection — surface it without retrying
        const detail = await res.text().catch(() => "");
        return Promise.reject(
          new Error(`POST ${url} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`),
        );
      }
      const text = await res.text();
      if (!text) throw new Error(`POST ${url}: empty response (backend restarting?)`);
      return JSON.parse(text) as T;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** POST /api/maps/new -> { id }. Generates a from-scratch blank terrain map server-side. */
export async function createNewMap(opts: {
  size: number;
  fill: string; // a TerrainFill id; the server validates + defaults
  name: string;
}): Promise<string> {
  return (await postJsonRetry<{ id: string }>(u(REST.mapNew), opts)).id;
}

/** POST /api/maps/:id/clone -> { id }: a byte-exact personal copy owned by this browser.
 *  Used to hand a new visitor their OWN copy of the reference map (installs stay pristine). */
export async function cloneMap(id: string): Promise<string> {
  return (await postJsonRetry<{ id: string }>(u(REST.mapClone(id)), {})).id;
}

/** GET /api/maps/:id/project — this browser's server-saved EditorProject, or null. */
export async function fetchProjectRemote(id: string): Promise<EditorProject | null> {
  const res = await fetch(u(REST.mapProject(id)), {
    headers: { accept: "application/json", ...idHeaders() },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`project fetch failed: ${res.status}`);
  return (await res.json()) as EditorProject;
}

/** PUT /api/maps/:id/project — persist the EditorProject server-side (per x-client-id).
 *  Fire-and-forget durability mirror of localStorage; failures are non-fatal. */
export async function saveProjectRemote(id: string, project: EditorProject): Promise<void> {
  await fetch(u(REST.mapProject(id)), {
    method: "PUT",
    headers: { "content-type": "application/json", ...idHeaders() },
    body: JSON.stringify(project),
  });
}

/** Base URL the AssetStore prepends to every manifest-relative path. */
export const ASSET_BASE_URL = `${BASE}/assets`;

/** Build a URL for a file under the atlas/asset mount (catalogs, icons, sprite sheets). */
export const assetUrl = (rel: string): string => `${ASSET_BASE_URL}/${rel.replace(/^\//, "")}`;
