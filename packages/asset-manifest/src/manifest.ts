import { z } from "zod";

/** Bump on any breaking change to the asset manifest contract (B). */
export const MANIFEST_VERSION = "0.1.0" as const;

/** D2 animation clock: verified 42ms/frame in MapView.cpp -> ~23.81fps. Pixi uses fps/60. */
export const D2_TICK_MS = 42 as const;

/** One generated atlas: a PNG/WebP image + its Pixi spritesheet JSON. */
export const SpritesheetRef = z.object({
  id: z.string(), // logical bundle id, e.g. "terrain", "iso-anim", "city"
  ff: z.string().optional(), // source .ff archive
  image: z.string(), // path under public/assets
  meta: z.string(), // path to the spritesheet JSON under public/assets
});
export type SpritesheetRef = z.infer<typeof SpritesheetRef>;

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
  index: AssetIndex.default({}),
  animations: z.array(AnimationDef).default([]),
  terrain: TerrainIndex.optional(),
  /** printf-style name builders mirrored from toolsqt (city/capital/mountain/...) */
  objectNaming: z.record(z.string()).default({}),
});
export type AssetManifest = z.infer<typeof AssetManifest>;
