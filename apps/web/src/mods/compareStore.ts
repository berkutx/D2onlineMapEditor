/**
 * The compare page's state: the mods, the chosen pair, loading and its progress, the diff,
 * the open screen and the open card. The diff is large plain data: it is held in shallow
 * refs and never made deeply reactive.
 */
import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef } from "vue";
import type { EntityChange, ModDiff, RaceChange, SectionId, TableChange } from "@d2/mod-diff";
import { tr } from "../i18n";
import { ICON_FOLDERS, BlobCache, buildPayload, fileUrl, listCompareMods, loadSide, HttpError, withShareKey, type CompareMod, type FetchFn, type SideData, type SideProgress } from "./loader";
import { compareSearch, defaultPair, parseCompareQuery, shareKeyOf } from "./pair";
import type { DiffResult, SideExtras } from "./prepare";
import { runDiff } from "./runDiff";
import { isNavId, type NavId } from "./labels";
import type { SpriteManifest } from "@d2/mod-diff";

export type Side = "a" | "b";
export type Phase = "idle" | "listing" | "loading" | "diffing" | "ready" | "error";

/** An open card: an entity by uid, or a race. */
export type CardRef = { kind: "entity"; uid: string } | { kind: "race"; id: string };

const DEPLOY_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Icon folder of a section's entities. */
const ICON_FOLDER: Partial<Record<SectionId, string>> = {
  units: "uniticons/",
  items: "itemicons/",
  spells: "spellicons/",
  lords: "lordicons/",
};

function cardKey(c: CardRef): string {
  return c.kind === "race" ? `race:${c.id}` : c.uid;
}
function cardOf(key: string | null): CardRef | null {
  if (!key) return null;
  return key.startsWith("race:") ? { kind: "race", id: key.slice(5) } : { kind: "entity", uid: key };
}

function message(e: unknown): string {
  if (e instanceof HttpError) return tr("Сервер ответил {status} на {url}", { status: e.status, url: e.url });
  if (e instanceof TypeError) return tr("Нет связи с сервером: {error}", { error: e.message });
  return e instanceof Error ? e.message : String(e);
}

