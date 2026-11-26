/**
 * Interface languages. The source language is Russian: a message's key IS its Russian
 * text, and a dictionary maps it to another language (`locales/en.json`, `locales/pl.json`).
 * A message a dictionary lacks is shown in Russian.
 *
 *   tr("Отмена")
 *   tr("Удалить зону «{name}»?", { name })
 *   trn("{n} объект|{n} объекта|{n} объектов", count)      // plural forms of the SOURCE
 *   trc("Новое событие")                                   // a default text written INTO the map
 *   trx("stat", "Обзор")                                   // a homonym: key "Обзор ## stat"
 *
 * The language is fixed for the life of the page: `initI18n()` loads the dictionary
 * BEFORE the application modules are imported (see main.ts), and `switchLocale()`
 * reloads the page. So `tr()` is safe anywhere — module constants included — and
 * nothing has to be reactive to the language.
 *
 * Texts that come from outside this app (event field labels of @d2/map-schema, generator
 * recipes of the server) are translated at the point of display with the same `tr()`.
 * What belongs to the map or to the mod — names of units, items, map texts — is content,
 * not interface, and is never translated.
 *
 * `pnpm --filter @d2/web run i18n:check` lists messages without a translation.
 */
import elRu from "element-plus/es/locale/lang/ru";
import elEn from "element-plus/es/locale/lang/en";
import elPl from "element-plus/es/locale/lang/pl";

export type Locale = "ru" | "en" | "pl";

/** The languages on offer, each named in itself. */
export const LOCALES: readonly { value: Locale; label: string }[] = [
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
  { value: "pl", label: "Polski" },
];

export type Dictionary = Readonly<Record<string, string>>;
export type MessageParams = Readonly<Record<string, string | number>>;

const STORAGE_KEY = "d2.locale";
const LOADERS: Record<Exclude<Locale, "ru">, () => Promise<{ default: Dictionary }>> = {
  en: () => import("./locales/en.json"),
  pl: () => import("./locales/pl.json"),
};
const ELEMENT_LOCALES = { ru: elRu, en: elEn, pl: elPl } as const;
const INTL_TAGS: Record<Locale, string> = { ru: "ru-RU", en: "en-GB", pl: "pl-PL" };

let current: Locale = "ru";
let dictionary: Dictionary = {};

export function currentLocale(): Locale {
  return current;
}

/** The tag for `toLocaleString` / `Intl.*` in the current language. */
export function intlLocale(): string {
  return INTL_TAGS[current];
}

/** The Element Plus language pack of the current language (its own built-in texts:
 *  «Нет данных», the buttons of a message box, the date picker…). */
export function elementLocale(): (typeof ELEMENT_LOCALES)[Locale] {
  return ELEMENT_LOCALES[current];
}

function isLocale(v: unknown): v is Locale {
  return v === "ru" || v === "en" || v === "pl";
}

/** A browser language tag → an interface language. Russian also serves its neighbours
 *  (the editor's first audience). */
export function matchLocale(tag: string): Locale | null {
  const base = tag.toLowerCase().split(/[-_]/)[0];
  if (base === "ru" || base === "uk" || base === "be" || base === "kk") return "ru";
  if (base === "pl") return "pl";
  if (base === "en") return "en";
  return null;
}

/** What to start in: the remembered choice, else the browser's languages in order,
 *  else English. */
export function detectLocale(stored: string | null, browser: readonly string[]): Locale {
  if (isLocale(stored)) return stored;
  for (const tag of browser) {
    const hit = matchLocale(tag);
    if (hit) return hit;
  }
  return "en";
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage blocked: the browser language decides
  }
}

/** Make `locale` current with this dictionary (tests call it directly). */
export function useDictionary(locale: Locale, dict: Dictionary): void {
  current = locale;
  dictionary = dict;
}

/** Pick the language and load its dictionary. Call once, before the app is imported. */
export async function initI18n(): Promise<Locale> {
  const browser = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  let locale = detectLocale(readStored(), browser);
  let dict: Dictionary = {};
  if (locale !== "ru") {
    try {
      dict = (await LOADERS[locale]()).default;
    } catch {
      locale = "ru"; // the dictionary did not load: Russian needs none
    }
  }
  useDictionary(locale, dict);
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  return locale;
}

/** Remember the choice and reload: every text of the page is rebuilt in the new language. */
export function switchLocale(locale: Locale): void {
  if (locale === current) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    return; // storage blocked: a reload would only fall back to the browser language
  }
  window.location.reload();
}

function fill(text: string, params?: MessageParams): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** Translate a message; `{name}` placeholders are filled from `params`. */
export function tr(source: string, params?: MessageParams): string {
  return fill(dictionary[source] ?? source, params);
}

/** How a dictionary keys a message that needs a context: "<source> ## <context>". */
export function contextKey(context: string, source: string): string {
  return `${source} ## ${context}`;
}

/**
 * Translate a word that means different things in different places — «Обзор» is a tool
 * and a leader's scouting range, «Вид» a menu and a decoration's look. The context picks
 * the dictionary entry ("Обзор ## stat"); in Russian the word is shown as it is.
 * Use it only where a plain `tr()` key is already taken by another meaning.
 */
export function trx(context: string, source: string, params?: MessageParams): string {
  return fill(dictionary[contextKey(context, source)] ?? source, params);
}

const PLURAL_RULES: Partial<Record<Locale, Intl.PluralRules>> = {};

/** Which of `count` forms fits `n`: Russian and Polish have one|few|many, English one|other. */
export function pluralIndex(locale: Locale, n: number, count: number): number {
  const rules = (PLURAL_RULES[locale] ??= new Intl.PluralRules(locale));
  const category = rules.select(Math.abs(n));
  let index: number;
  if (locale === "en") index = category === "one" ? 0 : 1;
  else index = category === "one" ? 0 : category === "few" ? 1 : category === "many" ? 2 : 1; // "other" = a fraction: «1,5 объекта»
  return Math.min(index, count - 1);
}

/**
 * A message that depends on a number. `forms` are the Russian forms separated by `|`
 * (один|два|пять: "{n} объект|{n} объекта|{n} объектов"); the whole string is the key, and
 * its translation carries the forms of that language ("{n} object|{n} objects").
 * `{n}` is filled with the number; other placeholders come from `params`.
 */
export function trn(forms: string, n: number, params?: MessageParams): string {
  const variants = (dictionary[forms] ?? forms).split("|");
  const picked = variants[pluralIndex(current, n, variants.length)] ?? variants[0] ?? "";
  return fill(picked, { n, ...params });
}

/** Latin letters with diacritics — which the map's Windows-1251 strings cannot hold — become
 *  their plain base letter. Only Latin is touched: Cyrillic «й» and «ё» also decompose into a
 *  letter and a mark, and a map's own Russian name passed in as a parameter must stay whole. */
function toMapSafe(text: string): string {
  return text.replace(/[À-ɏ]/g, (ch) => {
    if (ch === "ł") return "l";
    if (ch === "Ł") return "L";
    const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return /^[A-Za-z]+$/.test(base) ? base : ch;
  });
}

/**
 * A default text that is written INTO the map (the name of a new event, zone, template…).
 * Translated like `tr()`, then reduced to what a `.sg` string can store: the file is
 * Windows-1251, which has Cyrillic and plain Latin but no Polish diacritics.
 */
export function trc(source: string, params?: MessageParams): string {
  const text = tr(source, params);
  return current === "ru" ? text : toMapSafe(text);
}
