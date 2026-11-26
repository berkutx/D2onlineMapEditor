/**
 * genStore — the GENERATION SESSION: one recipe a mapmaker is trying on one area, and the
 * variants tried so far.
 *
 * Generating is trial and error: «горная гряда — не та; ещё; предыдущая была лучше; чуть
 * гуще». Each variant is made by a seed, and the server makes the same variant again from
 * the same seed, so stepping back does not need the old result kept anywhere: the current
 * variant is undone and the earlier one is generated again. The session remembers the seeds,
 * which one is on the map, and how much the recipe was asked to make.
 *
 * A variant is ONE commit of the edit history. The session only ever undoes a commit while
 * it is still the user's latest action (editStore.historyTick): once they paint, place or
 * undo something themselves, the variant on the map is theirs to keep and the session ends.
 *
 * Every way to generate goes through here — a tile of the palette, a typed command, a stroke
 * drawn «по рисунку» — so all of them get the same variant controls.
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import type { GenRecipeInfo, ValidationReport } from "@d2/socket-contract";
import { fetchGenRecipes } from "../services/api";
import { tr } from "../i18n";
import { useEditStore } from "./editStore";
import { useModStore } from "./modStore";

export interface GenRegion { x: number; y: number; w: number; h: number }

/** What to generate and where. */
export interface GenRequest {
  recipeId: string;
  region: GenRegion;
  /** A cell mask inside `region`, or null for the whole rectangle. */
  cells: [number, number][] | null;
  /** `cells` is a shape the user drew (to be followed), not a mask that only clips. */
  stroke: boolean;
  /** Do not overwrite existing water and mountains. */
  protect: boolean;
}

export interface GenSession extends GenRequest {
  /** How much the recipe makes, relative to its stock amount (1). */
  amount: number;
  /** A maze: its walls are an obstacle (true) or for looks only (false). */
  sealed: boolean;
  /** A maze: wall blocks the variant on the map could not build (the place was taken). */
  wallGaps: number;
  /** The seed of every variant tried, oldest first. */
  seeds: number[];
  /** Which of them is on the map now. */
  index: number;
  /** Edit ops the variant on the map consists of; 0 = it changed nothing (or was refused). */
  opCount: number;
  /** False when the variant on the map failed validation and was not applied. */
  valid: boolean;
}

/** The steps of the «меньше … больше» control (1 = the recipe's stock amount). */
export const AMOUNT_STEPS: readonly number[] = [0.5, 0.75, 1, 1.5, 2.25];

/** Group ids the server uses, in palette order, with the words and sign shown for each. */
export const GEN_GROUPS: readonly { id: string; title: string; icon: string }[] = [
  { id: "mountains", title: tr("Горы и холмы"), icon: "⛰" },
  { id: "water", title: tr("Вода"), icon: "🌊" },
  { id: "forest", title: tr("Лес"), icon: "🌲" },
  { id: "snow", title: tr("Снег"), icon: "❄" },
  { id: "ground", title: tr("Земля"), icon: "🌱" },
  { id: "structures", title: tr("Дорога и стены"), icon: "🧱" },
  // 🗿, not the rock emoji: Windows 10 has no glyph for that one (it shows an empty box)
  { id: "decor", title: tr("Декор"), icon: "🗿" },
];
const groupOf = (id: string): { id: string; title: string; icon: string } =>
  GEN_GROUPS.find((g) => g.id === id) ?? { id, title: id, icon: "✦" };

const newSeed = (): number => Math.floor(Math.random() * 0x7fffffff);

/** localStorage: "0" = mazes are built for looks only. */
const SEALED_KEY = "d2.gen.sealed";
function readSealed(): boolean {
  try {
    return window.localStorage.getItem(SEALED_KEY) !== "0";
  } catch {
    return true;
  }
}