export const useCompareStore = defineStore("modCompare", () => {
  const mods = ref<CompareMod[]>([]);
  const defaultModId = ref("");
  const aId = ref<string | null>(null);
  const bId = ref<string | null>(null);
  const phase = ref<Phase>("idle");
  const error = ref<string | null>(null);
  /** Remarks about the address (an unknown mod id). */
  const notices = ref<string[]>([]);
  const progress = ref<Record<Side, SideProgress | null>>({ a: null, b: null });
  const sides = shallowRef<Record<Side, SideData> | null>(null);
  const result = shallowRef<DiffResult | null>(null);
  const view = ref<NavId>("overview");
  const card = ref<CardRef | null>(null);
  const history = ref<CardRef[]>([]);
  /** The open table (Tables) or script (Scripts). */
  const item = ref<string | null>(null);

  let fetchFn: FetchFn = (url, init) => fetch(url, init);
  let cache = new BlobCache(fetchFn);
  const manifests = new Map<string, Promise<SpriteManifest>>();
  let run = 0;

  const diff = computed<ModDiff | null>(() => result.value?.diff ?? null);
  const modA = computed(() => mods.value.find((m) => m.id === aId.value) ?? null);
  const modB = computed(() => mods.value.find((m) => m.id === bId.value) ?? null);
  const identical = computed(() => !!aId.value && aId.value === bId.value);

  // look-ups over the diff, rebuilt when it changes
  const index = computed(() => {
    const d = diff.value;
    const byUid = new Map<string, EntityChange>();
    const byKey = new Map<string, EntityChange>();
    const races = new Map<string, RaceChange>();
    const tables = new Map<string, TableChange>();
    if (d) {
      for (const list of Object.values(d.sections)) {
        for (const e of list) {
          byUid.set(e.uid, e);
          const k = `${e.section}:${e.id}`;
          if (!byKey.has(k)) byKey.set(k, e);
        }
      }
      for (const r of d.races) races.set(r.id, r);
      for (const t of d.tables) tables.set(t.name.toLowerCase(), t);
    }
    return markRaw({ byUid, byKey, races, tables });
  });

  function entity(section: string, id: string): EntityChange | undefined {
    const byKey = index.value.byKey;
    return byKey.get(`${section}:${id}`) ?? byKey.get(`${section}:${id.toUpperCase()}`);
  }

  function syncUrl(): void {
    if (typeof window === "undefined") return;
    const search = compareSearch({
      a: aId.value,
      b: bId.value,
      view: view.value === "overview" ? null : view.value,
      card: card.value ? cardKey(card.value) : null,
      item: item.value,
    });
    // the fragment (a share key, #key=...) stays: the address remains the link that was opened
    if (window.location.search !== search) window.history.replaceState(null, "", window.location.pathname + search + (window.location.hash || ""));
  }

  /**
   * Start from the address: list the mods, settle the pair, load it. `hash` is the address's
   * fragment; a share key there (`#key=...`) goes with every request.
   */
  async function init(search: string, opts: { fetchFn?: FetchFn; hash?: string } = {}): Promise<void> {
    if (opts.fetchFn || opts.hash) {
      fetchFn = withShareKey(opts.fetchFn ?? ((url, init) => fetch(url, init)), shareKeyOf(opts.hash ?? ""));
      cache = new BlobCache(fetchFn);
    }
    const q = parseCompareQuery(search);
    if (isNavId(q.view)) view.value = q.view;
    card.value = cardOf(q.card);
    item.value = q.item;
    phase.value = "listing";
    error.value = null;
    try {
      const extra = [q.a, q.b].filter((v): v is string => !!v);
      const list = await listCompareMods(fetchFn, DEPLOY_BASE, extra);
      mods.value = list.mods;
      defaultModId.value = list.defaultModId;
      notices.value = list.unknown.map((id) => tr("Мода «{id}» на этом сервере нет", { id }));
      const pair = defaultPair(list.mods, list.defaultModId, { a: q.a, b: q.b });
      aId.value = pair.a;
      bId.value = pair.b;
    } catch (e) {
      phase.value = "error";
      error.value = tr("Не удалось получить список модов: {error}", { error: message(e) });
      return;
    }
    await load();
  }

  /** Load both sides and diff them. A newer call wins; an older one's result is dropped. */
  async function load(): Promise<void> {
    const a = modA.value;
    const b = modB.value;
    syncUrl();
    if (!a || !b) {
      phase.value = "error";
      error.value = tr("На сервере нет модов для сравнения");
      return;
    }
    const mine = ++run;
    phase.value = "loading";
    error.value = null;
    result.value = null;
    sides.value = null;
    progress.value = { a: null, b: null };
    try {
      const opts = (side: Side) => ({
        fetchFn,
        deployBase: DEPLOY_BASE,
        cache,
        manifests,
        onProgress: (p: SideProgress) => {
          if (mine === run) progress.value = { ...progress.value, [side]: p };
        },
      });
      const [sa, sb] = await Promise.all([loadSide(a, opts("a")), a.id === b.id ? null : loadSide(b, opts("b"))]);
      if (mine !== run) return;
      const both = { a: sa, b: sb ?? sa };
      sides.value = markRaw(both);
      phase.value = "diffing";
      const payload = await buildPayload(both.a, both.b, cache);
      const r = await runDiff(payload);
      if (mine !== run) return;
      result.value = markRaw(r);
      phase.value = "ready";
      // a card from the address that the diff does not have is dropped
      if (card.value && !cardExists(card.value)) card.value = null;
      syncUrl();
    } catch (e) {
      if (mine !== run) return;
      phase.value = "error";
      error.value = tr("Не удалось загрузить моды: {error}", { error: message(e) });
    }
  }

  function cardExists(c: CardRef): boolean {
    return c.kind === "race" ? index.value.races.has(c.id) : index.value.byUid.has(c.uid);
  }

  function setPair(a: string | null, b: string | null): void {
    if (a === aId.value && b === bId.value) return;
    aId.value = a;
    bId.value = b;
    card.value = null;
    history.value = [];
    void load();
  }

  function swap(): void {
    setPair(bId.value, aId.value);
  }

  function openView(v: NavId): void {
    view.value = v;
    item.value = null;
    syncUrl();
  }

  function openItem(name: string | null): void {
    item.value = name;
    syncUrl();
  }

  function openCard(c: CardRef): void {
    if (!cardExists(c)) return;
    if (card.value && cardKey(card.value) === cardKey(c)) return;
    if (card.value) history.value = [...history.value, card.value];
    card.value = c;
    syncUrl();
  }

  /** Open an entity's card; false when the diff has no such entity (it did not change). */
  function openEntity(section: string, id: string): boolean {
    if (section === "races" && index.value.races.has(id.toUpperCase())) {
      openCard({ kind: "race", id: id.toUpperCase() });
      return true;
    }
    const e = entity(section, id);
    if (!e) return false;
    openCard({ kind: "entity", uid: e.uid });
    return true;
  }

  function canOpen(section: string | null, id: string): boolean {
    if (!section) return false;
    if (section === "races" && index.value.races.has(id.toUpperCase())) return true;
    return !!entity(section, id);
  }

  function back(): void {
    const prev = history.value[history.value.length - 1];
    history.value = history.value.slice(0, -1);
    card.value = prev ?? null;
    syncUrl();
  }

  function closeCard(): void {
    card.value = null;
    history.value = [];
    syncUrl();
  }

  // ---- what the screens read

  function side(s: Side): SideData | null {
    return sides.value?.[s] ?? null;
  }

  function extras(s: Side): SideExtras | null {
    return result.value?.extras[s] ?? null;
  }

  /** URL of an entity's icon in one mod, or null when that mod has none. */
  function iconUrl(s: Side, section: string, id: string): string | null {
    const folder = ICON_FOLDER[section as SectionId];
    const sd = side(s);
    if (!folder || !sd) return null;
    const logical = `${folder}${id.toLowerCase()}.png`;
    return sd.files[logical] ? fileUrl(sd.base, logical) : null;
  }

  /** URL of a logical file of one mod (an icon a picture change names, a script). */
  function fileOf(s: Side, logical: string): string | null {
    const sd = side(s);
    return sd && sd.files[logical] ? fileUrl(sd.base, logical) : null;
  }

  const tablesMissing = computed(() => ({ a: !!sides.value?.a.tablesMissing, b: !!sides.value?.b.tablesMissing }));

  return {
    mods,
    defaultModId,
    aId,
    bId,
    modA,
    modB,
    identical,
    phase,
    error,
    notices,
    progress,
    sides,
    result,
    diff,
    index,
    view,
    card,
    history,
    item,
    tablesMissing,
    init,
    load,
    setPair,
    swap,
    openView,
    openItem,
    openCard,
    openEntity,
    canOpen,
    entity,
    back,
    closeCard,
    side,
    extras,
    iconUrl,
    fileOf,
  };
});

export { ICON_FOLDERS };
