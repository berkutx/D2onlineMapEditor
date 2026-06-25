/**
 * Non-reactive holder for the PixiJS objects.
 *
 * PixiJS owns the canvas and its scene graph. Those objects (the `Scene`, the
 * `AssetStore`, their thousands of internal Containers/Textures) must NEVER be
 * wrapped in Vue reactivity — proxying them would be catastrophic for
 * performance and would break Pixi's identity checks. We keep them in this
 * plain module singleton, which Vue never sees. Stores hold only serialisable
 * state (ids, flags, plain documents); components reach into this holder
 * imperatively to drive the renderer.
 */
import { Scene, AssetStore } from "@d2/pixi-render";
import { ASSET_BASE_URL } from "../services/api";

interface Holder {
  scene: Scene | null;
  assets: AssetStore | null;
}

const holder: Holder = { scene: null, assets: null };

/** Get (lazily creating) the singleton AssetStore. Loaded once per session. */
export function getAssetStore(): AssetStore {
  if (!holder.assets) {
    holder.assets = new AssetStore({ baseUrl: ASSET_BASE_URL });
  }
  return holder.assets;
}

/** The current Scene, if a canvas host has initialised one. */
export function getScene(): Scene | null {
  return holder.scene;
}

/** Register the Scene created by the canvas host (called from onMounted). */
export function setScene(scene: Scene | null): void {
  holder.scene = scene;
}

/** Tear down and forget the Scene (called from onBeforeUnmount). */
export function destroyScene(): void {
  if (holder.scene) {
    holder.scene.destroy();
    holder.scene = null;
  }
}