export const useGenStore = defineStore("gen", () => {
  const edit = useEditStore();

  // ----- the catalogue (what the server can generate) -----------------------------------
  const catalog = shallowRef<GenRecipeInfo[]>([]);
  let catalogP: Promise<GenRecipeInfo[]> | null = null;
  /**
   * Load the recipe list once per session (a failed fetch is retried on the next call). It is
   * asked for the session's mod — known once a map is open — so each recipe also says what
   * this mod lacks for it (`lacks`): not every mod has rocks to scatter.
   */
  function loadCatalog(): Promise<GenRecipeInfo[]> {
    if (!catalogP) {
      catalogP = useModStore().whenReady().then((modId) => fetchGenRecipes(modId)).then((list) => {
        catalog.value = list;
        return list;
      });
      catalogP.catch(() => { catalogP = null; });
    }
    return catalogP;
  }
  const infoOf = (id: string): GenRecipeInfo | undefined => catalog.value.find((r) => r.id === id);
  /** The name a mapmaker knows a recipe by, in the interface language (the id, spaced, when
   *  the list is not loaded). The server names recipes in Russian — the key of the message. */
  const titleOf = (id: string): string => {
    const title = infoOf(id)?.title;
    return title !== undefined ? tr(title) : id.replace(/_/g, " ");
  };
  const iconOf = (id: string): string => groupOf(infoOf(id)?.group ?? "").icon;
  /** The catalogue as the palette shows it: group by group, empty groups left out. */
  const groups = computed(() =>
    [...new Set(catalog.value.map((r) => r.group))]
      .map((id) => ({ ...groupOf(id), recipes: catalog.value.filter((r) => r.group === id) }))
      .sort((a, b) => {
        const ia = GEN_GROUPS.findIndex((g) => g.id === a.id), ib = GEN_GROUPS.findIndex((g) => g.id === b.id);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      }),
  );
  /** Recipes that can follow a drawn stroke («По рисунку») — those this mod has material for. */
  const drawable = computed(() => catalog.value.filter((r) => r.stroke && !r.lacks));

  // ----- the session -------------------------------------------------------------------
  const session = ref<GenSession | null>(null);
  const busy = ref(false);
  /** The amount a NEW generation starts with (the palette's control; sticky). */
  const amount = ref(1);
  /** How a NEW maze is built: its walls an obstacle (true), or for looks only. Remembered. */
  const sealed = ref(readSealed());
  watch(sealed, (v) => {
    try {
      window.localStorage.setItem(SEALED_KEY, v ? "1" : "0");
    } catch {
      /* storage blocked: the choice lasts for this page */
    }
  });
  /** editStore.historyTick right after OUR last commit/undo: while it is unchanged, the
   *  user's latest action is still the variant on the map. */
  let ownTick = -1;

  const mine = (): boolean => session.value !== null && edit.historyTick === ownTick;

  // The user did something else (painted, placed, pressed undo): the variant stays as it is.
  watch(
    () => edit.historyTick,
    (tick) => {
      if (session.value && !busy.value && tick !== ownTick) session.value = null;
    },
  );
  // Another map: nothing of the old session applies.
  watch(
    () => edit.project?.baseScenarioId,
    () => { session.value = null; },
  );

  /** Generate one variant of `s` with `seed` and record it as the one on the map. */
  async function put(s: GenSession, seed: number): Promise<ValidationReport | null> {
    const report = await edit.generate(s.recipeId, s.region, seed, s.cells, s.protect, {
      amount: s.amount,
      stroke: s.stroke,
      sealed: s.sealed,
    });
    s.valid = !!report?.ok;
    s.opCount = report?.ok ? (edit.genDebug?.opCount ?? 0) : 0;
    s.wallGaps = report?.ok ? (edit.genDebug?.wallGaps ?? 0) : 0;
    ownTick = edit.historyTick;
    return report;
  }

  /** Take the variant on the map back (it is one commit; nothing to do when it made none). */
  function takeBack(s: GenSession): void {
    if (s.opCount > 0 && edit.undoable) edit.undoEdit();
    s.opCount = 0;
    ownTick = edit.historyTick;
  }

  /**
   * Start a session: generate the first variant. Returns the validation report (null when
   * there is no editable map). A refused variant still opens the session, so the user can
   * ask for another one.
   */
  async function run(req: GenRequest, opts: { amount?: number; seed?: number } = {}): Promise<ValidationReport | null> {
    if (busy.value) return null;
    busy.value = true;
    try {
      const seed = opts.seed ?? newSeed();
      const s: GenSession = {
        ...req,
        amount: opts.amount ?? amount.value,
        sealed: sealed.value,
        wallGaps: 0,
        seeds: [seed],
        index: 0,
        opCount: 0,
        valid: true,
      };
      const report = await put(s, seed);
      session.value = report ? s : null;
      return report;
    } finally {
      busy.value = false;
    }
  }

  /**
   * Replace the variant on the map: undo it, generate `seed` instead. The canvas is muted in
   * between, so the map goes from one variant straight to the other with no flash of the
   * bare ground. False when the session is no longer the user's latest action.
   */
  async function swap(change: (s: GenSession) => number): Promise<boolean> {
    const s = session.value;
    if (!s || busy.value) return false;
    if (!mine()) {
      session.value = null;
      return false;
    }
    busy.value = true;
    edit.setRenderMuted(true);
    try {
      takeBack(s);
      await put(s, change(s));
      return true;
    } finally {
      edit.setRenderMuted(false);
      busy.value = false;
    }
  }

  /** A new variant (a fresh seed), added after the ones already tried. */
  const another = (): Promise<boolean> =>
    swap((s) => {
      const seed = newSeed();
      s.seeds.push(seed);
      s.index = s.seeds.length - 1;
      return seed;
    });
  /** Step to an earlier / later variant of this session (generated again from its seed). */
  const step = (delta: number): Promise<boolean> =>
    swap((s) => {
      s.index = Math.max(0, Math.min(s.seeds.length - 1, s.index + delta));
      return s.seeds[s.index]!;
    });
  /** The same variant (same seed) with another amount. Also becomes the palette's amount. */
  function retune(value: number): Promise<boolean> {
    amount.value = value;
    return swap((s) => {
      s.amount = value;
      return s.seeds[s.index]!;
    });
  }

  /** The same maze (same seed) with its walls built the other way. Also the choice for the next one. */
  function rewall(value: boolean): Promise<boolean> {
    sealed.value = value;
    return swap((s) => {
      s.sealed = value;
      return s.seeds[s.index]!;
    });
  }

  /** Remove the variant from the map and end the session. */
  function discard(): void {
    const s = session.value;
    if (!s || busy.value) return;
    if (mine()) takeBack(s);
    session.value = null;
  }
  /** Keep the variant on the map and end the session. */
  function keep(): void {
    if (!busy.value) session.value = null;
  }

  return {
    catalog, groups, drawable, loadCatalog, infoOf, titleOf, iconOf,
    session, busy, amount, sealed,
    run, another, step, retune, rewall, discard, keep,
  };
});
