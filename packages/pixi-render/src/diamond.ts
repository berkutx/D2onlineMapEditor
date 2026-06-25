/**
 * DiamondCache — converts a square terrain texture into a 2:1 isometric diamond
 * tile, matching the editor's `MapTileHelper::drawTile`, which copies only the
 * diamond-masked region of each tile into the composited landscape.
 *
 * A diamond is `2*TILE_SIZE` wide x `TILE_SIZE` tall (TILE_SIZE=96 -> 192x96). We
 * render the source texture through a diamond mask into a RenderTexture once per
 * unique frame key (terrain base tiles are a small reused set), so the per-cell
 * cost is just a Sprite of a cached diamond texture.
 */
import {
  RenderTexture,
  Sprite,
  Graphics,
  Container,
  Texture,
  type Renderer,
} from "pixi.js";
import { TILE_W } from "./iso.js";

/** diamond footprint: 192 wide x 96 tall (2:1). */
export const DIAMOND_W = TILE_W; // 192
export const DIAMOND_H = TILE_W / 2; // 96

export class DiamondCache {
  private readonly cache = new Map<string, Texture>();
  constructor(private readonly renderer: Renderer) {}

  /** Get (or build+cache) the diamond-masked texture for a source frame. */
  get(key: string, src: Texture): Texture {
    const hit = this.cache.get(key);
    if (hit) return hit;

    const rt = RenderTexture.create({
      width: DIAMOND_W,
      height: DIAMOND_H,
      antialias: true,
    });

    // Draw the source at native size; the diamond mask crops its top 192x96 region
    // (same region the editor's drawTile reads: x in 0..2*TILE, y in 0..TILE).
    const spr = new Sprite(src);
    spr.position.set(0, 0);

    const mask = new Graphics()
      .poly([
        DIAMOND_W / 2, 0, // top
        DIAMOND_W, DIAMOND_H / 2, // right
        DIAMOND_W / 2, DIAMOND_H, // bottom
        0, DIAMOND_H / 2, // left
      ])
      .fill(0xffffff);
    spr.mask = mask;

    const stage = new Container();
    stage.addChild(mask, spr);
    this.renderer.render({ container: stage, target: rt, clear: true });
    stage.destroy({ children: true });

    this.cache.set(key, rt);
    return rt;
  }

  clear(): void {
    for (const t of this.cache.values()) t.destroy(true);
    this.cache.clear();
  }
}
