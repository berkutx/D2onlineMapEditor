/**
 * decorStore — loads the offline-built decoration catalog (public/assets/decorCatalog.json)
 * and exposes it for the decoration palette + (later) the copilot agent. Each entry carries
 * the classification (shape / tone-biome / D2-faction style / iso orient+slope / footprint)
 * and a `thumb` rect so the palette can crop a thumbnail straight from the atlas pages.
 */
import { defineStore } from "pinia";
import { assetUrl } from "../services/api";
import { ref, computed } from "vue";

export interface DecorThumb {
  page: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DecorEntry {
  id: string;
  name_ru: string;
  cx: number;
  cy: number;
  isMountain: boolean;
  shape: string;
  tone: string;
  style: string;
  size: string;
  iso: { orient: string; slope: string };
  conf: string;
  desc_en: string;
  desc_ru: string;
  tags: string[];
  thumb: DecorThumb;
}

/** One palette card: a named set of interchangeable variants (looks) of the same thing. */
export interface DecorGroup {
  key: string;
  label: string;
  family: string;
  shape: string;
  cx: number;
  cy: number;
  styles: Set<string>;
  tones: Set<string>;
  variants: DecorEntry[];
  rep: DecorEntry;
}

/** Top-level palette families (a coarse, browseable grouping over the 28 shapes). */
export const DECOR_FAMILIES: { key: string; label: string; shapes: string[] }[] = [
  {
    key: "terrain",
    label: "Рельеф",
    shapes: ["mountain", "hill", "cliff", "waterfall", "rock", "boulder", "crater",
             "ground-patch", "lava-flow", "swamp", "water-feature", "ice"],
  },
  {
    key: "nature",
    label: "Природа",
    shapes: ["tree", "dead-tree", "vegetation", "stump", "bush", "mushroom"],
  },
  {
    key: "structures",
    label: "Постройки",
    shapes: ["ruin-building", "tower", "wall", "fence", "gate", "well", "bridge", "camp"],
  },
  {
    key: "shrines",
    label: "Камни и святыни",
    shapes: ["standing-stone", "obelisk", "statue", "totem", "magic-node", "crystal", "portal"],
  },
  {
    key: "graves",
    label: "Могилы и кости",
    shapes: ["grave", "bones", "skull"],
  },
  {
    key: "misc",
    label: "Прочее",
    shapes: ["debris", "misc"],
  },
];

/** D2 faction styles, for the palette filter (RU labels). */
export const DECOR_STYLES: { value: string; label: string }[] = [
  { value: "neutral", label: "Нейтрально" },
  { value: "empire", label: "Империя" },
  { value: "clans", label: "Кланы" },
  { value: "legions", label: "Легионы" },
  { value: "undead", label: "Нежить" },
  { value: "elves", label: "Эльфы" },
  { value: "arcane", label: "Магия" },
];

/** Biome/tone, for the palette filter (RU labels). */
export const DECOR_TONES: { value: string; label: string }[] = [
  { value: "snow", label: "Снег" },
  { value: "ice", label: "Лёд" },
  { value: "temperate", label: "Зелень" },
  { value: "forest", label: "Лес" },
  { value: "earth", label: "Земля" },
  { value: "arid", label: "Сушь" },
  { value: "swamp", label: "Болото" },
  { value: "volcanic", label: "Вулкан" },
  { value: "scorched", label: "Гарь" },
  { value: "dark", label: "Тьма" },
  { value: "magic", label: "Магия" },
  { value: "neutral", label: "Обычный" },
];

const SHAPE_TO_FAMILY: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const f of DECOR_FAMILIES) for (const s of f.shapes) m[s] = f.key;
  return m;
})();

