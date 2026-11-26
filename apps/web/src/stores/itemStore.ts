/**
 * itemStore — loads the offline-built item catalog (public/assets/itemCatalog.json) and
 * exposes it for the object inspector's pickers (ruin artifact + chest item list). Each
 * entry is { id (global G###IG#### template), name (CP866-decoded RU), cat, catKey
 * (L_ARMOR/...), gold, image, desc? }. The RU category labels live here (not in the
 * catalog) so the catalog stays pure game-sourced data.
 */
import { defineStore } from "pinia";
import { modAssetUrl } from "./modStore";
import { ref, computed } from "vue";
import { tr, trx } from "../i18n";

export interface ItemEntry {
  id: string;
  name: string;
  cat: number;
  catKey: string;
  gold: number;
  image: string;
  desc?: string;
  bonus?: string[]; // coarse effect tags (armor/attack/heal/spell/summon/…) for grouping
  effect?: string; // short "what it does" string derived from the modifier/spell tables
}

export interface ItemCatGroup {
  cat: number;
  catKey: string;
  label: string;
  items: ItemEntry[];
}

/** A generic picker group (category OR bonus OR cost bucket). */
export interface ItemGroup {
  key: string;
  label: string;
  items: ItemEntry[];
}

/** RU labels for the derived bonus tags. */
export const ITEM_BONUS_LABELS: Record<string, string> = {
  attack: tr("Атака / урон"),
  armor: tr("Броня"),
  hp: tr("Здоровье"),
  heal: tr("Лечение"),
  regen: tr("Регенерация"),
  immunity: tr("Иммунитет"),
  initiative: tr("Инициатива"),
  spell: tr("Заклинание"),
  summon: tr("Призыв"),
  move: tr("Ход"),
  scout: trx("stat", "Обзор"),
  leadership: tr("Лидерство"),
  morale: tr("Мораль"),
  ability: tr("Способности"),
  drain: tr("Вытягивание жизни"),
  retreat: tr("Отступление"),
  cost: tr("Стоимость"),
};
const BONUS_ORDER = Object.keys(ITEM_BONUS_LABELS);

/** RU labels for the authoritative LmagItm.dbf category enum. */
export const ITEM_CAT_LABELS: Record<string, string> = {
  L_ARMOR: tr("Доспехи"),
  L_JEWEL: tr("Реликвии"),
  L_WEAPON: tr("Оружие"),
  L_BANNER: tr("Знамёна"),
  L_POTION_BOOST: tr("Зелья усиления"),
  L_POTION_HEAL: tr("Зелья лечения"),
  L_POTION_REVIVE: tr("Зелья воскрешения"),
  L_POTION_PERMANENT: tr("Постоянные зелья"),
  L_SCROLL: tr("Свитки"),
  L_WAND: tr("Жезлы"),
  L_VALUABLE: tr("Ценности"),
  L_ORB: tr("Сферы маны"),
  L_TALISMAN: tr("Талисманы"),
  L_TRAVEL_ITEM: tr("Дорожные предметы"),
  L_SPECIAL: tr("Особые предметы"),
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
      const res = await fetch(await modAssetUrl("itemCatalog.json"));
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
      out.push({ cat, catKey, label: ITEM_CAT_LABELS[catKey] ?? tr("Категория {id}", { id: cat }), items });
    }
    return out;
  });

  /** Items grouped by bonus tag (multi-membership: an item appears under every bonus it has);
   *  items with no bonus fall into a trailing "Без бонуса" group. */
  const bonusGroups = computed<ItemGroup[]>(() => {
    const by = new Map<string, ItemEntry[]>();
    const none: ItemEntry[] = [];
    for (const e of all.value) {
      if (e.bonus?.length) {
        for (const b of e.bonus) {
          if (!by.has(b)) by.set(b, []);
          by.get(b)!.push(e);
        }
      } else {
        none.push(e);
      }
    }
    const out: ItemGroup[] = [];
    for (const b of BONUS_ORDER) {
      const items = by.get(b);
      if (items) {
        items.sort((a, c) => a.name.localeCompare(c.name, "ru"));
        out.push({ key: b, label: ITEM_BONUS_LABELS[b] ?? b, items });
      }
    }
    if (none.length) {
      none.sort((a, c) => a.name.localeCompare(c.name, "ru"));
      out.push({ key: "none", label: tr("Без бонуса"), items: none });
    }
    return out;
  });

  return { catalog, loaded, loading, error, load, all, get, nameOf, groups, bonusGroups };
});
