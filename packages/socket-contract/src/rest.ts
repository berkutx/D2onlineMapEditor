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

/**
 * Result of running the writer + validator over an EditorProject on the server.
 * `ok` gates whether an exported `.sg` is allowed out. Tiers mirror the editor's
 * BlockComparator (identity), our model/byte consistency (semantic), and
 * MapConverter::validateMap (structural).
 */
export const ValidationReport = z.object({
  ok: z.boolean(),
  /** Base map re-emits byte-for-byte with no edits (round-trip pass-through sound). */
  identity: z.boolean(),
  /** Re-parsed export === in-memory model after applying the same ops. */
  semantic: z.object({ ok: z.boolean(), reason: z.string().optional() }),
  /** Structural + referential sanity of the exported document. */
  structural: z.object({
    ok: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  /** Number of ops applied (0 == pure validate of the untouched map). */
  opCount: z.number().int(),
  /** Size of the produced `.sg` in bytes (0 when the build itself failed). */
  byteLength: z.number().int(),
});
export type ValidationReport = z.infer<typeof ValidationReport>;

/** REST surface (documented so web + server agree). Implemented by apps/server. */
export const REST = {
  scenarios: "/api/scenarios", // GET -> ScenarioEntry[]
  scenario: (id: string) => `/api/scenarios/${id}`, // GET -> ScenarioEntry
  map: (id: string) => `/api/maps/${id}`, // GET -> MapDocument
  mapMeta: (id: string) => `/api/maps/${id}/meta`, // GET -> MapMeta
  mapRaw: (id: string) => `/api/maps/${id}/raw`, // GET -> original .sg bytes
  mapValidate: (id: string) => `/api/maps/${id}/validate`, // POST EditorProject -> ValidationReport
  mapExport: (id: string) => `/api/maps/${id}/export`, // POST EditorProject -> .sg bytes (or 422 + report)
  mapNew: "/api/maps/new", // POST { size, fill?, name? } -> { id } (from-scratch blank terrain)
  assetsManifest: "/api/assets/manifest", // GET -> AssetManifest
  upload: "/api/maps/upload", // POST .sg -> { id }
  health: "/api/health",
} as const;
