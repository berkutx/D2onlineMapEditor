/**
 * unitStore — loads the offline-built unit catalog (public/assets/unitCatalog.json) and
 * exposes it for the garrison grid + mercenary-camp pickers. Each entry is a GLOBAL Gunit
 * template { id (G###UU####), name, level, cat (LunitC enum), catKey, race, subrace,
 * subraceId, hp, armor, leadership, leaderKey?, desc? }. RU labels for the category /
 * leader-subtype enums live here so the catalog stays pure game-sourced data.
 */
import { defineStore } from "pinia";
import { assetUrl } from "../services/api";
import { ref, computed } from "vue";

export interface UnitEntry {
  id: string;
  name: string;
  level: number;
  cat: number;
  catKey: string;
  race: string;
  subrace: string;
  subraceId: number;
  hp: number;
  armor: number;
  leadership: number;
  leaderKey?: string;
  desc?: string;
  /** true = a BIG 2-cell unit (Gunits SIZE_SMALL false): a dragon/giant/big hero that occupies
   *  both cells of its formation column. Emitted only when large (catalog stays compact). */
  large?: boolean;
}

export interface UnitGroup {
  key: string;
  label: string;
  units: UnitEntry[];
}

/** RU labels for the authoritative LunitC unit-category enum (group headings, plural). */
export const UNIT_CAT_LABELS: Record<string, string> = {
  L_SOLDIER: "Воины",
  L_LEADER: "Герои",
  L_GUARDIAN: "Стражи",
  L_SUMMON: "Призываемые",
  L_NOBLE: "Дворяне",
  L_ILLUSION: "Иллюзии",
};

/** Singular role labels for a single unit row. The SAME creature often has several Gunit
 *  records differing only by role (e.g. Мизраэль exists as L_GUARDIAN and L_SOLDIER) — showing
 *  the role is what tells those otherwise-identical-looking rows apart. */
export const UNIT_ROLE_LABELS: Record<string, string> = {
  L_SOLDIER: "Воин",
  L_LEADER: "Герой",
  L_GUARDIAN: "Страж",
  L_SUMMON: "Призыв",
  L_NOBLE: "Дворянин",
  L_ILLUSION: "Иллюзия",
};
export const roleLabel = (catKey: string): string => UNIT_ROLE_LABELS[catKey] ?? "";

/** RU labels for the LleadC leader-subtype enum (heroes only). */
export const UNIT_LEADER_LABELS: Record<string, string> = {
  L_FIGHTER: "Воин",
  L_MAGE: "Маг",
  L_EXPLORER: "Разведчик",
  L_NOBLE: "Дворянин",
  L_ROD: "Жезлоносец",
};

const NULL_ID = "G000000000"; // sentinel "no unit"

