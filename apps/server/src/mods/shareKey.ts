/**
 * Share keys of the mod comparison: a secret link (`?mods#key=<key>`) whose page sends the
 * key in the `x-mod-share-key` header. A request with a valid key sees the hidden mods and
 * gets their files (see config.MOD_SHARE_KEYS, ModRegistry.isPrivateBlob); without one a
 * hidden mod does not exist for it.
 *
 * Pictures cannot carry a header: the page shows them with `<img>` and CSS backgrounds. So
 * the first answer to a request whose HEADER has a valid key (GET /api/mods) also sets the
 * key as an HttpOnly cookie on the site's path, and a request with that cookie counts as
 * keyed too. The cookie lives for the browser session; a key dropped from the server's list
 * stops working in it as well.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { MOD_SHARE_KEY_HEADER } from "@d2/socket-contract";
import { config } from "../config.js";

/** Name of the cookie that carries a share key to the page's picture requests. */
export const SHARE_KEY_COOKIE = "d2_mod_share";

type Req = Pick<FastifyRequest, "headers">;

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/**
 * True when `given` is one of the configured keys. Compared as sha256 digests in constant
 * time, so neither the key's length nor its prefix leaks through timing.
 */
function isKey(given: string | undefined, keys: readonly string[]): boolean {
  if (keys.length === 0 || !given || given.length > 256) return false;
  const g = digest(given);
  let ok = false;
  for (const k of keys) if (timingSafeEqual(g, digest(k))) ok = true;
  return ok;
}

function headerKey(req: Req): string | undefined {
  const raw = req.headers[MOD_SHARE_KEY_HEADER];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** The value of one cookie of the request, or undefined. */
function cookieKey(req: Req): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of (Array.isArray(raw) ? raw.join(";") : raw).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== SHARE_KEY_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** True when the request's header carries a configured key: the page's own requests. */
export function headerHasShareKey(req: Req, keys: readonly string[] = config.MOD_SHARE_KEYS): boolean {
  return isKey(headerKey(req), keys);
}

/** True when the request carries a configured key, in the header or in the cookie. */
export function hasShareKey(req: Req, keys: readonly string[] = config.MOD_SHARE_KEYS): boolean {
  return isKey(headerKey(req), keys) || isKey(cookieKey(req), keys);
}

/** The Set-Cookie value that hands the request's header key to the page's picture requests. */
export function shareKeyCookie(req: Req, basePath: string = config.BASE_PATH): string {
  return `${SHARE_KEY_COOKIE}=${encodeURIComponent(headerKey(req) ?? "")}; Path=${basePath}/; HttpOnly; SameSite=Strict`;
}
