/**
 * Where each mod's game data lives on THIS machine (the folder that holds Globals, Imgs,
 * Interf, Scripts) — for tests that read every table or archive of every mod. Never
 * committed. Resolution order:
 *   1. the D2_MOD_ROOTS environment variable: `modId=path;modId=path`;
 *   2. `gameRoots` in `mods.local.json` at the repo root (gitignored, see
 *      mods.local.json.example): { "gameRoots": { "<modId>": "<dir>" } };
 *   3. the one install of test-helpers/gameDir.ts, as `default`.
 * Folders that do not exist are left out, so a test over the result simply has less to do
 * on a machine with fewer installs, and nothing on CI.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gameDir } from "./gameDir";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export interface ModRoot {
  modId: string;
  /** The folder with Globals, Imgs, Interf, Scripts. */
  root: string;
}

function configured(): ModRoot[] {
  const env = process.env.D2_MOD_ROOTS?.trim();
  if (env) {
    return env
      .split(";")
      .map((part) => {
        const eq = part.indexOf("=");
        return eq > 0 ? { modId: part.slice(0, eq).trim(), root: part.slice(eq + 1).trim() } : null;
      })
      .filter((r): r is ModRoot => !!r && !!r.modId && !!r.root);
  }
  try {
    const json = JSON.parse(readFileSync(join(REPO_ROOT, "mods.local.json"), "utf8")) as { gameRoots?: Record<string, unknown> };
    const rows = Object.entries(json.gameRoots ?? {}).filter((e): e is [string, string] => typeof e[1] === "string");
    if (rows.length) return rows.map(([modId, root]) => ({ modId, root }));
  } catch {
    /* no local file */
  }
  try {
    return [{ modId: "default", root: join(gameDir(), "Game") }];
  } catch {
    return [];
  }
}

/** The mods whose game folder exists here. */
export function modRoots(): ModRoot[] {
  return configured().filter((m) => existsSync(m.root));
}

/** A data folder of a mod by its usual name, matched ignoring case ("Globals", "Imgs"). */
export function modFolder(root: string, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.toLowerCase() === wanted);
  return entry ? join(root, entry.name) : undefined;
}

/** Files of a folder with the given extension (".dbf", ".ff"), ignoring case, sorted by name. */
export function filesWithExtension(dir: string, ext: string): string[] {
  const wanted = ext.toLowerCase();
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(wanted))
    .map((e) => join(dir, e.name))
    .sort();
}