export const useUnitStore = defineStore("unit", () => {
  const catalog = ref<Record<string, UnitEntry>>({});
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    if (loaded.value || loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      // ?v cache-bust: the catalog lives on the d2editor_assets volume (gitignored, built offline)
      // and Cloudflare caches it max-age=24h. BUMP this when the volume catalog is re-uploaded, or
      // clients keep the stale edge copy. v2 = adds the `large` (2-cell unit) flag. See deploy/README.
      const res = await fetch(assetUrl("unitCatalog.json") + "?v=2");
      if (!res.ok) throw new Error(`unitCatalog.json ${res.status}`);
      const arr = (await res.json()) as UnitEntry[];
      // HARD REQUIREMENT: the catalog MUST carry unit SIZE (`large` = 2-cell big unit). A catalog
      // with zero `large` is a stale/wrong build on the asset volume — fail LOUD (a missing sized
      // catalog is not normal operation), never silently fall back. See deploy/README §3b.
      if (!arr.some((u) => u.large)) {
        throw new Error("unitCatalog.json несёт 0 размеров юнитов (нет `large`) — на asset-volume старый каталог; см. deploy/README §3b");
      }
      const map: Record<string, UnitEntry> = {};
      for (const e of arr) map[e.id] = e;
      catalog.value = map;
      loaded.value = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      console.error("[unitStore] каталог юнитов не загружен:", error.value);
    } finally {
      loading.value = false;
    }
  }

  const all = computed<UnitEntry[]>(() => Object.values(catalog.value));

  /** Level SpinBox cap — PORTED verbatim from the reference GroupEditor::unitMaxLvl():
   *  `65536 / getKeysList<Gunit>().count()`. It is a GLOBAL constant (NOT per-unit, NOT the
   *  DYNUPG chain, NOT leader-vs-soldier) — the same value for every cell. `count` = number of
   *  Gunit records; our catalog is exactly that set (target mod: 856 units → cap 76), and it
   *  auto-scales to whatever mod the catalog was built from. Fallback 50 before load (empty
   *  catalog) to avoid a degenerate div-by-count. The SpinBox MIN is the per-unit base level
   *  (`UnitEntry.level`, reference `unitBaseLvl`). */
  const levelCap = computed<number>(() => {
    const n = Object.keys(catalog.value).length;
    return n > 0 ? Math.floor(65536 / n) : 50;
  });

  function get(id: string | null | undefined): UnitEntry | undefined {
    return id ? catalog.value[id] : undefined;
  }
  function nameOf(id: string | null | undefined): string {
    if (!id || id === NULL_ID) return "";
    return catalog.value[id]?.name || id;
  }

  /** May this unit LEAD a stack (LEADER_ID)? Only L_LEADER + L_NOBLE — the reference
   *  editor's filter, byte-verified: 14459 stack + 3333 template leaders across 134
   *  shipped maps are 100% these two categories. Unknown ids → false (fail closed). */
  function isLeaderCategory(id: string | null | undefined): boolean {
    const e = get(id);
    return !!e && (e.catKey === "L_LEADER" || e.catKey === "L_NOBLE");
  }

  /** Is this a BIG 2-cell unit (Gunits SIZE_SMALL false)? Used to place a fresh big unit across
   *  both column cells + render one merged slot. Per-TYPE answer (footprint never changes at
   *  runtime); complements the placement-derived big detection (shared key / POS_i==POS_j) that
   *  already handles units read from a map. Unknown ids → false. */
  function isLarge(id: string | null | undefined): boolean {
    return !!get(id)?.large;
  }

  /** Units grouped by subrace (ascending subraceId) — the main way to find a faction's roster. */
  const bySubrace = computed<UnitGroup[]>(() => {
    const by = new Map<number, UnitEntry[]>();
    for (const e of all.value) {
      if (!by.has(e.subraceId)) by.set(e.subraceId, []);
      by.get(e.subraceId)!.push(e);
    }
    const out: UnitGroup[] = [];
    for (const sid of [...by.keys()].sort((a, b) => a - b)) {
      const units = by.get(sid)!;
      units.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, "ru"));
      out.push({ key: `s${sid}`, label: units[0]?.subrace ?? `Раса ${sid}`, units });
    }
    return out;
  });

  /** Units grouped by category (LunitC). */
  const byCat = computed<UnitGroup[]>(() => {
    const by = new Map<number, UnitEntry[]>();
    for (const e of all.value) {
      if (!by.has(e.cat)) by.set(e.cat, []);
      by.get(e.cat)!.push(e);
    }
    const out: UnitGroup[] = [];
    for (const cat of [...by.keys()].sort((a, b) => a - b)) {
      const units = by.get(cat)!;
      units.sort((a, b) => a.subraceId - b.subraceId || a.level - b.level || a.name.localeCompare(b.name, "ru"));
      const catKey = units[0]?.catKey ?? "";
      out.push({ key: catKey || String(cat), label: UNIT_CAT_LABELS[catKey] ?? `Категория ${cat}`, units });
    }
    return out;
  });

  /** Units grouped by level 1..5. */
  const byLevel = computed<UnitGroup[]>(() => {
    const by = new Map<number, UnitEntry[]>();
    for (const e of all.value) {
      if (!by.has(e.level)) by.set(e.level, []);
      by.get(e.level)!.push(e);
    }
    const out: UnitGroup[] = [];
    for (const lvl of [...by.keys()].sort((a, b) => a - b)) {
      const units = by.get(lvl)!;
      units.sort((a, b) => a.subraceId - b.subraceId || a.name.localeCompare(b.name, "ru"));
      out.push({ key: `l${lvl}`, label: `Уровень ${lvl}`, units });
    }
    return out;
  });

  return { catalog, loaded, loading, error, load, all, levelCap, get, nameOf, isLeaderCategory, isLarge, bySubrace, byCat, byLevel };
});
