/**
 * Map state: the discoverable scenario list and the currently-open MapDocument
 * (Contract A). The document is held in a `shallowRef` — it is a large, deeply
 * nested but immutable-per-load JSON blob, so deep reactivity would be wasteful
 * and pointless (the renderer, not Vue, consumes its interior).
 *
 * Orchestrates the "Open map" flow:
 *   ensure assets loaded -> fetch MapDocument -> hand both to the canvas host.
 * The actual `scene.buildScene` call lives in the canvas host, which watches
 * `currentMap` and reacts imperatively (keeping Pixi out of reactivity).
 */
import { defineStore } from "pinia";
import { ref, shallowRef, computed } from "vue";
import type { MapDocument } from "@d2/map-schema";
import type { ScenarioEntry } from "@d2/socket-contract";
import { fetchScenarios, fetchMapDocument } from "../services/api";
import { useAssetStore } from "./assetStore";

export type MapLoadStatus = "idle" | "loading" | "ready" | "error";

export const useMapStore = defineStore("map", () => {
  const scenarios = ref<ScenarioEntry[]>([]);
  const currentScenarioId = ref<string | null>(null);
  const currentMap = shallowRef<MapDocument | null>(null);

  const status = ref<MapLoadStatus>("idle");
  const error = ref<string | null>(null);

  const mapName = computed(
    () => currentMap.value?.header.name || currentMap.value?.header.description || "",
  );
  const mapSize = computed(() => currentMap.value?.size ?? 0);

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
    status.value = "loading";
    error.value = null;
    try {
      await assets.ensureLoaded();
      const doc = await fetchMapDocument(id);
      currentScenarioId.value = id;
      currentMap.value = doc;
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
    status,
    error,
    mapName,
    mapSize,
    objectCounts,
    totalObjects,
    loadScenarios,
    openMap,
    pickDefaultScenario,
  };
});
