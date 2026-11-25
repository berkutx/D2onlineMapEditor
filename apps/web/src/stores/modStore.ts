/**
 * The mods the server serves, and the session's ACTIVE mod — the game data set (catalogs,
 * sprites, scripts) every asset URL and catalog load resolves against.
 *
 * The mod is a property of the map being opened, so it is only known once the map's meta
 * has arrived. Everything that fetches mod data therefore awaits {@link whenReady} first
 * instead of fetching at module/setup time — otherwise a catalog could be fetched (and
 * latched as "loaded") for the wrong data set before the map says which one it needs.
 *
 * One mod per page session: the catalog stores and the Pixi AssetStore load once and never
 * unload, so a different mod is never swapped in underneath them. {@link activate} reports
 * a mismatch instead; the caller then starts a fresh session for that map (a page reload —
 * see mapStore.openMap).
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { ModInfo, ModList } from "@d2/socket-contract";
import { ModProfile, ScenVariableCatalog, raceCategories, raceFacts, type RaceFacts } from "@d2/mod-catalog";
import {
  DEFAULT_MOD_ID,
  activeAssetsAreFlat,
  assetUrl,
  fetchMods,
  setActiveAssetMod,
} from "../services/api";

export { DEFAULT_MOD_ID };

/**
 * URL of a file of the session's mod, resolved only once that mod is known. The loaders of
 * mod data (catalogs, the atlas manifest) use this instead of the synchronous `assetUrl`,
 * so a load kicked off at startup or in a component's setup waits for the map's mod.
 *
 * `flatBust` is a cache-busting version for the flat pre-multi-mod layout only, whose file
 * names never change; a store mod's URLs already carry the mod's revision.
 */
export async function modAssetUrl(rel: string, flatBust?: string): Promise<string> {
  await useModStore().whenReady();
  const url = assetUrl(rel);
  return flatBust && activeAssetsAreFlat() ? `${url}?v=${flatBust}` : url;
}

export const useModStore = defineStore("mod", () => {
  /** Every mod the server serves (empty until loadMods resolves). */
  const mods = ref<ModInfo[]>([]);
  /** The mod the server uses when a map's own mod cannot be determined. */
  const defaultModId = ref<string>(DEFAULT_MOD_ID);
  /** The active mod id, or null until the first map's mod is known. */
  const activeModId = ref<string | null>(null);

  let listP: Promise<ModList> | null = null;
  let resolveReady!: (modId: string) => void;
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });

  /** Fetch the server's mod list (once per session; concurrent callers share the request). */
  function loadMods(): Promise<ModList> {
    if (!listP) {
      listP = fetchMods().then((list) => {
        mods.value = list.mods;
        defaultModId.value = list.defaultModId;
        return list;
      });
      // a failed fetch must not be remembered: the next map open tries again
      listP.catch(() => {
        listP = null;
      });
    }
    return listP;
  }

  const byId = (id: string | null | undefined): ModInfo | undefined =>
    id ? mods.value.find((m) => m.id === id) : undefined;

  /** Display name of a mod (its id when the mod is unknown to this server). */
  const nameOf = (id: string | null | undefined): string => byId(id)?.name ?? id ?? "";

  const activeMod = computed<ModInfo | undefined>(() => byId(activeModId.value));
  /** Mods a map can be opened on (their graphics are built). */
  const openableMods = computed<ModInfo[]>(() => mods.value.filter((m) => m.status === "ready"));

  /**
   * Make `modId` the session's mod (the list must be loaded). Idempotent for the same id.
   * Returns false when a DIFFERENT mod is already active, or the mod is unknown — nothing is
   * changed in that case.
   */
  function activate(modId: string): boolean {
    if (activeModId.value === modId) return true;
    if (activeModId.value !== null) return false;
    const mod = byId(modId);
    if (!mod) return false;
    setActiveAssetMod(mod);
    activeModId.value = modId;
    resolveReady(modId);
    return true;
  }

  /** Resolves with the active mod id once a mod has been activated. */
  function whenReady(): Promise<string> {
    return ready;
  }

  /**
   * The active mod's own faction data (guardian, leader, lord, their base hit points per
   * race), by race key. Empty for a mod without a profile (the flat layout) — whoever builds
   * an operation then leaves the faction data out and the reference table applies.
   */
  const raceFactsByKey = shallowRef<Record<string, RaceFacts>>({});
  /**
   * Grace id -> race category for every race of the active mod (neutrals included); empty
   * without a profile. Diplomacy rows are keyed by category, players carry a Grace id.
   */
  const raceCategoryById = shallowRef<Record<string, number>>({});
  let profileP: Promise<Record<string, RaceFacts>> | null = null;

  /** Load the active mod's profile (once per session; waits for the mod to be known). */
  function loadProfile(): Promise<Record<string, RaceFacts>> {
    if (!profileP) {
      profileP = modAssetUrl("profile.json")
        .then((url) => fetch(url))
        .then(async (res) => {
          if (!res.ok) return {};
          const profile = ModProfile.parse(await res.json());
          raceCategoryById.value = raceCategories(profile);
          return raceFacts(profile);
        })
        .catch(() => ({}))
        .then((facts) => {
          raceFactsByKey.value = facts;
          return facts;
        });
    }
    return profileP;
  }

  /**
   * The scenario variables the active mod gives a meaning to (the map-restrictions panel),
   * or null when the mod has no such catalog (the flat layout) / until it has loaded.
   */
  const scenVariables = shallowRef<ScenVariableCatalog | null>(null);
  let scenVariablesP: Promise<ScenVariableCatalog | null> | null = null;

  /** Load the active mod's scenario-variable catalog (once per session). */
  function loadScenVariables(): Promise<ScenVariableCatalog | null> {
    if (!scenVariablesP) {
      scenVariablesP = modAssetUrl("scenVariables.json")
        .then((url) => fetch(url))
        .then(async (res) => (res.ok ? ScenVariableCatalog.parse(await res.json()) : null))
        .catch(() => null)
        .then((catalog) => {
          scenVariables.value = catalog;
          return catalog;
        });
    }
    return scenVariablesP;
  }

  return {
    mods, defaultModId, activeModId, activeMod, openableMods, raceFactsByKey, raceCategoryById, scenVariables,
    loadMods, loadProfile, loadScenVariables, nameOf, activate, whenReady,
  };
});
