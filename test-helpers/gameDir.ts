/**
 * Where the Disciples 2 installation lives on THIS machine — tests and spikes need the
 * real game files (campaign .sg maps, Globals .dbf) as fixtures, and the path must never
 * be committed. Resolution order:
 *   1. the D2_GAME_DIR environment variable;
 *   2. a one-line `game-dir.local` file at the repo root (gitignored — see
 *      `game-dir.local.example`).
 * Both point at the game ROOT (the folder that contains `Game/`).
 */
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export function gameDir(): string {
  const env = process.env.D2_GAME_DIR?.trim();
  if (env) return env;
  try {
    const line = readFileSync(join(REPO_ROOT, "game-dir.local"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (line) return line;
  } catch {
    /* no local file */
  }
  throw new Error(
    "Disciples 2 game dir not configured: set D2_GAME_DIR or create game-dir.local " +
      "at the repo root (see game-dir.local.example). Tests use the game's own maps as fixtures.",
  );
}

/** `<game>/Game/Campaign` — the shipped campaign maps used as parser fixtures. */
export function campaignDir(): string {
  return join(gameDir(), "Game", "Campaign");
}

/** A specific campaign map by its path relative to Game/Campaign. */
export function campaignMap(rel: string): string {
  return join(campaignDir(), rel);
}

/**
 * `<game>/Game/Exports - Copy` — the PRISTINE authored map originals (the editor's own exports).
 * Unlike `Game/Campaign`, these carry no playthrough state (visited-site lists, etc.), so a
 * full model rebuild reproduces them byte-for-byte. Preferred corpus for the rebuild gate.
 */
export function exportsDir(): string {
  return join(gameDir(), "Game", "Exports - Copy");
}
