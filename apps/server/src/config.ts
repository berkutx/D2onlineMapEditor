/**
 * Server configuration. Values are read from the environment with sensible
 * defaults so the app boots with zero config in development.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** apps/server/src -> repo root is three levels up. */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

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

/** Normalize a base path: "" (dev) or "/map" (no trailing slash). */
function envBasePath(): string {
  const raw = (process.env.BASE_PATH ?? "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export const config = {
  /** HTTP/socket.io port. */
  PORT: envInt("PORT", 3000),
  HOST: process.env.HOST ?? "0.0.0.0",

  /**
   * Deploy base path. Empty in dev; "/map" in production behind the Cloudflare Tunnel, which
   * forwards d2mapeditor.online/map/* unchanged. The server strips it (Fastify rewriteUrl) and
   * pins socket.io to `${BASE_PATH}/socket.io`. The web build sets a matching Vite base.
   */
  BASE_PATH: envBasePath(),

  /** Built SPA dir to serve in production (apps/web/dist). Empty/absent -> dev (Vite serves it). */
  WEB_DIST: process.env.WEB_DIST ?? resolve(REPO_ROOT, "apps", "web", "dist"),

  /** Copilot LLM file-bridge enabled? Off in production (no agent) -> /copilot returns 503. */
  COPILOT_LLM: process.env.COPILOT_LLM !== "off",

  /** Repo root, resolved absolute. */
  repoRoot: REPO_ROOT,

  /**
   * Directories scanned (recursively) for `.sg` scenarios. Cyrillic dirs +
   * spaces are expected. Override with SCENARIO_ROOTS (";"-separated).
   */
  SCENARIO_ROOTS: envList("SCENARIO_ROOTS", [
    String.raw`C:\GOG Games\last_version\Game\Campaign`,
  ]),

  /** Absolute path to the generated atlases + manifest. */
  ASSETS_DIR:
    process.env.ASSETS_DIR ?? resolve(REPO_ROOT, "public", "assets"),

  /** Where uploaded `.sg` files are stored (Stage-1 optional). */
  UPLOAD_DIR:
    process.env.UPLOAD_DIR ?? resolve(REPO_ROOT, "var", "uploads"),

  /** Copilot LLM file-bridge dir (Phase-4 POC): requests/ + responses/ + archive/. */
  LLM_DIR:
    process.env.LLM_DIR ?? resolve(REPO_ROOT, "var", "llm"),

  /** TTL for EPHEMERAL maps (first-visit auto-clones): swept this long after the last
   *  access. Override with EPHEMERAL_TTL_MS. Default 2 days (per the product decision). */
  EPHEMERAL_TTL_MS: envInt("EPHEMERAL_TTL_MS", 2 * 24 * 60 * 60 * 1000),

  /** Upload guard: 32 MiB cap and required magic. */
  UPLOAD_MAX_BYTES: 32 * 1024 * 1024,
  SG_MAGIC: "D2EESFISIG",

  /** In-memory parsed-map LRU capacity. */
  MAP_CACHE_MAX: envInt("MAP_CACHE_MAX", 8),
} as const;

export type Config = typeof config;