export const useDecorStore = defineStore("decor", () => {
  const catalog = ref<Record<string, DecorEntry>>({});
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    if (loaded.value || loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch(assetUrl("decorCatalog.json"), { cache: "no-store" });
      if (!res.ok) throw new Error(`decorCatalog.json ${res.status}`);
      catalog.value = (await res.json()) as Record<string, DecorEntry>;
      loaded.value = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  const all = computed<DecorEntry[]>(() => Object.values(catalog.value));

  /** Which palette family a shape belongs to (falls back to "misc"). */
  function familyOf(shape: string): string {
    return SHAPE_TO_FAMILY[shape] ?? "misc";
  }

  function get(id: string | null | undefined): DecorEntry | undefined {
    return id ? catalog.value[id] : undefined;
  }

  /** Mountain footprint width parsed from a MOMNE id (chars 5–6). */
  const momneW = (id: string): number => parseInt(id.slice(5, 7), 10) || 1;

  /** A group key = one card in the palette: variants (looks) of the same thing.
   *  Landmarks group by shape+name+footprint; MOMNE mountains group by footprint size. */
  function groupKeyOf(e: DecorEntry): string {
    if (e.id.startsWith("MOMNE")) return `mtn:${momneW(e.id)}`;
    return `${e.shape}|${e.name_ru || e.desc_en}|${e.cx}x${e.cy}`;
  }

  /** A palette group: a named set of interchangeable variants (looks). */
  const groups = computed<DecorGroup[]>(() => {
    const m = new Map<string, DecorGroup>();
    for (const e of all.value) {
      const k = groupKeyOf(e);
      let g = m.get(k);
      if (!g) {
        const isMtn = e.id.startsWith("MOMNE");
        const w = isMtn ? momneW(e.id) : e.cx;
        const h = isMtn ? w : e.cy;
        g = {
          key: k,
          label: isMtn ? `Гора ${w}×${h}` : (e.name_ru || e.desc_en),
          family: familyOf(e.shape),
          shape: e.shape,
          cx: w,
          cy: h,
          styles: new Set<string>(),
          tones: new Set<string>(),
          variants: [],
          rep: e,
        };
        m.set(k, g);
      }
      g.variants.push(e);
      g.styles.add(e.style);
      g.tones.add(e.tone);
    }
    for (const g of m.values()) {
      g.variants.sort((a, b) => a.id.localeCompare(b.id));
      g.rep = g.variants.find((v) => v.conf !== "low") ?? g.variants[0]!;
    }
    return [...m.values()];
  });

  /** id -> its group (for variant strips, cycle, similar). */
  const groupIndex = computed<Map<string, DecorGroup>>(() => {
    const m = new Map<string, DecorGroup>();
    for (const g of groups.value) for (const v of g.variants) m.set(v.id, g);
    return m;
  });

  function groupOf(id: string | null | undefined): DecorGroup | undefined {
    return id ? groupIndex.value.get(id) : undefined;
  }

  /** Prev/next VARIANT within the same group (wrapping) — the variant cycle. */
  function neighbor(id: string | null | undefined, dir: number): string | null {
    const g = groupOf(id);
    if (!g || g.variants.length === 0) return null;
    const i = g.variants.findIndex((v) => v.id === id);
    if (i < 0) return g.variants[0]!.id;
    return g.variants[(i + dir + g.variants.length) % g.variants.length]!.id;
  }

  /** A random variant of the same group (different from the current when possible). */
  function randomVariant(id: string | null | undefined): string | null {
    const g = groupOf(id);
    if (!g || g.variants.length === 0) return null;
    if (g.variants.length === 1) return g.variants[0]!.id;
    const others = g.variants.filter((v) => v.id !== id);
    const pick = others[Math.floor(Math.random() * others.length)]!;
    return pick.id;
  }

  /** The catalog variant id for a PLACED object (landmark baseType / mountain MOMNE id),
   *  or null if the object type has no re-rollable look. */
  function catalogIdOf(obj: {
    type: string;
    baseType?: string;
    w?: number;
    image?: number;
  }): string | null {
    if (obj.type === "landmark") return obj.baseType ? obj.baseType.toUpperCase() : null;
    if (obj.type === "mountains") {
      const w = obj.w ?? 1;
      const image = obj.image ?? 0;
      return `MOMNE${String(w).padStart(2, "0")}${String(image).padStart(2, "0")}`;
    }
    return null;
  }

  /** patchObject fields that set a placed object's look to the catalog variant `variantId`. */
  function variantPatch(
    obj: { type: string },
    variantId: string,
  ): Record<string, unknown> | null {
    if (obj.type === "landmark") return { baseType: variantId };
    if (obj.type === "mountains") return { image: parseInt(variantId.slice(7, 9), 10) || 0 };
    return null;
  }

  return {
    catalog, loaded, loading, error, load, all,
    familyOf, get, groups, groupOf, neighbor, randomVariant,
    catalogIdOf, variantPatch,
  };
});
