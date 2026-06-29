/**
 * itemStore — loads the offline-built item catalog (public/assets/itemCatalog.json) and
 * exposes it for the object inspector's pickers (ruin artifact + chest item list). Each
 * entry is { id (global G###IG#### template), name (CP866-decoded RU), cat, catKey
 * (L_ARMOR/...), gold, image, desc? }. The RU category labels live here (not in the
 * catalog) so the catalog stays pure game-sourced data.
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";

export interface ItemEntry {
  id: string;
  name: string;
  cat: number;
  catKey: string;
  gold: number;
  image: string;
  desc?: string;
}

export interface ItemCatGroup {
  cat: number;
  catKey: string;
  label: string;
  items: ItemEntry[];
}

/** RU labels for the authoritative LmagItm.dbf category enum. */
export const ITEM_CAT_LABELS: Record<string, string> = {
  L_ARMOR: "Доспехи",
  L_JEWEL: "Реликвии",
  L_WEAPON: "Оружие",
  L_BANNER: "Знамёна",
  L_POTION_BOOST: "Зелья усиления",
  L_POTION_HEAL: "Зелья лечения",
  L_POTION_REVIVE: "Зелья воскрешения",
  L_POTION_PERMANENT: "Постоянные зелья",
  L_SCROLL: "Свитки",
  L_WAND: "Жезлы",
  L_VALUABLE: "Ценности",
  L_ORB: "Сферы маны",
  L_TALISMAN: "Талисманы",
  L_TRAVEL_ITEM: "Дорожные предметы",
  L_SPECIAL: "Особые предметы",
};

const NULL_ID = "G000000000"; // sentinel "no item"

export const useItemStore = defineStore("item", () => {
  const catalog = ref<Record<string, ItemEntry>>({});
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    if (loaded.value || loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch("/assets/itemCatalog.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`itemCatalog.json ${res.status}`);
      const arr = (await res.json()) as ItemEntry[];
      const map: Record<string, ItemEntry> = {};
      for (const e of arr) map[e.id] = e;
      catalog.value = map;
      loaded.value = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  const all = computed<ItemEntry[]>(() => Object.values(catalog.value));

  /** Catalog entry for a global template id (or undefined). */
  function get(id: string | null | undefined): ItemEntry | undefined {
    return id ? catalog.value[id] : undefined;
  }

  /** Display name for a template id, falling back to the raw id. */
  function nameOf(id: string | null | undefined): string {
    if (!id || id === NULL_ID) return "";
    return catalog.value[id]?.name || id;
  }

  /** Items grouped by category (ascending cat number), only non-empty categories. */
  const groups = computed<ItemCatGroup[]>(() => {
    const byCat = new Map<number, ItemEntry[]>();
    for (const e of all.value) {
      if (!byCat.has(e.cat)) byCat.set(e.cat, []);
      byCat.get(e.cat)!.push(e);
    }
    const out: ItemCatGroup[] = [];
    for (const cat of [...byCat.keys()].sort((a, b) => a - b)) {
      const items = byCat.get(cat)!;
      items.sort((a, b) => a.name.localeCompare(b.name, "ru"));
      const catKey = items[0]?.catKey ?? "";
      out.push({ cat, catKey, label: ITEM_CAT_LABELS[catKey] ?? `Категория ${cat}`, items });
    }
    return out;
  });

  return { catalog, loaded, loading, error, load, all, get, nameOf, groups };
});
