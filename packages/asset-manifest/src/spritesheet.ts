import { z } from "zod";

/** PixiJS v8 spritesheet ("JSON Hash") — natively loadable by Assets.load(), plus a `d2`
 *  extension carrying the shader variant and the 42ms-derived per-animation fps. Emitted
 *  per source atlas by the Python pipeline. */
export const FrameRect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

export const SpriteFrame = z.object({
  frame: FrameRect,
  rotated: z.boolean().default(false),
  trimmed: z.boolean().default(false),
  /** trim offset within the original canvas (restores iso anchor) */
  spriteSourceSize: FrameRect.optional(),
  /** full original image size (before trim) */
  sourceSize: z.object({ w: z.number(), h: z.number() }).optional(),
  /** anchor as 0..1 fractions; default bottom-center for iso objects */
  anchor: z.object({ x: z.number(), y: z.number() }).optional(),
});
export type SpriteFrame = z.infer<typeof SpriteFrame>;

export const D2ShaderKind = z.enum([
  "default",
  "shadows",
  "transparentBlack",
  "border",
  "playerColor",
]);
export type D2ShaderKind = z.infer<typeof D2ShaderKind>;

export const SpritesheetMeta = z.object({
  image: z.string(), // atlas PNG/WebP filename (relative to the .json)
  format: z.string().default("RGBA8888"),
  size: z.object({ w: z.number(), h: z.number() }),
  scale: z.number().default(1),
  d2: z
    .object({
      ff: z.string().optional(), // source archive name
      shader: D2ShaderKind.optional(),
      tileW: z.number().optional(),
      fps: z.record(z.number()).optional(), // animationName -> fps
    })
    .optional(),
});

export const Spritesheet = z.object({
  frames: z.record(SpriteFrame),
  /** Pixi-native: animationName -> ordered frame keys */
  animations: z.record(z.array(z.string())).optional(),
  meta: SpritesheetMeta,
});
export type Spritesheet = z.infer<typeof Spritesheet>;
