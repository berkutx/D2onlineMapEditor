/**
 * lordStore — loads the offline-built lord catalog (public/assets/lordCatalog.json, from Glord.dbf)
 * for the player-editor lord picker + the add-faction dialog. A MidPlayer's LORD_ID references one
 * of the 18 rows (6 races × 3 archetypes: mage / warrior / diplomat); the game keys the lord bonuses
 * off the referenced row, so a player's lord is a pick over its race's three lords.
 */
import { defineStore } from "pinia";
import { assetUrl } from "../services/api";
import { ref, computed } from "vue";

export interface LordEntry {
  id: string; // LORD_ID (G000LR####)
  race: string; // RACE_ID (G000RR####)
  raceName: string;
  raceType: number;
  category: number; // 0 mage / 1 warrior / 2 diplomat
  categoryKey: string;
  categoryName: string;
  name: string;
  desc?: string;
}

export const useLordStore = defineStore("lord", () => {
  const catalog = ref<Record<string, LordEntry>>({});
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    if (loaded.value || loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch(assetUrl("lordCatalog.json"));
      if (!res.ok) throw new Error(`lordCatalog.json ${res.status}`);
      const arr = (await res.json()) as LordEntry[];
      const map: Record<string, LordEntry> = {};
      for (const e of arr) map[e.id] = e;
      catalog.value = map;
      loaded.value = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  const all = computed<LordEntry[]>(() => Object.values(catalog.value));

  function get(id: string | null | undefined): LordEntry | undefined {
    return id ? catalog.value[id] : undefined;
  }
  function nameOf(id: string | null | undefined): string {
    return (id && catalog.value[id]?.name) || id || "";
  }
  /** The three lords (mage/warrior/diplomat) of a race, by RACE_ID — the picker options for a player. */
  function byRace(raceId: string | null | undefined): LordEntry[] {
    if (!raceId) return [];
    return all.value.filter((l) => l.race === raceId).sort((a, b) => a.category - b.category);
  }

  return { catalog, loaded, loading, error, load, all, get, nameOf, byRace };
});
