/**
 * Contract D — the description of a MOD data set.
 *
 * A mod is one game data set the editor can open maps against: the Globals tables, sprites
 * and scripts of one installation (SMNS, Legacy, …), converted by the asset pipeline. Its
 * files live in a content-addressed store shared by all mods:
 *
 *   mods/index.json            the installed mods ({@link ModIndex})
 *   mods/<modId>/mod.json      one mod's passport ({@link ModManifest})
 *   blobs/<xx>/<sha256>.<ext>  immutable files, shared by every mod that has the same bytes
 *
 * Every mod keeps a COMPLETE manifest (no base + overlay): `files` maps each logical name
 * the editor asks for ("unitCatalog.json", "itemicons/g000ig0001.png", …) to a blob, and
 * two mods that produce identical bytes simply name the same blob.
 */
import { z } from "zod";

export const MOD_SCHEMA_VERSION = 1 as const;

/** A mod id: a lowercase URL- and path-safe slug ("smns3", "nazar-legacy", "semga-2"). */
export const ModId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "mod id must be a lowercase slug");
export type ModId = z.infer<typeof ModId>;

/** Lowercase hex sha256. */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256");

/** Path of a blob inside the asset store: `blobs/<first two hex>/<sha256>.<ext>`. */
export const BlobPath = z
  .string()
  .regex(/^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]+$/, "expected blobs/<xx>/<sha256>.<ext>")
  .refine((p) => p.slice(6, 8) === p.slice(9, 11), "blob directory must be the first two hex digits of the hash");
export type BlobPath = z.infer<typeof BlobPath>;

/**
 * `ready`     — catalogs and graphics are built; maps can be opened on this mod.
 * `data-only` — tables/ids are built but graphics are not yet: usable for compatibility
 *               checks, not offered as the mod to open a map on.
 */
export const ModStatus = z.enum(["ready", "data-only"]);
export type ModStatus = z.infer<typeof ModStatus>;

/**
 * Something a mod (or, later, a map) can do or need — same shape as the engine SDK's
 * `Capability`, so capability lists stay interchangeable between editor and engine.
 */
export const Capability = z.object({
  id: z.string().min(1),
  status: z.enum(["verified", "experimental", "missing"]),
  reason: z.string().optional(),
  evidence: z.array(z.string()).optional(),
});
export type Capability = z.infer<typeof Capability>;

/** One row of the mod index — what a listing needs without opening the mod. */
export const ModSummary = z.object({
  id: ModId,
  name: z.string().min(1),
  /**
   * Mods of one FAMILY are versions of the same line (semga, semga-2). A map that fits
   * several versions equally opens on the one with the highest `familyOrder`.
   */
  family: z.string().min(1),
  familyOrder: z.number().int().default(0),
  status: ModStatus.default("ready"),
  /**
   * Identity of the mod's source data: sha256 over the sorted `path\0size\0sha256` lines of
   * the install files the pipeline reads (Globals/*.dbf, Scripts/**.lua, the Imgs/*.ff it
   * converts). Two builds of the same install share it; any data change alters it.
   */
  contentFingerprint: Sha256,
  /**
   * Where this data set can be downloaded from — set on a mod that came from (or is offered
   * in) a catalog of ready builds, so a listing can fetch or update it. A locally built mod
   * has none.
   */
  sourceUrl: z.string().url().optional(),
});
export type ModSummary = z.infer<typeof ModSummary>;

export const ModIndex = z.object({
  schemaVersion: z.literal(MOD_SCHEMA_VERSION),
  /** The mod used when a map's own mod cannot be determined (an empty map fits them all). */
  defaultModId: ModId.optional(),
  mods: z.array(ModSummary).default([]),
});
export type ModIndex = z.infer<typeof ModIndex>;

/** Hashes of the files that identify the installation the mod was built from. */
export const ModSource = z.object({
  /** sha256 of Discipl2.exe. */
  exe: Sha256.optional(),
  /** sha256 of mss32.dll (the D2ModdingToolset build the mod ships). */
  mss32: Sha256.optional(),
  /** Fingerprint over Globals/*.dbf only. */
  globals: Sha256.optional(),
  /** Fingerprint over Scripts/**.lua only. */
  scripts: Sha256.optional(),
});
export type ModSource = z.infer<typeof ModSource>;

export const ModManifest = ModSummary.extend({
  schemaVersion: z.literal(MOD_SCHEMA_VERSION),
  /** Version of the asset pipeline (and its image encoder) that produced the files. */
  pipelineVersion: z.string().min(1),
  /**
   * Fingerprint of the WHOLE install as the online engine's content pack computes it — lets
   * a map be handed to the engine profile built from the same installation. Optional: the
   * editor does not need the engine pack to exist.
   */
  engineContentFingerprint: Sha256.optional(),
  source: ModSource.default({}),
  capabilities: z.array(Capability).default([]),
  /**
   * Set on a DERIVED mod (a base data set + edits): the mod it was derived from. Unchanged
   * files are the parent's blobs, so a derived mod costs only what it changes.
   */
  parent: z.object({ modId: ModId, contentFingerprint: Sha256 }).optional(),
  /** Logical file name → blob. Forward slashes, no leading slash, no `..` segments. */
  files: z
    .record(
      z.string().regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\\]+$/, "logical paths are relative, forward-slashed, without .."),
      BlobPath,
    )
    .default({}),
});
export type ModManifest = z.infer<typeof ModManifest>;

/** The index row of a manifest (the fields the two share). */
export function summaryOf(manifest: ModManifest): ModSummary {
  const { id, name, family, familyOrder, status, contentFingerprint, sourceUrl } = manifest;
  return { id, name, family, familyOrder, status, contentFingerprint, ...(sourceUrl ? { sourceUrl } : {}) };
}
