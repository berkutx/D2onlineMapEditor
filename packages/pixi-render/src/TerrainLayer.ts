/**
 * TerrainLayer — stamps the terrain grid into a `@pixi/tilemap` CompositeTilemap.
 *
 * Touches `pixi.js` + `@pixi/tilemap` -> COMPILE-ONLY under vitest.
 *
 * For every cell it asks the PURE {@link selectTerrain} for the ordered frame keys
 * (base -> borders -> road -> forest), resolves each to a Texture via the
 * {@link AssetStore}, and stamps them at the cell's iso world position. The
 * CompositeTilemap batches everything into a handful of draw calls, which is what
 * makes a 72×72 map cheap.
 *
 * Iso placement: a tile texture's TOP-LEFT is offset so the 192px-wide diamond is
 * centered on the cell's world center (from {@link cellToWorld}).
 */
import { Container, type Texture } from "pixi.js";
import { CompositeTilemap } from "@pixi/tilemap";
import type { TerrainGrid } from "@d2/map-schema";
import type { TerrainIndex } from "@d2/asset-manifest";
import { cellToWorld, TILE_W } from "./iso.js";
import { selectTerrain, type TerrainStamp } from "./terrainSelect.js";
import type { AssetStore } from "./AssetStore.js";

export class TerrainLayer {
  /** The display object to add to the world container. */
  readonly view: Container;
  private readonly tilemap: CompositeTilemap;

  constructor() {
    this.view = new Container();
    this.view.label = "terrain";
    this.tilemap = new CompositeTilemap();
    this.view.addChild(this.tilemap);
  }

  /**
   * Rebuild the whole tilemap from a grid. Cheap enough to call on full reloads;
   * for camera panning the CompositeTilemap itself is GPU-culled by Pixi so we
   * stamp the entire map once.
   */
  build(
    grid: TerrainGrid,
    terrain: TerrainIndex | undefined,
    assets: AssetStore,
  ): void {
    this.tilemap.clear();
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
    // The CompositeTilemap.tile origin is the texture's top-left. Center the
    // 192px-wide diamond horizontally; vertical anchor uses the texture height
    // at draw time (tilemap reads texture.orig), so we offset by half tile width
    // and let tall tiles extend upward from the diamond's vertical mid-line.
    const ox = center.x - TILE_W / 2;

    const place = (tex: Texture | undefined): void => {
      if (!tex || tex.label === "EMPTY") return;
      // Anchor each tile so its bottom sits on the diamond center line; tilemap
      // draws from the top-left, so subtract the texture's height.
      const oy = center.y - tex.orig.height + TILE_W / 4;
      this.tilemap.tile(tex, ox, oy);
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
    this.tilemap.destroy();
    this.view.destroy({ children: true });
  }
}
