/**
 * Map state: the discoverable scenario list and the currently-open MapDocument
 * (Contract A). The document is held in a `shallowRef` — it is a large, deeply
 * nested but immutable-per-load JSON blob, so deep reactivity would be wasteful
 * and pointless (the renderer, not Vue, consumes its interior).
 *
 * Orchestrates the "Open map" flow:
 *   fetch MapMeta -> activate the map's mod -> ensure assets loaded -> fetch MapDocument
 *   -> hand both to the canvas host.
 * The actual `scene.buildScene` call lives in the canvas host, which watches
 * `currentMap` and reacts imperatively (keeping Pixi out of reactivity).
 */
import { defineStore } from "pinia";
import { ref, shallowRef, computed } from "vue";
import type { MapDocument } from "@d2/map-schema";
import type { MapMeta, ScenarioEntry } from "@d2/socket-contract";
import { fetchScenarios, fetchMapDocument, fetchMapMeta } from "../services/api";
import { useAssetStore } from "./assetStore";
import { useModStore } from "./modStore";

export type MapLoadStatus = "idle" | "loading" | "ready" | "error";

/** Start a fresh page session on a map (`?map=<id>`), dropping link-only parameters. */
export function reloadOnMap(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("map", id);
  url.searchParams.delete("room");
  url.searchParams.delete("obj");
  window.location.assign(url.toString());
}

export const useMapStore = defineStore("map", () => {
  const scenarios = ref<ScenarioEntry[]>([]);
  const currentScenarioId = ref<string | null>(null);
  const currentMap = shallowRef<MapDocument | null>(null);
  const currentMeta = ref<MapMeta | null>(null);

  const status = ref<MapLoadStatus>("idle");
  const error = ref<string | null>(null);

  const mapName = computed(
    () => currentMap.value?.header.name || currentMap.value?.header.description || "",
  );
  const mapSize = computed(() => currentMap.value?.size ?? 0);
  const readOnly = computed(() => currentMeta.value?.readOnly === true);
  const previewExpiresAt = computed(() => currentMeta.value?.expiresAt ?? null);
  /** The mod the open map belongs to and how well it fits (absent on servers without mods). */
  const currentMod = computed(() => currentMeta.value?.mod ?? null);
  /** This browser owns the open map and may re-assign its mod. */
  const modEditable = computed(() => currentMeta.value?.modEditable === true);

  /** Object counts grouped by the discriminated-union `type` (for the left panel). */
  const objectCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    const doc = currentMap.value;
    if (!doc) return counts;
    for (const obj of doc.objects) {
      counts[obj.type] = (counts[obj.type] ?? 0) + 1;
    }
    return counts;
  });

  const totalObjects = computed(() => currentMap.value?.objects.length ?? 0);

  /** Load (or refresh) the scenario listing. */
  async function loadScenarios(): Promise<ScenarioEntry[]> {
    const list = await fetchScenarios();
    scenarios.value = list;
    return list;
  }

  /**
   * Open a scenario by id: make sure assets are ready, fetch its MapDocument,
   * and store it. Returns the document so the caller (App startup or the menu)
   * can sequence the build.
   */
  async function openMap(id: string): Promise<MapDocument> {
    const assets = useAssetStore();
    const mods = useModStore();
    status.value = "loading";
    error.value = null;
    try {
      // Meta FIRST: it names the mod the map belongs to, and nothing mod-specific (atlases,
      // catalogs) may load before that is known. It also carries the server-authoritative
      // preview policy, so a query-string flag can never turn an ordinary map read-only (or
      // a preview editable).
      const [meta, modList] = await Promise.all([fetchMapMeta(id), mods.loadMods()]);
      // a server that predates mods sends no meta.mod: its one implicit mod is the default
      const modId = meta.mod?.id ?? modList.defaultModId;
      if (!mods.activate(modId)) {
        if (mods.activeModId === null) throw new Error(`Сервер не знает мод «${modId}» этой карты`);
        // Another mod's catalogs and textures are loaded in this page session, and they load
        // once and never unload. Open the map in a FRESH session instead of mixing two data
        // sets: the editor's state is persisted continuously, so a reload loses nothing.
        reloadOnMap(id);
        return await new Promise<MapDocument>(() => {}); // the page is navigating away
      }
      await assets.ensureLoaded();
      const doc = await fetchMapDocument(id);
      currentScenarioId.value = id;
      currentMap.value = doc;
      currentMeta.value = meta;
      status.value = "ready";
      return doc;
    } catch (e) {
      status.value = "error";
      error.value = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  /** Pick the scenario to auto-load on startup: prefer "Riders", else the first. */
  function pickDefaultScenario(list: ScenarioEntry[]): ScenarioEntry | undefined {
    const riders = list.find((s) =>
      `${s.name} ${s.fileName}`.toLowerCase().includes("riders"),
    );
    return riders ?? list[0];
  }

  return {
    scenarios,
    currentScenarioId,
    currentMap,
    currentMeta,
    status,
    error,
    mapName,
    mapSize,
    readOnly,
    previewExpiresAt,
    currentMod,
    modEditable,
    objectCounts,
    totalObjects,
    loadScenarios,
    openMap,
    pickDefaultScenario,
  };
});
