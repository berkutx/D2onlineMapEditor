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

/** A capability of a mod or a map, as the online engine's capability matrix states one. */
export const CapabilityInfo = z.object({
  id: z.string(),
  status: z.enum(["verified", "experimental", "missing"]),
  reason: z.string().optional(),
  evidence: z.array(z.string()).optional(),
});
export type CapabilityInfo = z.infer<typeof CapabilityInfo>;

/**
 * Everything the server knows about ONE mod (GET REST.mod): the list row plus where its data
 * came from. For the implicit `default` mod only the list row's fields are present.
 */
export const ModPassport = ModInfo.extend({
  /** Version of the asset pipeline (and its image encoder) that produced the files. */
  pipelineVersion: z.string().optional(),
  /**
   * Fingerprint of the whole install as the online engine's content pack computes it — what
   * an engine profile of the same installation is found by. Absent until it is recorded.
   */
  engineContentFingerprint: z.string().optional(),
  /** Hashes of the source the mod was built from (`exe`, `mss32`, `globals`, `scripts`). */
  source: z.record(z.string(), z.string()).optional(),
  /** What a map may rely on in this mod beyond the classic format. */
  capabilities: z.array(CapabilityInfo).optional(),
  /** A derived mod's base: unchanged files are the parent's. */
  parent: z.object({ modId: z.string(), contentFingerprint: z.string() }).optional(),
  /** Where this data set can be downloaded from, when it came from a catalog of builds. */
  sourceUrl: z.string().optional(),
  /** How many files (logical names) the mod consists of. */
  fileCount: z.number().int().optional(),
});
export type ModPassport = z.infer<typeof ModPassport>;

/**
 * How a map fits its mod, in the shape of the online engine SDK's compatibility report (the
 * same as `CompatibilityReport` of @d2/mod-catalog), so editor and engine reports are
 * interchangeable. Codes: `UNRESOLVED_GLOBAL_ID` (error: an id field points at a row the mod
 * lacks), `UNRESOLVED_SCRIPT_ID` (warning: script text quotes such an id).
 */
export const CompatReport = z.object({
  /** No error-level issue: the game of this mod will load the map. */
  playable: z.boolean(),
  issues: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(["error", "warning"]),
      message: z.string(),
      capability: z.string().optional(),
    }),
  ),
  capabilities: z.array(CapabilityInfo),
});
export type CompatReport = z.infer<typeof CompatReport>;

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
  /** Present only when the map does NOT fit its mod cleanly (some issue was found); a
   *  listing can flag such maps without opening them. Absent = nothing to report. */
  compat: CompatReport.optional(),
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
  /** How the map fits that mod, as a report (present when the mod has id tables to check
   *  against — always, except for the implicit `default` mod). */
  compat: CompatReport.optional(),
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
  /** The seed the variant was made with — the same request with it gives the same result. */
  seed?: number;
  /** How much the recipe was asked to make (1 = its stock amount). */
  amount?: number;
  /** number of plan steps executed (LLM /copilot path). */
  steps?: number;
  /** whether the protect-terrain flag was on. */
  protect?: boolean;
  /** count of protected (water/mountain) cells found in the target region. */
  protectedInRegion?: number;
  /** validation tier summary. */
  validation: { ok: boolean; identity: boolean; semantic: boolean; structural: boolean };
}

/** A recipe as a generator palette offers it (GET REST.generateRecipes). */
export interface GenRecipeInfo {
  id: string;
  /** What a mapmaker calls it. */
  title: string;
  /** What it makes: "mountains" | "water" | "forest" | "snow" | "ground" | "structures" | "decor". */
  group: string;
  /** Present when its amount can be tuned (the request's `amount`): what "more" means. */
  amountLabel?: string;
  /** Present when it can follow a hand-drawn stroke: the kind of stroke and its width in cells. */
  stroke?: "line" | "brush";
  strokeWidth?: number;
  /** Another seed gives another result; false for a plain fill (absent = assume it varies). */
  varies?: boolean;
  /** The same for a drawn stroke: true only when the recipe is sprinkled along it. */
  strokeVaries?: boolean;
  /**
   * Present when the list was asked for a mod (`?mod=`) that has nothing this recipe places:
   * what it lacks, in a mapmaker's words («в этом моде нет таких украшений»). The recipe would
   * run and change nothing, so a palette greys it out and says why.
   */
  lacks?: string;
}
export interface GenRecipeList {
  recipes: GenRecipeInfo[];
}

/**
 * What a recipe draws, as a small PLAN — for a picture in the generator help, not for a map.
 * `rows` is the recipe's symbol grid over a sample zone (one character per plan cell; a plan
 * cell is `scale`×`scale` map cells), and `legend` says what each symbol puts on the map:
 * "water", "forest", "mountain", "road", "wall", "wall:fence", "terrain:<id>",
 * "decor:<shape>"; a symbol absent from the legend leaves the ground as it is.
 */
export interface GenRecipePreview {
  id: string;
  width: number;
  height: number;
  scale: number;
  rows: string[];
  legend: Record<string, string>;
}
export interface GenPreviewList {
  previews: GenRecipePreview[];
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
  mapGenerate: (id: string) => `/api/maps/${id}/generate`, // POST { project, recipeId, region, seed?, amount?, cells?, stroke?, protect? } -> { ops, report, debug }
  generatePreviews: "/api/generate/previews", // GET -> GenPreviewList (a sample plan of every recipe, for the generator help)
  generateRecipes: "/api/generate/recipes", // GET [?mod=<id>] -> GenRecipeList (what can be generated, as a palette lists it; with a mod, what that mod lacks for a recipe)
  mapCopilot: (id: string) => `/api/maps/${id}/copilot`, // POST { project, text, selection? } -> { ops, report, reasoning } (LLM bridge)
  mods: "/api/mods", // GET -> ModList (the mod data sets this server serves)
  mod: (id: string) => `/api/mods/${id}`, // GET -> ModPassport (ETag = the mod's rev) | 404
  mapMod: (id: string) => `/api/maps/${id}/mod`, // PUT { modId } -> MapMeta (owner of an uploaded map only)
  mapNew: "/api/maps/new", // POST { size, fill?, name?, modId? } -> { id } (from-scratch blank terrain)
  mapClone: (id: string) => `/api/maps/${id}/clone`, // POST -> { id } (byte-exact personal copy, owned by x-client-id)
  mapProject: (id: string) => `/api/maps/${id}/project`, // GET -> saved EditorProject (per x-client-id) | 404; PUT EditorProject -> {ok}
  assetsManifest: "/api/assets/manifest", // GET [?mod=<id>] -> AssetManifest (default mod when omitted)
  upload: "/api/maps/upload", // POST .sg -> { id }
  previewUpload: "/api/maps/preview", // public POST .sg [?mod=<id>] -> one-hour read-only preview (mod: what the map was made for)
  voiceHandoff: (id: string) => `/api/maps/${id}/voice/handoff`,
  voiceReturnPreview: (id: string, token: string) => `/api/maps/${id}/voice/returns/${token}/preview`,
  voiceReturnApply: (id: string, token: string) => `/api/maps/${id}/voice/returns/${token}/apply`,
  voiceReturnAck: (id: string, token: string) => `/api/maps/${id}/voice/returns/${token}/ack`,
  mapExportPackage: (id: string) => `/api/maps/${id}/export-package`,
  health: "/api/health",
} as const;
