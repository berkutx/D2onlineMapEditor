/**
 * TerrainLayer — displays the pre-composited terrain image produced by the offline
 * compositor (tools/asset-pipeline/compose_terrain.py), which is a faithful port of
 * the editor's MapTileHelper/LandscapeObject: seamless region extraction + masked
 * neighbour-config border blending. The renderer just places it as a single sprite.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 *
 * Alignment: the compositor reports `cell0Center` (the pixel center of cell (0,0) in
 * the image). We position the sprite at `-cell0Center` so that cell (0,0) lands at
 * world (0,0); every other cell then sits at `cellToWorld(x, y)` — the same basis the
 * object and grid layers use, so they line up exactly.
 */
import { Container, Sprite, type Texture } from "pixi.js";

export interface TerrainMeta {
  size: number;
  tile: number;
  width: number;
  height: number;
  cell0Center: { x: number; y: number };
}

export class TerrainLayer {
  readonly view: Container;

  constructor() {
    this.view = new Container();
    this.view.label = "terrain";
  }

  /** Place the composited terrain image so cell (0,0) center is at world (0,0). */
  build(texture: Texture, meta: TerrainMeta): void {
    this.view.removeChildren().forEach((c) => c.destroy());
    const sprite = new Sprite(texture);
    sprite.position.set(-meta.cell0Center.x, -meta.cell0Center.y);
    this.view.addChild(sprite);
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
