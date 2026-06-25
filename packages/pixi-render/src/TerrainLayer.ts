/**
 * TerrainLayer — stamps the terrain grid as a layer of isometric DIAMOND tiles,
 * matching the editor (`MapTileHelper::drawTile` stamps diamond-masked tiles into
 * the composited landscape).
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 *
 * For every cell {@link selectTerrain} returns the ordered frame keys
 * (base -> borders -> road -> forest); each is resolved to a Texture via the
 * {@link AssetStore}, converted to a 2:1 diamond via {@link DiamondCache} (cached
 * per unique frame), and placed as a center-anchored Sprite at the cell's iso world
 * position so the diamonds tessellate into a true isometric surface.
 */
import { Container, Sprite, type Texture, type Renderer } from "pixi.js";
import type { TerrainGrid } from "@d2/map-schema";
import type { TerrainIndex } from "@d2/asset-manifest";
import { cellToWorld } from "./iso.js";
import { selectTerrain, type TerrainStamp } from "./terrainSelect.js";
import { DiamondCache } from "./diamond.js";
import type { AssetStore } from "./AssetStore.js";

export class TerrainLayer {
  /** The display object to add to the world container. */
  readonly view: Container;
  private diamonds?: DiamondCache;

  constructor() {
    this.view = new Container();
    this.view.label = "terrain";
    this.view.cullable = true;
  }

  /** Rebuild the whole terrain from a grid. Needs the renderer to bake diamonds. */
  build(
    grid: TerrainGrid,
    terrain: TerrainIndex | undefined,
    assets: AssetStore,
    renderer: Renderer,
  ): void {
    this.view.removeChildren().forEach((c) => c.destroy());
    this.diamonds?.clear();
    this.diamonds = new DiamondCache(renderer);
    if (!terrain) return;

    for (const cell of grid.cells) {
      const stamp = selectTerrain(grid, cell, terrain);
      this.stampCell(cell.x, cell.y, stamp, assets);
    }
  }

  private stampCell(
    cx: number,
    cy: number,
    stamp: TerrainStamp,
    assets: AssetStore,
  ): void {
    const center = cellToWorld(cx, cy);

    const place = (key: string | undefined): void => {
      if (!key || !assets.hasTexture(key)) return;
      const src = assets.resolveTexture(key);
      if (src.label === "EMPTY") return;
      const tex = this.diamonds!.get(key, src);
      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5, 0.5);
      sprite.position.set(center.x, center.y);
      this.view.addChild(sprite);
    };

    place(stamp.base);
    for (const b of stamp.borders) place(b);
    place(stamp.road);
    place(stamp.forest);
  }

  /** Show/hide the whole terrain layer. */
  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.diamonds?.clear();
    this.view.destroy({ children: true });
  }
}
