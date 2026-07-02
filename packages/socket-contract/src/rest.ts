import { z } from "zod";
import type { EditOp } from "./ops.js";

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
  /** Anonymous owner (x-client-id) of an uploaded/new map (v0.2, additive). The server
   *  lists an owned upload ONLY to its owner; install maps have no owner. */
  owner: z.string().optional(),
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

/** A rectangular map region (cells): top-left (x,y) + size (w,h). */
export const Region = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
export type Region = z.infer<typeof Region>;

/** Copilot generation request: run `recipeId` over `region`, given the current project. */
export const GenerateRequest = z.object({
  recipeId: z.string(),
  region: Region,
  seed: z.number().int().optional(),
  /** the current EditorProject (validated separately by @d2/map-edit). */
  project: z.unknown(),
});

/** Debug/telemetry for a generation (timing + counts), surfaced in the Copilot for tuning. */
export interface GenDebug {
  /** server-side time for recipe run + decode + validate (ms). */
  serverMs: number;
  /** number of EditOps produced. */
  opCount: number;
  /** registered recipe id (single-recipe /generate path). */
  recipe?: string;
  /** number of plan steps executed (LLM /copilot path). */
  steps?: number;
  /** whether the protect-terrain flag was on. */
  protect?: boolean;
  /** count of protected (water/mountain) cells found in the target region. */
  protectedInRegion?: number;
  /** validation tier summary. */
  validation: { ok: boolean; identity: boolean; semantic: boolean; structural: boolean };
}

/** Generation result: the new EditOps to commit + the validation verdict for them. */
export interface GenerateResult {
  ops: EditOp[];
  report: ValidationReport;
  debug?: GenDebug;
}

/**
 * Copilot LLM request: a natural-language command + the current project. The server
 * writes it (with map context) to a file for an LLM/agent to answer with a plan, then
 * executes the plan and returns the result. (Phase 4 POC; the "LLM" is file-bridged.)
 */
export const CopilotRequest = z.object({
  text: z.string(),
  /** optional current zone selection (the Copilot ⛶ region), as a hint for the LLM. */
  selection: Region.nullish(),
  /** the current EditorProject (validated separately by @d2/map-edit). */
  project: z.unknown(),
});

/** Copilot LLM result: the EditOps to commit + their validation verdict + the LLM's prose. */
export interface CopilotResult {
  ops: EditOp[];
  report: ValidationReport;
  /** the LLM's short human-facing explanation of what it did (shown in the chat). */
  reasoning?: string;
  /** the executed plan steps (for transparency / debugging). */
  steps?: unknown[];
  debug?: GenDebug;
}

/** REST surface (documented so web + server agree). Implemented by apps/server. */
export const REST = {
  scenarios: "/api/scenarios", // GET -> ScenarioEntry[]
  scenario: (id: string) => `/api/scenarios/${id}`, // GET -> ScenarioEntry
  map: (id: string) => `/api/maps/${id}`, // GET -> MapDocument
  mapMeta: (id: string) => `/api/maps/${id}/meta`, // GET -> MapMeta
  mapRaw: (id: string) => `/api/maps/${id}/raw`, // GET -> original .sg bytes
  mapValidate: (id: string) => `/api/maps/${id}/validate`, // POST EditorProject -> ValidationReport
  mapExport: (id: string) => `/api/maps/${id}/export`, // POST EditorProject -> .sg bytes (or 422 + report)
  mapGenerate: (id: string) => `/api/maps/${id}/generate`, // POST { project, recipeId, region, seed? } -> { ops, report }
  mapCopilot: (id: string) => `/api/maps/${id}/copilot`, // POST { project, text, selection? } -> { ops, report, reasoning } (LLM bridge)
  mapNew: "/api/maps/new", // POST { size, fill?, name? } -> { id } (from-scratch blank terrain)
  assetsManifest: "/api/assets/manifest", // GET -> AssetManifest
  upload: "/api/maps/upload", // POST .sg -> { id }
  health: "/api/health",
} as const;
