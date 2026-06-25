/**
 * TerrainLayer — stamps the terrain grid as a layer of PixiJS Sprites.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 *
 * For every cell it asks the PURE {@link selectTerrain} for the ordered frame keys
 * (base -> borders -> road -> forest), resolves each to a Texture via the
 * {@link AssetStore}, and places a Sprite at the cell's iso world position.
 *
 * NOTE: an earlier version used `@pixi/tilemap`'s CompositeTilemap, but its render
 * pipe did not draw under this Pixi v8 setup (tiles had geometry/bounds but never
 * rasterised). Plain Sprites render reliably; a 72×72 map is ~5k base sprites which
 * Pixi batches comfortably. Tilemap batching can be revisited as a perf pass.
 *
 * Iso placement: a tile texture's TOP-LEFT is offset so the 192px-wide diamond is
 * centered on the cell's world center (from {@link cellToWorld}); tall tiles extend
 * upward from the diamond's vertical mid-line.
 */
import { Container, Sprite, type Texture } from "pixi.js";
import type { TerrainGrid } from "@d2/map-schema";
import type { TerrainIndex } from "@d2/asset-manifest";
import { cellToWorld, TILE_W } from "./iso.js";
import { selectTerrain, type TerrainStamp } from "./terrainSelect.js";
import type { AssetStore } from "./AssetStore.js";

export class TerrainLayer {
  /** The display object to add to the world container. */
  readonly view: Container;

  constructor() {
    this.view = new Container();
    this.view.label = "terrain";
    // terrain is opaque & static; let Pixi cull offscreen sprites
    this.view.cullable = true;
  }

  /** Rebuild the whole terrain from a grid. */
  build(
    grid: TerrainGrid,
    terrain: TerrainIndex | undefined,
    assets: AssetStore,
  ): void {
    this.view.removeChildren().forEach((c) => c.destroy());
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
    const ox = center.x - TILE_W / 2;

    const place = (tex: Texture | undefined): void => {
      if (!tex || tex === undefined || tex.label === "EMPTY") return;
      const sprite = new Sprite(tex);
      // bottom of the tile sits on the diamond mid-line; sprite anchor is top-left.
      sprite.position.set(ox, center.y - tex.orig.height + TILE_W / 4);
      this.view.addChild(sprite);
    };

    place(this.tex(assets, stamp.base));
    for (const b of stamp.borders) place(this.tex(assets, b));
    place(this.tex(assets, stamp.road));
    place(this.tex(assets, stamp.forest));
  }

  private tex(assets: AssetStore, key: string | undefined): Texture | undefined {
    if (!key) return undefined;
    if (!assets.hasTexture(key)) return undefined;
    return assets.resolveTexture(key);
  }

  /** Show/hide the whole terrain layer. */
  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
