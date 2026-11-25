import { z } from "zod";

/**
 * Version of the asset manifest contract (B).
 *
 * 0.1 — atlas pages: every sheet has a Pixi spritesheet JSON (`meta`) with its frame
 *       rectangles, and `index` names the sheet GROUP a frame lives in.
 * 0.2 — one small sheet per source image record: no JSON per sheet; the frame rectangles of
 *       every sheet are in the manifest's own `frames` table, and a sheet says itself whether
 *       it is loaded up front or on demand (`lazy`). A reader accepts both: a manifest with a
 *       `frames` table is read the 0.2 way, one without it the 0.1 way.
 */
export const MANIFEST_VERSION = "0.2.0" as const;

/** D2 animation clock: verified 42ms/frame in MapView.cpp -> ~23.81fps. Pixi uses fps/60. */
export const D2_TICK_MS = 42 as const;

/** One generated sheet: an image, and (0.1) its Pixi spritesheet JSON. */
export const SpritesheetRef = z.object({
  id: z.string(), // 0.1: bundle page id ("iso-anim-3"); 0.2: sheet id ("iso-cmon/1234")
  ff: z.string().optional(), // source .ff archive
  /**
   * The image. A path beginning with `blobs/` is relative to the asset STORE root (a
   * content-addressed file shared by every mod that has the same sheet); any other path is
   * relative to the manifest.
   */
  image: z.string(),
  /** 0.1 only: path to the spritesheet JSON. A 0.2 sheet has none (see `frames`). */
  meta: z.string().optional(),
  /** Download size in bytes (0.1: image + meta JSON). Optional/additive: the debug HUD
   *  sums it per LOADED sheet — worker-side image fetches are invisible to the main thread's
   *  resource timing, so declared sizes are the only accurate accounting. */
  bytes: z.number().int().nonnegative().optional(),
  /** 0.2: fetched on demand, by the frame keys a map needs (absent = loaded up front). */
  lazy: z.boolean().optional(),
  /** 0.2: image size in pixels, [width, height]. */
  size: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
});
export type SpritesheetRef = z.infer<typeof SpritesheetRef>;

/**
 * 0.2: where one frame sits —
 * `[sheet, x, y, w, h, trimX, trimY, sourceW, sourceH]`: `sheet` is an index into
 * `spritesheets`; `x,y,w,h` the (trimmed) rectangle on the sheet; `trimX,trimY` its offset
 * inside the untrimmed `sourceW x sourceH` image (what restores the iso anchor).
 */
export const FrameEntry = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().positive(),
  z.number().int().positive(),
  z.number().int(),
  z.number().int(),
  z.number().int().positive(),
  z.number().int().positive(),
]);
export type FrameEntry = z.infer<typeof FrameEntry>;

/** A named animation sequence (water, crystals, unit idle, ...). */
export const AnimationDef = z.object({
  id: z.string(),
  atlas: z.string(), // SpritesheetRef.id it lives in
  frames: z.array(z.string()), // ordered frame keys
  frameDurationMs: z.number().default(D2_TICK_MS),
  fps: z.number().default(1000 / D2_TICK_MS),
  loop: z.boolean().default(true),
  anchor: z.object({ x: z.number(), y: z.number() }).optional(),
});
export type AnimationDef = z.infer<typeof AnimationDef>;

/** Encodes the toolsqt MapTileHelper terrain logic so the renderer picks frames from a
 *  MapCell without re-deriving it. `seed` is the verified variation formula. */
export const TerrainIndex = z.object({
  tileW: z.number().default(192),
  /** ground/race id -> ordered base tile frame keys (seed selects a variant) */
  base: z.record(z.array(z.string())).default({}),
  /** border-blend frame keys (water "WA_xx_yy", land "<race>_NE_xx_yy") */
  borders: z.record(z.array(z.string())).default({}),
  /** road tiles keyed by roadType */
  roads: z.record(z.array(z.string())).default({}),
  /** forest overlay frame keys by forest index */
  forest: z.record(z.string()).default({}),
  /** variation seed formula (documented; renderer reimplements deterministically) */
  seedFormula: z.string().default("(x*y + x + y) % n"),
});
export type TerrainIndex = z.infer<typeof TerrainIndex>;

/** logicalName -> where to find it. Resolves MapObject.imageName / terrain keys. */
export const AssetIndexEntry = z.object({ sheet: z.string(), frame: z.string() });
export const AssetIndex = z.record(AssetIndexEntry);

export const AssetManifest = z.object({
  manifestVersion: z.string(),
  generatedAt: z.string().optional(),
  sourceGameVersion: z.string().optional(),
  tickMs: z.number().default(D2_TICK_MS),
  /** "baked" = sheets are pre-recolored RGBA; "palette" = recolor at runtime */
  paletteMode: z.enum(["baked", "palette"]).default("baked"),
  spritesheets: z.array(SpritesheetRef).default([]),
  /** 0.2: frame key -> where it sits. Its presence is what makes a manifest "0.2". */
  frames: z.record(FrameEntry).optional(),
  index: AssetIndex.default({}),
  animations: z.array(AnimationDef).default([]),
  terrain: TerrainIndex.optional(),
  /** printf-style name builders mirrored from toolsqt (city/capital/mountain/...) */
  objectNaming: z.record(z.string()).default({}),
});
export type AssetManifest = z.infer<typeof AssetManifest>;
