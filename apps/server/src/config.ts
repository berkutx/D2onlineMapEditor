/**
 * Server configuration. Values are read from the environment with sensible
 * defaults so the app boots with zero config in development.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** apps/server/src -> repo root is three levels up. */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** The local Disciples 2 install root (dev convenience): D2_GAME_DIR env or the one-line
 *  gitignored `game-dir.local` at the repo root (see game-dir.local.example). Null when
 *  neither is set — production containers mount scenarios explicitly instead. */
function localGameDir(): string | null {
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
  return null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Normalize a deployment path: "" (root) or "/map" (no trailing slash). */
function envPath(name: string): string {
  const raw = (process.env[name] ?? "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/** Normalize a browser-facing origin. Empty keeps relative URLs for local development. */
function envOrigin(name: string): string {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return "";
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an http(s) origin without a path`);
  }
  return url.origin;
}

export const config = {
  /** HTTP/socket.io port. */
  PORT: envInt("PORT", 3000),
  HOST: process.env.HOST ?? "0.0.0.0",

  /**
   * Deploy base path. Empty in dev; "/map" in production behind lastwar_nginx. The server
   * strips it (Fastify rewriteUrl) and pins socket.io to `${BASE_PATH}/socket.io`.
   */
  BASE_PATH: envPath("BASE_PATH"),

  /** Built SPA dir to serve in production (apps/web/dist). Empty/absent -> dev (Vite serves it). */
  WEB_DIST: process.env.WEB_DIST ?? resolve(REPO_ROOT, "apps", "web", "dist"),

  /** Copilot LLM file-bridge enabled? Off in production (no agent) -> /copilot returns 503. */
  COPILOT_LLM: process.env.COPILOT_LLM !== "off",

  /** Private voice service reachable only through the shared Docker network. Empty disables
   *  the integration in local development; production uses http://d2map_app:3456. */
  VOICE_INTERNAL_URL: (process.env.VOICE_INTERNAL_URL ?? "").replace(/\/+$/, ""),
  /** Browser-visible reverse-proxy prefix for voicer login/project pages. */
  VOICE_PUBLIC_BASE_PATH: envPath("VOICE_PUBLIC_BASE_PATH"),
  /** Optional absolute origin. The direct-IP deployment pins this to HTTP because the old
   *  domain certificate is not valid for the numeric host. */
  VOICE_PUBLIC_ORIGIN: envOrigin("VOICE_PUBLIC_ORIGIN"),
  VOICE_INTEGRATION_SECRET: process.env.D2_INTEGRATION_SECRET ?? "dev-d2-integration",
  VOICE_INTEGRATION_ENABLED: process.env.VOICE_INTEGRATION_ENABLED !== "off",
  VOICE_INTEGRATION_CLIENTS: String(process.env.VOICE_INTEGRATION_CLIENTS ?? "").split(/[;,]/).map((x) => x.trim()).filter(Boolean),

  /** Repo root, resolved absolute. */
  repoRoot: REPO_ROOT,

  /**
   * Directories scanned (recursively) for `.sg` scenarios. Cyrillic dirs + spaces are
   * expected. Override with SCENARIO_ROOTS (";"-separated). Dev default = the local game
   * install's Game/Campaign (via D2_GAME_DIR / game-dir.local); otherwise var/scenarios.
   */
  SCENARIO_ROOTS: envList("SCENARIO_ROOTS", (() => {
    const game = localGameDir();
    return [game ? join(game, "Game", "Campaign") : resolve(REPO_ROOT, "var", "scenarios")];
  })()),

  /** Absolute path to the generated atlases + manifest. */
  ASSETS_DIR:
    process.env.ASSETS_DIR ?? resolve(REPO_ROOT, "public", "assets"),

  /** Where uploaded `.sg` files are stored (Stage-1 optional). */
  UPLOAD_DIR:
    process.env.UPLOAD_DIR ?? resolve(REPO_ROOT, "var", "uploads"),

  /** Server-saved EditorProjects (diff journals), var/projects/<mapId>/<clientId>.json —
   *  durability beyond the browser's localStorage. */
  PROJECTS_DIR:
    process.env.PROJECTS_DIR ?? resolve(REPO_ROOT, "var", "projects"),

  /** Durable per-room collaboration op-logs (EditLog): var/rooms/<sha1(roomKey)>.jsonl.
   *  Makes the server the source of truth so it survives a restart (no client re-seeding). */
  ROOMS_DIR:
    process.env.ROOMS_DIR ?? resolve(REPO_ROOT, "var", "rooms"),

  /** Grace delay before an EMPTY room's parsed op-log + snapshot are evicted from RAM (the
   *  durable .jsonl stays on disk; a real rejoin lazily re-reads it). A window so a brief
   *  socket flap that empties then re-fills the room doesn't thrash a full re-read. Default 60s. */
  ROOM_EVICT_MS: envInt("ROOM_EVICT_MS", 60_000),

  /** Copilot LLM file-bridge dir (Phase-4 POC): requests/ + responses/ + archive/. */
  LLM_DIR:
    process.env.LLM_DIR ?? resolve(REPO_ROOT, "var", "llm"),

  /** TTL for EPHEMERAL maps (first-visit auto-clones): swept this long after the last
   *  access. Override with EPHEMERAL_TTL_MS. Default 2 days. */
  EPHEMERAL_TTL_MS: envInt("EPHEMERAL_TTL_MS", 2 * 24 * 60 * 60 * 1000),

  /** Hard lifetime for a map sent by a trusted external service for read-only preview.
   * Unlike an ephemeral editing clone, opening the preview never extends this deadline. */
  PREVIEW_TTL_MS: envInt("PREVIEW_TTL_MS", 60 * 60 * 1000),
  PREVIEW_UPLOAD_LIMIT: envInt("PREVIEW_UPLOAD_LIMIT", 5),
  PREVIEW_RATE_WINDOW_MS: envInt("PREVIEW_RATE_WINDOW_MS", 60 * 60 * 1000),

  /** Upload guard: 32 MiB cap and required magic. */
  UPLOAD_MAX_BYTES: 32 * 1024 * 1024,
  SG_MAGIC: "D2EESFISIG",

  /** In-memory parsed-map LRU capacity. */
  MAP_CACHE_MAX: envInt("MAP_CACHE_MAX", 8),
} as const;

export type Config = typeof config;
