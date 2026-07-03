/**
 * spellStore — loads the offline-built spell catalog (public/assets/spellCatalog.json) and
 * exposes it for the mage-shop spell-list picker. Each entry is a GLOBAL Gspell template
 * { id (G###SS####), name, level, cat (Lspell enum), catKey, damage?, heal?, area?,
 * summon?, desc? }. RU labels for the spell-category enum live here.
 */
import { defineStore } from "pinia";
import { assetUrl } from "../services/api";
import { ref, computed } from "vue";

export interface SpellEntry {
  id: string;
  name: string;
  level: number;
  cat: number;
  catKey: string;
  damage?: number;
  heal?: number;
  area?: number;
  summon?: string;
  desc?: string;
}

export interface SpellGroup {
  key: string;
  label: string;
  spells: SpellEntry[];
}

/** RU labels for the authoritative Lspell spell-category enum. */
export const SPELL_CAT_LABELS: Record<string, string> = {
  L_ATTACK: "Атакующие",
  L_BOOST: "Усиление",
  L_LOWER: "Ослабление",
  L_HEAL: "Лечение",
  L_SUMMON: "Призыв",
  L_FOG: "Затемнение",
  L_UNFOG: "Развеять туман",
  L_CHANGE_TERRAIN: "Изменение земли",
  L_RESTORE_MOVE: "Восстановление хода",
  L_INVISIBILITY: "Невидимость",
  L_REMOVE_ROD: "Снятие жезла",
};

const NULL_ID = "G000000000"; // sentinel "no spell"

export const useSpellStore = defineStore("spell", () => {
  const catalog = ref<Record<string, SpellEntry>>({});
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    if (loaded.value || loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch(assetUrl("spellCatalog.json"));
      if (!res.ok) throw new Error(`spellCatalog.json ${res.status}`);
      const arr = (await res.json()) as SpellEntry[];
      const map: Record<string, SpellEntry> = {};
      for (const e of arr) map[e.id] = e;
      catalog.value = map;
      loaded.value = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  const all = computed<SpellEntry[]>(() => Object.values(catalog.value));

  function get(id: string | null | undefined): SpellEntry | undefined {
    return id ? catalog.value[id] : undefined;
  }
  function nameOf(id: string | null | undefined): string {
    if (!id || id === NULL_ID) return "";
    return catalog.value[id]?.name || id;
  }

  /** A short, scannable "what it does" line synthesized from the catalog fields (school +
   *  damage/heal/summon magnitudes), for picker/shop rows. The full game `desc` stays as the
   *  hover tooltip. */
  function effectOf(id: string | null | undefined): string {
    const s = get(id);
    if (!s) return "";
    const school = SPELL_CAT_LABELS[s.catKey] ?? "";
    const bits: string[] = []; // magnitudes only — the school already names the kind of effect
    if (s.damage) bits.push(`${s.damage} урона`);
    if (s.heal) bits.push(`${s.heal} HP`);
    return bits.length ? `${school} · ${bits.join(", ")}` : school;
  }

  /** Spells grouped by category (Lspell). */
  const byCat = computed<SpellGroup[]>(() => {
    const by = new Map<number, SpellEntry[]>();
    for (const e of all.value) {
      if (!by.has(e.cat)) by.set(e.cat, []);
      by.get(e.cat)!.push(e);
    }
    const out: SpellGroup[] = [];
    for (const cat of [...by.keys()].sort((a, b) => a - b)) {
      const spells = by.get(cat)!;
      spells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, "ru"));
      const catKey = spells[0]?.catKey ?? "";
      out.push({ key: catKey || String(cat), label: SPELL_CAT_LABELS[catKey] ?? `Категория ${cat}`, spells });
    }
    return out;
  });

  /** Spells grouped by level 1..5. */
  const byLevel = computed<SpellGroup[]>(() => {
    const by = new Map<number, SpellEntry[]>();
    for (const e of all.value) {
      if (!by.has(e.level)) by.set(e.level, []);
      by.get(e.level)!.push(e);
    }
    const out: SpellGroup[] = [];
    for (const lvl of [...by.keys()].sort((a, b) => a - b)) {
      const spells = by.get(lvl)!;
      spells.sort((a, b) => a.name.localeCompare(b.name, "ru"));
      out.push({ key: `l${lvl}`, label: `Уровень ${lvl}`, spells });
    }
    return out;
  });

  return { catalog, loaded, loading, error, load, all, get, nameOf, effectOf, byCat, byLevel };
});
