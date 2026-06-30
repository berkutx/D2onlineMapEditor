/**
 * @d2/pixi-render — framework-agnostic PixiJS-8 isometric renderer for D2 maps.
 *
 * Public surface:
 *   - {@link Scene}        : the orchestrator a host (Vue/React/vanilla) drives.
 *   - {@link AssetStore}   : loads manifest spritesheets -> textures/animations.
 *   - {@link Camera}       : pan/zoom/clamp + throttled snapshots.
 *   - PURE helpers (`iso`, `terrainSelect`, `zorder`, `Culler`) re-exported for
 *     hosts that need the same math (minimap, hit-testing) without a renderer.
 */
export const PIXI_RENDER_VERSION = "0.1.0" as const;

// --- orchestration / pixi-touching ---
export { Scene } from "./Scene.js";
export type {
  LayerName,
  SceneInitOptions,
  SceneEventHandlers,
  ObjectData,
  DebugStats,
} from "./Scene.js";

export { AssetStore } from "./AssetStore.js";
export type { AssetStoreOptions } from "./AssetStore.js";

export { TerrainTilemapLayer } from "./TerrainTilemapLayer.js";
// legacy pre-composited-PNG terrain (kept for reference; renderer uses the tilemap)
export { TerrainLayer } from "./TerrainLayer.js";
export type { TerrainMeta } from "./TerrainLayer.js";
export { ObjectLayer } from "./ObjectLayer.js";
export { LocationLayer } from "./LocationLayer.js";
export { PresenceLayer, type PeerMarker } from "./PresenceLayer.js";
export { OverlayLayer } from "./OverlayLayer.js";
export type { OverlayTint, CellRef } from "./OverlayLayer.js";
export { objectSprites, objectFootprint, objectZBase } from "./objectSprite.js";
export type { LandmarkFootprints, SubSprite, SpriteKeyContext } from "./objectSprite.js";
export { AnimationManager, D2_FRAME_MS, D2_ANIMATION_SPEED } from "./AnimationManager.js";
export type { AnimationManagerOptions } from "./AnimationManager.js";

export { Camera } from "./Camera.js";
export type { CameraSnapshot, CameraOptions } from "./Camera.js";

// --- PURE math/logic (no pixi; safe in any environment) ---
export {
  TILE_W,
  HALF_W,
  HALF_H,
  isoX,
  isoY,
  cellToWorld,
  worldToCell,
  mapWorldBounds,
} from "./iso.js";
export type { WorldPoint, WorldBounds } from "./iso.js";

export {
  cellAt,
  variantSeed,
  selectTerrain,
  selectAllTerrain,
} from "./terrainSelect.js";
export type { Edge, TerrainStamp } from "./terrainSelect.js";

export {
  BANDS,
  typeRank,
  frontCell,
  zKey,
  compareZ,
  sortByZ,
} from "./zorder.js";

export {
  visibleCellRect,
  rectContains,
  objectInRect,
  visibleObjects,
} from "./Culler.js";
export type { ViewportWorld, CellRect } from "./Culler.js";
