import { z } from "zod";

/** A discoverable scenario (from the game install or an upload). Public URLs use the opaque id. */
export const ScenarioEntry = z.object({
  id: z.string(), // opaque base32 id (never a raw filesystem path)
  name: z.string(),
  source: z.enum(["install", "upload"]),
  campaign: z.string().optional(),
  fileName: z.string(),
  mapSize: z.number().int(),
  players: z.number().int(),
  sizeBytes: z.number().int(),
  mtime: z.number(),
});
export type ScenarioEntry = z.infer<typeof ScenarioEntry>;

/** Cheap map header for listings/previews. */
export const MapMeta = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().int(),
  players: z.number().int(),
  version: z.string(),
  description: z.string().default(""),
});
export type MapMeta = z.infer<typeof MapMeta>;

/** REST surface (documented so web + server agree). Implemented by apps/server. */
export const REST = {
  scenarios: "/api/scenarios", // GET -> ScenarioEntry[]
  scenario: (id: string) => `/api/scenarios/${id}`, // GET -> ScenarioEntry
  map: (id: string) => `/api/maps/${id}`, // GET -> MapDocument
  mapMeta: (id: string) => `/api/maps/${id}/meta`, // GET -> MapMeta
  assetsManifest: "/api/assets/manifest", // GET -> AssetManifest
  upload: "/api/maps/upload", // POST .sg -> { id }
  health: "/api/health",
} as const;
