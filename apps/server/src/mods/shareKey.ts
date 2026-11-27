/**
 * Share keys of the mod comparison: a secret link (`?mods#key=<key>`) whose page sends the
 * key in the `x-mod-share-key` header. A request with a valid key also sees the hidden mods
 * and gets their full tables (see config.MOD_SHARE_KEYS, ModRegistry.isPrivateFile).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { MOD_SHARE_KEY_HEADER } from "@d2/socket-contract";
import { config } from "../config.js";

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/**
 * True when the request carries one of the configured share keys. Compared as sha256
 * digests in constant time, so neither the key's length nor its prefix leaks through timing.
 */
export function hasShareKey(req: Pick<FastifyRequest, "headers">, keys: readonly string[] = config.MOD_SHARE_KEYS): boolean {
  if (keys.length === 0) return false;
  const raw = req.headers[MOD_SHARE_KEY_HEADER];
  const given = Array.isArray(raw) ? raw[0] : raw;
  if (!given || given.length > 256) return false;
  const g = digest(given);
  let ok = false;
  for (const k of keys) if (timingSafeEqual(g, digest(k))) ok = true;
  return ok;
}
