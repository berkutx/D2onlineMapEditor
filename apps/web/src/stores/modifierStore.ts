/**
 * modifierStore — loads the offline-built unit-modifier catalog
 * (public/assets/modifierCatalog.json, from Gmodif/GmodifL/LmodifE/Tglobal) for the
 * per-unit modifier editors (stack/garrison units + template cells). Each entry:
 * { id (global G###UM#### Gmodif ref), name (CP866-decoded RU), source (LModifS enum),
 *   class (coarse effect class), dialog (native ScenEdit dialog set), effects?, comment?,
 *   scripted? }. RU class labels live here so the catalog stays pure game-sourced data.
 */
import { defineStore } from "pinia";
import { assetUrl } from "../services/api";
import { ref, computed } from "vue";

export interface ModifierEntry {
  id: string;
  name: string;
  source: number;
  sourceKey: string;
  class: string;
  dialog: boolean;
  effects?: string[];
  comment?: string;
  scripted?: boolean;
}

export interface ModifierGroup {
  key: string;
  label: string;
  mods: ModifierEntry[];
}

/** RU labels + display order for the coarse effect classes. */
export const MODIFIER_CLASS_LABELS: Record<string, string> = {
  hp: "Здоровье",
  armor: "Броня",
  accuracy: "Точность",
  damage: "Урон",
  initiative: "Инициатива",
  ward: "Защиты (снимаются ударом)",
  immunity: "Иммунитеты",
  regen: "Регенерация",
  drain: "Вытягивание жизни",
  leader: "Навыки лидера",
  leadership: "Лидерство",
  move: "Передвижение",
  scout: "Обзор",
  misc: "Прочее",
};
const CLASS_ORDER = Object.keys(MODIFIER_CLASS_LABELS);

export const useModifierStore = defineStore("modifier", () => {
  const catalog = ref<Record<string, ModifierEntry>>({});
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    if (loaded.value || loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch(assetUrl("modifierCatalog.json"));
      if (!res.ok) throw new Error(`modifierCatalog.json ${res.status}`);
      const arr = (await res.json()) as ModifierEntry[];
      const map: Record<string, ModifierEntry> = {};
      for (const e of arr) map[e.id] = e;
      catalog.value = map;
      loaded.value = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  const all = computed<ModifierEntry[]>(() => Object.values(catalog.value));

  function get(id: string | null | undefined): ModifierEntry | undefined {
    return id ? catalog.value[id.toUpperCase()] : undefined;
  }

  /** Display name for a Gmodif id, falling back to the raw id (mod DBs may add ids). */
  function nameOf(id: string | null | undefined): string {
    if (!id) return "";
    return get(id)?.name || id;
  }

  /** Modifiers grouped by effect class (fixed RU order), the ScenEdit dialog set pinned
   *  as the first group — it's what the native editor offers, so map authors know it. */
  const groups = computed<ModifierGroup[]>(() => {
    const dialog = all.value.filter((e) => e.dialog);
    const byClass = new Map<string, ModifierEntry[]>();
    for (const e of all.value) {
      if (e.dialog) continue;
      if (!byClass.has(e.class)) byClass.set(e.class, []);
      byClass.get(e.class)!.push(e);
    }
    const out: ModifierGroup[] = [];
    if (dialog.length) {
      dialog.sort((a, b) => a.id.localeCompare(b.id));
      out.push({ key: "dialog", label: "Набор редактора игры", mods: dialog });
    }
    for (const c of CLASS_ORDER) {
      const mods = byClass.get(c);
      if (!mods) continue;
      mods.sort((a, b) => a.name.localeCompare(b.name, "ru"));
      out.push({ key: c, label: MODIFIER_CLASS_LABELS[c] ?? c, mods });
    }
    return out;
  });

  return { catalog, loaded, loading, error, load, all, get, nameOf, groups };
});
