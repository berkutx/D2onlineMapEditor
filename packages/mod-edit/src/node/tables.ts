/** The tables of an install, by name, as the edits name them. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DbfTable } from "@d2/dbf";
import { findEntry } from "./materialize.js";

/** Interf tables that hold mod data (the rest of Interf is the game's own UI). */
export const INTERF_TABLES: readonly string[] = ["TApp", "TAppEdit"];

/**
 * Table name (file name without .dbf) → path, for every table of Globals and the Interf
 * tables a mod edits. `globals` may also be a bare folder of .dbf files (a hand-edited copy).
 */
export function tableFiles(game: string): Map<string, string> {
  const out = new Map<string, string>();
  const globals = findEntry(game, "Globals") ?? (readdirSync(game).some((n) => /\.dbf$/i.test(n)) ? game : undefined);
  if (globals) {
    for (const n of readdirSync(globals)) if (/\.dbf$/i.test(n)) out.set(n.slice(0, -4), join(globals, n));
  }
  const interf = findEntry(game, "Interf");
  if (interf) {
    for (const t of INTERF_TABLES) {
      const p = findEntry(interf, `${t}.dbf`);
      if (p && ![...out.keys()].some((k) => k.toLowerCase() === t.toLowerCase())) out.set(p.slice(interf.length + 1, -4), p);
    }
  }
  return out;
}

export function readTable(path: string, name: string): DbfTable {
  return DbfTable.read(readFileSync(path), name);
}

/** Every Lua file under Scripts, for the ids it names. */
export function luaFiles(game: string): string[] {
  const scripts = findEntry(game, "Scripts");
  if (!scripts || !existsSync(scripts)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.lua$/i.test(e.name)) out.push(p);
    }
  };
  walk(scripts);
  return out;
}
