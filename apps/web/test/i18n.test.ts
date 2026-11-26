/**
 * Interface languages: the translation functions, and the standing check that every message
 * of the app has an English and a Polish text (the same check `pnpm run i18n:check` prints).
 */
import { afterEach, describe, expect, it } from "vitest";
import { detectLocale, matchLocale, pluralIndex, tr, trc, trn, useDictionary, intlLocale, currentLocale } from "../src/i18n";
// @ts-expect-error — a plain .mjs script (also the CLI), no type declarations
import { checkApp, loadDictionaries, translationProblems } from "../scripts/i18n-check.mjs";

afterEach(() => useDictionary("ru", {}));

describe("tr / trn / trc", () => {
  it("returns the Russian source when no dictionary is loaded, filling placeholders", () => {
    expect(tr("Отмена")).toBe("Отмена");
    expect(tr("Удалить зону «{name}»?", { name: "Болото" })).toBe("Удалить зону «Болото»?");
    expect(tr("{a} и {b}", { a: 1 })).toBe("1 и {b}"); // an unknown placeholder stays visible
    expect(currentLocale()).toBe("ru");
    expect(intlLocale()).toBe("ru-RU");
  });

  it("translates through the dictionary and falls back to Russian for a missing message", () => {
    useDictionary("en", { "Отмена": "Cancel", "Удалить зону «{name}»?": "Delete zone “{name}”?" });
    expect(tr("Отмена")).toBe("Cancel");
    expect(tr("Удалить зону «{name}»?", { name: "Swamp" })).toBe("Delete zone “Swamp”?");
    expect(tr("Нет перевода")).toBe("Нет перевода");
    expect(intlLocale()).toBe("en-GB");
  });

  it("picks the plural form of each language", () => {
    const forms = "{n} объект|{n} объекта|{n} объектов";
    expect([1, 2, 5, 11, 21, 22, 25, 101].map((n) => trn(forms, n))).toEqual([
      "1 объект", "2 объекта", "5 объектов", "11 объектов", "21 объект", "22 объекта", "25 объектов", "101 объект",
    ]);
    useDictionary("en", { [forms]: "{n} object|{n} objects" });
    expect([0, 1, 2, 21].map((n) => trn(forms, n))).toEqual(["0 objects", "1 object", "2 objects", "21 objects"]);
    useDictionary("pl", { [forms]: "{n} obiekt|{n} obiekty|{n} obiektów" });
    expect([1, 2, 5, 12, 22, 25].map((n) => trn(forms, n))).toEqual([
      "1 obiekt", "2 obiekty", "5 obiektów", "12 obiektów", "22 obiekty", "25 obiektów",
    ]);
  });

  it("lets a caller format the number itself and pass other values", () => {
    const forms = "скрыта {n} клетка из {total}|скрыто {n} клетки из {total}|скрыто {n} клеток из {total}";
    expect(trn(forms, 1234, { n: "1 234", total: "20 736" })).toBe("скрыто 1 234 клетки из 20 736");
  });

  it("keeps a default text that goes into the map within Windows-1251", () => {
    useDictionary("pl", { "Новое событие": "Nowe zdarzenie", "Зона": "Strefa żółta Łąka" });
    expect(trc("Новое событие")).toBe("Nowe zdarzenie");
    expect(trc("Зона")).toBe("Strefa zolta Laka"); // no Polish letters in a .sg string
    expect(tr("Зона")).toBe("Strefa żółta Łąka"); // …but the interface keeps them
    // only Latin letters are reduced: a map's own Russian name passed in stays whole,
    // and so does a default text the dictionary lacks
    useDictionary("pl", { "{name} (копия)": "{name} (kopia) żółć" });
    expect(trc("{name} (копия)", { name: "Мой герой ёж" })).toBe("Мой герой ёж (kopia) zolc");
    expect(trc("Новый шаблон")).toBe("Новый шаблон");
    useDictionary("ru", {});
    expect(trc("Зона")).toBe("Зона");
  });

  it("knows which plural form a number takes", () => {
    expect([1, 2, 5, 21, 1.5].map((n) => pluralIndex("ru", n, 3))).toEqual([0, 1, 2, 0, 1]);
    expect([1, 2, 5, 22, 112].map((n) => pluralIndex("pl", n, 3))).toEqual([0, 1, 2, 1, 2]);
    expect([0, 1, 2].map((n) => pluralIndex("en", n, 2))).toEqual([1, 0, 1]);
    expect(pluralIndex("ru", 5, 1)).toBe(0); // a single form serves every number
  });
});

describe("choosing the language", () => {
  it("prefers the remembered choice, then the browser's languages in order, then English", () => {
    expect(detectLocale("pl", ["ru-RU"])).toBe("pl");
    expect(detectLocale(null, ["de-DE", "pl-PL", "en-US"])).toBe("pl");
    expect(detectLocale(null, ["uk-UA", "en"])).toBe("ru");
    expect(detectLocale(null, ["de", "fr"])).toBe("en");
    expect(detectLocale("xx", ["ru"])).toBe("ru"); // a stored value that is not a language is ignored
    expect(detectLocale(null, [])).toBe("en");
  });
  it("maps a browser tag to a language", () => {
    expect(matchLocale("ru-RU")).toBe("ru");
    expect(matchLocale("be")).toBe("ru");
    expect(matchLocale("pl_PL")).toBe("pl");
    expect(matchLocale("en-GB")).toBe("en");
    expect(matchLocale("ja")).toBeNull();
  });
});

describe("the dictionaries", () => {
  it("translate every message of the app into English and Polish", () => {
    const report = checkApp();
    expect(report.bad).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.malformed).toEqual([]);
    expect(report.messages).toBeGreaterThan(500);
  });

  it("carry nothing the app no longer uses", () => {
    expect(checkApp().unused).toEqual([]);
  });

  it("hold the same keys in both languages", () => {
    const { en, pl } = loadDictionaries();
    expect(Object.keys(pl).sort()).toEqual(Object.keys(en).sort());
  });

  it("are checked for placeholders and plural forms", () => {
    expect(translationProblems("Удалить {name}?", "Delete {name}?", "en", false)).toEqual([]);
    expect(translationProblems("Удалить {name}?", "Delete?", "en", false)).toEqual(["en: placeholder {name} is missing"]);
    expect(translationProblems("Удалить {name}?", "Delete {nmae}?", "en", false)).toContain("en: unknown placeholder {nmae}");
    expect(translationProblems("{n} объект|{n} объекта|{n} объектов", "{n} object|{n} objects", "en", true)).toEqual([]);
    expect(translationProblems("{n} объект|{n} объекта|{n} объектов", "{n} obiekt|{n} obiekty", "pl", true)).toEqual([
      "pl: 2 plural forms, expected 1 or 3",
    ]);
    expect(translationProblems("Отмена", "", "pl", false)).toEqual(["pl: empty"]);
  });
});
