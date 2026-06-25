/**
 * Typed REST helpers for the @d2/server. Routes come from the FROZEN Contract C
 * (`@d2/socket-contract` -> `REST`); response shapes come from Contracts A & B.
 *
 * In dev these are same-origin relative URLs proxied to :3000 by Vite (see
 * vite.config.ts). In prod they are served by the same Fastify instance.
 */
import { REST } from "@d2/socket-contract";
import type { ScenarioEntry, MapMeta } from "@d2/socket-contract";
import type { MapDocument } from "@d2/map-schema";
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

/** Base URL the AssetStore prepends to every manifest-relative path. */
export const ASSET_BASE_URL = "/assets";
