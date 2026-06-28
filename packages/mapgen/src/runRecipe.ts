/**
 * runRecipe — execute a MarkovJunior recipe (XML) on a WxH grid headlessly and return
 * the FINAL symbol grid. Wraps the vendored MarkovJuniorWeb interpreter (MIT). We bypass
 * its file-based Program/Model registry and drive `Interpreter` directly: parse the XML
 * (pure-JS @xmldom/xmldom — no DOM/canvas), run the generator to completion, then read
 * `grid.padded` (state) + `grid.characters` (the `values` alphabet): char = chars[state[i]].
 * RGB palette is ignored — we only care about symbols.
 */
import { DOMParser } from "@xmldom/xmldom";
// vendored MarkovJuniorWeb (MIT) — @ts-nocheck'd; we use it via a typed shim here.
import { Interpreter } from "../vendor/interpreter";

export interface RecipeGrid {
  width: number;
  height: number;
  /** one string per row, each `width` symbols long (symbols are single chars). */
  rows: string[];
  /** symbol at (x,y), or "" out of bounds. */
  at(x: number, y: number): string;
}

interface MJInterpreter {
  run(seed: number, steps: number): Generator<unknown>;
  state(): [Uint8Array, string, number, number, number];
}

/**
 * Run `xml` on a `width`×`height` grid. `seed` makes it deterministic (same seed →
 * same grid). Throws (fail-loud) if the recipe can't load.
 */
export async function runRecipe(
  xml: string,
  width: number,
  height: number,
  seed = 1,
): Promise<RecipeGrid> {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const elem = doc.documentElement;
  if (!elem) throw new Error("runRecipe: empty/invalid recipe XML");

  const ip = (await (Interpreter as unknown as {
    load(e: unknown, mx: number, my: number, mz: number): Promise<MJInterpreter | null>;
  }).load(elem, width, height, 1)) as MJInterpreter | null;
  if (!ip) throw new Error("runRecipe: interpreter failed to load the recipe");

  const gen = ip.run(seed, -1);
  const maxSteps = width * height * 64 + 100_000; // generous; mazes finish far sooner
  let steps = 0;
  let r = gen.next();
  while (!r.done && steps++ < maxSteps) r = gen.next();

  const [state, chars, fx, fy] = ip.state();
  const rows: string[] = [];
  for (let y = 0; y < fy; y++) {
    let row = "";
    for (let x = 0; x < fx; x++) row += chars[state[y * fx + x] ?? 0] ?? "?";
    rows.push(row);
  }
  return {
    width: fx,
    height: fy,
    rows,
    at: (x, y) => (y >= 0 && y < fy && x >= 0 && x < fx ? rows[y]![x]! : ""),
  };
}
