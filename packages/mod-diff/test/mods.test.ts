/**
 * diffMods on the mods of this machine (test-helpers/modRoots.ts), with each mod's sprite
 * manifest and file list from the local store (public/assets/mods/<id>/mod.json) when it is
 * there. Skipped without the installs (CI has none).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbfTable } from "@d2/dbf";
import { findEntry, readTable, tableFiles } from "@d2/mod-edit/node";
import { diffMods, type ModData, type SpriteManifest } from "../src/index";
import { modRoots } from "../../../test-helpers/modRoots";

const MODS = modRoots();
const rootOf = (id: string) => MODS.find((m) => m.modId === id)?.root;
const STORE = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../public/assets");

function load(id: string): ModData {
  const root = rootOf(id)!;
  const tables = new Map<string, DbfTable>();
  for (const [name, path] of tableFiles(root)) tables.set(name, readTable(path, `${id}/${name}`));
  const imgs = findEntry(root, "Imgs");
  const cap = imgs ? findEntry(imgs, "capital.dat") : undefined;
  const data: ModData = { id, name: id, tables };
  if (cap) data.capitalDat = readFileSync(cap, "latin1");
  const modJson = join(STORE, "mods", id, "mod.json");
  if (existsSync(modJson)) {
    const files = (JSON.parse(readFileSync(modJson, "utf8")) as { files: Record<string, string> }).files;
    data.files = files;
    const manifest = files["manifest.json"];
    if (manifest && existsSync(join(STORE, manifest))) data.manifest = JSON.parse(readFileSync(join(STORE, manifest), "utf8")) as SpriteManifest;
  }
  return data;
}

describe.skipIf(!rootOf("semga") || !rootOf("semga-2"))("the diff from semga to semga-2", () => {
  it("finds the 27 tables that differ, gives every op an owner, and takes under 3 s", () => {
    const a = load("semga");
    const b = load("semga-2");
    const t0 = performance.now();
    const d = diffMods(a, b);
    const ms = performance.now() - t0;
    console.log(`semga -> semga-2: ${Math.round(ms)} ms, pictures ${a.manifest ? "compared" : "not in the store"}`);
    const s = d.summary;
    expect(s.tables.differ).toBe(27);
    // 2689 cells and rows differ; 9 of them only write "no id" another way (GItem.MOD_POTION
    // of the healing potions: empty in semga, g000000000 in semga-2) and are no ops
    expect(s.tables.ops).toBe(2680);
    expect(s.tables.noIdSpellings).toBe(9);
    expect(s.tables.refused).toEqual([]);
    expect(s.unassignedOps).toBe(0);
    expect(s.assignedOps + s.tableOnlyOps).toBe(s.tables.ops);
    expect(d.tables.every((t) => t.unassigned === 0)).toBe(true);
    expect(s.sections.units.added).toBe(4);
    expect(ms).toBeLessThan(3000);
    // plain data: the whole diff survives JSON
    expect(JSON.parse(JSON.stringify(d.summary))).toEqual(d.summary);
  }, 180_000);
});

/** A mod from the local store alone (its tables/ and capital.dat blobs), without its install. */
function loadStored(id: string): ModData | null {
  const modJson = join(STORE, "mods", id, "mod.json");
  if (!existsSync(modJson)) return null;
  const files = (JSON.parse(readFileSync(modJson, "utf8")) as { files: Record<string, string> }).files;
  const tables = new Map<string, DbfTable>();
  for (const [logical, blob] of Object.entries(files)) {
    const m = /^tables\/(.+)\.dbf$/i.exec(logical);
    if (m && existsSync(join(STORE, blob))) tables.set(m[1]!, readTable(join(STORE, blob), `${id}/${m[1]}`));
  }
  if (!tables.size) return null;
  const data: ModData = { id, name: id, tables, files };
  if (files["capital.dat"]) data.capitalDat = readFileSync(join(STORE, files["capital.dat"]), "latin1");
  const manifest = files["manifest.json"];
  if (manifest && existsSync(join(STORE, manifest))) data.manifest = JSON.parse(readFileSync(join(STORE, manifest), "utf8")) as SpriteManifest;
  return data;
}

const VANILLA = loadStored("vanilla");
describe.skipIf(!VANILLA || !rootOf("semga"))("the diff from the GOG game (English) to semga (Russian)", () => {
  it("leaves the translation out by itself, and only the translation", () => {
    const b = load("semga");
    const auto = diffMods(VANILLA!, b, { texts: "auto" });
    const all = diffMods(VANILLA!, b);
    const t = (d: typeof all, name: string) => d.tables.find((x) => x.name.toLowerCase() === name)!;
    console.log(
      `vanilla -> semga: ops ${all.summary.tables.ops} with the texts, ${auto.summary.tables.ops} without; translations ${auto.summary.tables.translations}; ` +
        `texts entities ${all.summary.sections.texts.total} -> ${auto.summary.sections.texts.total}`,
    );
    expect(auto.texts).toEqual({ a: "latin", b: "cyrillic", skipped: true });
    expect(all.texts.skipped).toBe(false);
    // what is left out is exactly the reworded text cells (and the whole-row text lists)
    expect(all.summary.tables.ops - auto.summary.tables.ops).toBe(auto.summary.tables.translations);
    const tg = t(auto, "tglobal");
    expect(tg.counts.set).toBe(0);
    expect(tg.translations).toBe(t(all, "tglobal").counts.set);
    // texts only semga has are still there
    expect(tg.counts.add).toBe(t(all, "tglobal").counts.add);
    // nothing but text tables changed
    for (const x of auto.tables) if (!["tglobal", "tapp", "tappedit", "tleader", "taimsg", "tplayer"].includes(x.name.toLowerCase())) expect(x.ops).toEqual(t(all, x.name.toLowerCase()).ops);
    expect(auto.summary.unassignedOps).toBe(0);
  }, 180_000);
});

describe.skipIf(!rootOf("semga") || !rootOf("nazar-legacy"))("the diff from semga to nazar-legacy", () => {
  it("flags Clans, Legions and Undead as redesigned, above every other race", () => {
    const d = diffMods(load("semga"), load("nazar-legacy"));
    const score = new Map(d.races.map((r) => [r.id, r.redesign.score]));
    const redesigned = ["G000RR0001", "G000RR0002", "G000RR0003"]; // Clans, Legions, Undead
    console.log(d.races.map((r) => `${r.id} ${r.nameB}: ${r.redesign.score}`).join("; "));
    expect(d.summary.races.redesigned.sort()).toEqual(redesigned);
    const others = d.races.filter((r) => !redesigned.includes(r.id)).map((r) => r.redesign.score);
    for (const id of redesigned) expect(score.get(id)!).toBeGreaterThan(Math.max(...others));
    expect(d.summary.unassignedOps).toBe(0);
  }, 180_000);
});
