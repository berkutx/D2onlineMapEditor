/**
 * The compare page's address and its default pair of mods. Pure: no DOM, no store.
 *
 *   ?mods&a=semga&b=semga-2&view=units&card=units:Gunits:G000UU0019
 *
 * `mods` (a bare key) says "this is the compare page"; the editor boots as before without it.
 */

/** What the address holds. */
export interface CompareQuery {
  a: string | null;
  b: string | null;
  /** The open screen: "overview", a section id, "terrain", "graphics", "scripts", "tables". */
  view: string | null;
  /** The open card: an entity uid, or "race:<id>". */
  card: string | null;
  /** The open table or script of the Tables / Scripts screen. */
  item: string | null;
  /**
   * Whether the wording of the texts is compared: "compare" or "skip". Null: the page decides
   * (skip when the two mods are written in different scripts — the English game and a Russian mod).
   */
  texts: TextsChoice | null;
}

/** The texts choice the address can hold (see CompareQuery.texts). */
export type TextsChoice = "compare" | "skip";
const isTextsChoice = (v: string | null): v is TextsChoice => v === "compare" || v === "skip";

export function isComparePage(search: string): boolean {
  return new URLSearchParams(search).has("mods");
}

/**
 * The share key of a secret link, `#key=<key>`: in the fragment, so it never reaches the
 * server with the page request or a log line; the page sends it with its own requests
 * (loader.withShareKey). Null without one.
 */
export function shareKeyOf(hash: string): string | null {
  const v = new URLSearchParams(hash.replace(/^#/, "")).get("key");
  return v && v.trim() ? v.trim() : null;
}

export function parseCompareQuery(search: string): CompareQuery {
  const q = new URLSearchParams(search);
  const get = (k: string): string | null => {
    const v = q.get(k);
    return v && v.trim() ? v.trim() : null;
  };
  const texts = get("texts");
  return { a: get("a"), b: get("b"), view: get("view"), card: get("card"), item: get("item"), texts: isTextsChoice(texts) ? texts : null };
}

/** The search part for a state, always starting with "?mods"; empty fields are left out. */
export function compareSearch(q: Partial<CompareQuery>): string {
  let s = "?mods";
  for (const k of ["a", "b", "view", "card", "item", "texts"] as const) {
    const v = q[k];
    if (v) s += `&${k}=${encodeURIComponent(v)}`;
  }
  return s;
}

/** A mod as the pair rule sees it. */
export interface PairCandidate {
  id: string;
  family: string;
  familyOrder: number;
  /** The base of a derived mod. */
  parent?: string | null;
  /** The unmodded game, the base every other mod is compared with. */
  reference?: boolean;
}

/**
 * What to compare B with when the address does not say: B's parent when B is derived;
 * else the reference mod (the unmodded game) when B is not it; else the previous version
 * of B's family; else the server's default mod; else (B is the default mod) another
 * version of its family; else the first other mod. B itself when it is the only mod.
 */
export function predecessorOf(mods: readonly PairCandidate[], b: string, defaultModId: string): string {
  const has = (id: string | null | undefined): id is string => !!id && mods.some((m) => m.id === id);
  const self = mods.find((m) => m.id === b);
  if (!self) return mods.find((m) => m.id !== b)?.id ?? b;
  if (has(self.parent) && self.parent !== b) return self.parent;
  const reference = mods.find((m) => m.reference && m.id !== b);
  if (reference) return reference.id;
  const older = mods
    .filter((m) => m.family === self.family && m.familyOrder < self.familyOrder)
    .sort((x, y) => y.familyOrder - x.familyOrder)[0];
  if (older) return older.id;
  if (defaultModId !== b && has(defaultModId)) return defaultModId;
  const sibling = mods
    .filter((m) => m.family === self.family && m.id !== b)
    .sort((x, y) => x.familyOrder - y.familyOrder)[0];
  if (sibling) return sibling.id;
  return mods.find((m) => m.id !== b)?.id ?? b;
}

/**
 * The pair to show. Ids the mods do not have are ignored. Without B: the newest version of
 * the default mod's family (the default mod itself when it is alone). Without A: see
 * {@link predecessorOf}. Both null when there are no mods.
 */
export function defaultPair(
  mods: readonly PairCandidate[],
  defaultModId: string,
  want: { a?: string | null; b?: string | null } = {},
): { a: string | null; b: string | null } {
  if (mods.length === 0) return { a: null, b: null };
  const has = (id: string | null | undefined): id is string => !!id && mods.some((m) => m.id === id);
  let b: string;
  if (has(want.b)) b = want.b;
  else {
    const def = mods.find((m) => m.id === defaultModId) ?? mods[0]!;
    const newest = mods.filter((m) => m.family === def.family).sort((x, y) => y.familyOrder - x.familyOrder)[0];
    b = newest?.id ?? def.id;
    // the address named only A: compare it with what the rule gives for B, unless that is A
    if (has(want.a) && want.a === b) b = predecessorOf(mods, b, defaultModId);
  }
  const a = has(want.a) ? want.a : predecessorOf(mods, b, defaultModId);
  return { a, b };
}
