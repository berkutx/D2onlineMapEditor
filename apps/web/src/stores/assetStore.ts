/**
 * Asset state: the AssetManifest (Contract B) plus the load status of the
 * underlying Pixi AssetStore. The manifest is plain JSON (safe to keep
 * reactive); the Pixi AssetStore itself lives in the non-reactive sceneHolder.
 *
 * The manifest + spritesheets are loaded once per session and reused across
 * every map.
 */
import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { AssetManifest } from "@d2/asset-manifest";
import { fetchAssetManifest } from "../services/api";
import { getAssetStore } from "../canvas/sceneHolder";

export type AssetLoadStatus = "idle" | "loading" | "ready" | "error";

export const useAssetStore = defineStore("assets", () => {
  // shallowRef: we never mutate the manifest's interior, only swap the whole
  // object, so a shallow ref avoids deep-proxying a large JSON blob.
  const manifest = shallowRef<AssetManifest | null>(null);
  const status = ref<AssetLoadStatus>("idle");
  const error = ref<string | null>(null);

  /**
   * Idempotent: fetch the manifest and parse every spritesheet into GPU
   * textures exactly once. Subsequent calls resolve immediately.
   */
  async function ensureLoaded(): Promise<AssetManifest> {
    if (status.value === "ready" && manifest.value) return manifest.value;

    status.value = "loading";
    error.value = null;
    try {
      const m = await fetchAssetManifest();
      await getAssetStore().load(m);
      manifest.value = m;
      status.value = "ready";
      return m;
    } catch (e) {
      status.value = "error";
      error.value = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  return { manifest, status, error, ensureLoaded };
});
