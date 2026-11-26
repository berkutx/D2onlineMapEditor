/**
 * The help window of the command bar (layout/CommandHelp.vue) shows phrases to type. Every one
 * of them — in Russian, and as the English and Polish dictionaries word it — must be a line the
 * bar really understands: a help that suggests a phrase the bar cannot read is worse than none.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interpret, nearest } from "../src/services/omnibar";
import en from "../src/i18n/locales/en.json";
import pl from "../src/i18n/locales/pl.json";

const source = readFileSync(fileURLToPath(new URL("../src/layout/CommandHelp.vue", import.meta.url)), "utf8");
/** the Russian example lines of the window: `examples: tr("«…» · «…»")` */
const EXAMPLES = [...source.matchAll(/examples: tr\("([^"]+)"\)/g)].map((m) => m[1] as string);
/** the phrases of a line, whatever quotes the language uses: «…», “…”, „…” */
const phrases = (line: string): string[] => [...line.matchAll(/[«“„]([^»”“]+)[»”]/g)].map((m) => m[1] as string);

describe("the phrases of the command help", () => {
  it("are found in the window's source", () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(6);
    for (const line of EXAMPLES) expect(phrases(line).length).toBeGreaterThan(0);
  });

  const cases: [string, string][] = [];
  for (const line of EXAMPLES) {
    for (const p of phrases(line)) cases.push(["ru", p]);
    for (const [lang, dict] of [["en", en], ["pl", pl]] as const) {
      const translated = (dict as Record<string, string>)[line];
      it(`${lang}: «${line.slice(0, 40)}…» is translated with as many phrases`, () => {
        expect(translated).toBeTruthy();
        expect(phrases(translated ?? "")).toHaveLength(phrases(line).length);
      });
      for (const p of phrases(translated ?? "")) cases.push([lang, p]);
    }
  }

  it.each(cases)("%s: «%s» is understood by the bar", (_lang, phrase) => {
    // a reading, or — for a line that only says how much («густо») — an offer of what goes with it
    const understood = interpret(phrase).length > 0 || nearest(phrase).length > 0;
    expect(understood).toBe(true);
  });
});
