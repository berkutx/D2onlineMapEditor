import { z } from "zod";
import type { EditOp } from "./ops.js";

/**
 * A mod data set the server serves (v0.3, additive). A mod is one game data set — Globals
 * tables, sprites, scripts — that maps are opened against. A deployment that still has the
 * flat pre-multi-mod assets layout reports exactly one mod, `default`.
 */
export const ModInfo = z.object({
  id: z.string(),
  name: z.string(),
  /** Mods of one family are versions of the same line; the highest `familyOrder` is newest. */
  family: z.string(),
  familyOrder: z.number().int(),
  /** `data-only`: tables are available for compatibility checks, graphics are not built. */
  status: z.enum(["ready", "data-only"]),
  /** Identity of the mod's source data; absent for the implicit `default` mod. */
  contentFingerprint: z.string().optional(),
  /** Changes whenever the mod's files are rebuilt. */
  rev: z.string(),
  /**
   * Root-relative base URL of the mod's files, no trailing slash. Every asset of the mod —
   * catalogs, icons, atlas pages — is `<assetBase>/<logical name>`. It contains `rev`, so
   * the files may be cached forever and a rebuild is picked up at once.
   */
  assetBase: z.string(),
});
export type ModInfo = z.infer<typeof ModInfo>;

export const ModList = z.object({
  /** The mod used for a map whose own mod cannot be determined. */
  defaultModId: z.string(),
  mods: z.array(ModInfo),
});
export type ModList = z.infer<typeof ModList>;

/**
 * How a map's mod was decided:
 *  - `install`  the map lives in a mod's own scenario folder;
 *  - `choice`   set explicitly (the creator picked it, or it was inherited by a clone);
 *  - `detected` the ids the map references fit one mod family best;
 *  - `default`  nothing tells the mods apart for this map — the server's default mod.
 */
export const MapModSource = z.enum(["install", "choice", "detected", "default"]);
export type MapModSource = z.infer<typeof MapModSource>;

/** The mod of a map, and how well the map fits it. */
export const MapMod = z.object({
  id: z.string(),
  source: MapModSource,
  /**
   * Ids the map references that this mod does not define, by Globals table code (`UU`
   * units, `IG` items, …). Present only when the mod has id tables to check against.
   * `missing` counts id FIELDS (the game refuses such a map); `scriptMissing` counts ids
   * quoted in script text embedded in the map (the script fails at run time).
   */
  missing: z.number().int().optional(),
  missingByTable: z.record(z.string(), z.array(z.string())).optional(),
  scriptMissing: z.number().int().optional(),
  scriptMissingByTable: z.record(z.string(), z.array(z.string())).optional(),
  /** Every mod the map was matched against, best fit first. */
  candidates: z
    .array(z.object({ modId: z.string(), missing: z.number().int(), scriptMissing: z.number().int() }))
    .optional(),
});
export type MapMod = z.infer<typeof MapMod>;

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
  /** Id of the map's mod (v0.3, additive) — see MapMeta.mod for how it was decided. */
  mod: z.string().optional(),
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
  /** Temporary previews are capability-linked, read-only maps. These additive fields are
   * absent on ordinary editable maps so older clients keep working unchanged. */
  readOnly: z.boolean().optional(),
  expiresAt: z.number().int().optional(),
  /** The mod the map is opened against (v0.3, additive). Absent from servers that predate
   *  mods; a client then uses the `default` mod. */
  mod: MapMod.optional(),
  /** The caller may change the map's mod (PUT REST.mapMod): it is their own uploaded map. */
  modEditable: z.boolean().optional(),
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
  /** collab id slot (M4): landmark ids mint in this slot's disjoint band so a peer's
   *  concurrent generation never collides. Absent/0 = solo. */
  slot: z.number().int().optional(),
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
  /** collab id slot (M4): see GenerateRequest.slot. */
  slot: z.number().int().optional(),
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
  mapExportAt: (id: string) => `/api/maps/${id}/export-at`, // GET ?channel&seq -> .sg bytes of the room log up to seq ("выкачать промежуток")
  mapGenerate: (id: string) => `/api/maps/${id}/generate`, // POST { project, recipeId, region, seed? } -> { ops, report }
  mapCopilot: (id: string) => `/api/maps/${id}/copilot`, // POST { project, text, selection? } -> { ops, report, reasoning } (LLM bridge)
  mods: "/api/mods", // GET -> ModList (the mod data sets this server serves)
  mapMod: (id: string) => `/api/maps/${id}/mod`, // PUT { modId } -> MapMeta (owner of an uploaded map only)
  mapNew: "/api/maps/new", // POST { size, fill?, name?, modId? } -> { id } (from-scratch blank terrain)
  mapClone: (id: string) => `/api/maps/${id}/clone`, // POST -> { id } (byte-exact personal copy, owned by x-client-id)
  mapProject: (id: string) => `/api/maps/${id}/project`, // GET -> saved EditorProject (per x-client-id) | 404; PUT EditorProject -> {ok}
  assetsManifest: "/api/assets/manifest", // GET [?mod=<id>] -> AssetManifest (default mod when omitted)
  upload: "/api/maps/upload", // POST .sg -> { id }
  previewUpload: "/api/maps/preview", // public POST .sg -> one-hour read-only preview
  voiceHandoff: (id: string) => `/api/maps/${id}/voice/handoff`,
  voiceReturnPreview: (id: string, token: string) => `/api/maps/${id}/voice/returns/${token}/preview`,
  voiceReturnApply: (id: string, token: string) => `/api/maps/${id}/voice/returns/${token}/apply`,
  voiceReturnAck: (id: string, token: string) => `/api/maps/${id}/voice/returns/${token}/ack`,
  mapExportPackage: (id: string) => `/api/maps/${id}/export-package`,
  health: "/api/health",
} as const;
