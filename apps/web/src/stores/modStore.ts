/**
 * The session's active MOD — the game data set (catalogs, sprites, scripts) every asset
 * URL and catalog load resolves against.
 *
 * The mod is a property of the map being opened, so it is only known once the map's meta
 * has arrived. Everything that fetches mod data therefore awaits {@link whenReady} first
 * instead of fetching at module/setup time — otherwise a catalog could be fetched (and
 * latched as "loaded") for the wrong data set before the map says which one it needs.
 *
 * One mod per page session: the catalog stores and the Pixi AssetStore load once and never
 * unload, so a different mod is never swapped in underneath them. {@link activate} reports
 * a mismatch instead; the caller then has to start a fresh session for that map.
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { DEFAULT_MOD_ID, assetUrl, setActiveAssetMod } from "../services/api";

export { DEFAULT_MOD_ID };

/**
 * URL of a file of the session's mod, resolved only once that mod is known. The loaders of
 * mod data (catalogs, the atlas manifest) use this instead of the synchronous `assetUrl`,
 * so a load kicked off at startup or in a component's setup waits for the map's mod.
 */
export async function modAssetUrl(rel: string): Promise<string> {
  await useModStore().whenReady();
  return assetUrl(rel);
}

export const useModStore = defineStore("mod", () => {
  /** The active mod id, or null until the first map's mod is known. */
  const activeModId = ref<string | null>(null);

  let resolveReady!: (modId: string) => void;
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });

  /**
   * Make `modId` the session's mod. Idempotent for the same id. Returns false when a
   * DIFFERENT mod is already active — nothing is changed in that case.
   */
  function activate(modId: string): boolean {
    if (activeModId.value === modId) return true;
    if (activeModId.value !== null) return false;
    setActiveAssetMod(modId);
    activeModId.value = modId;
    resolveReady(modId);
    return true;
  }

  /** Resolves with the active mod id once a mod has been activated. */
  function whenReady(): Promise<string> {
    return ready;
  }

  return { activeModId, activate, whenReady };
});
