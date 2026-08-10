/**
 * Temporary external handoff: POST /api/maps/preview.
 *
 * A service sends one multipart `.sg` and may supply the original browser IP for rate limiting.
 * Authentication is intentionally deferred for the first integration release. The resulting
 * capability URL is read-only and has a fixed one-hour lifetime; views never extend it.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { parseScenario } from "@d2/sg-parser";
import { REST } from "@d2/socket-contract";
import { config } from "../config.js";
import type { MapStore } from "../maps/mapStore.js";

const MAGIC = Buffer.from(config.SG_MAGIC, "ascii");

export interface RateTicket {
  key: string;
  at: number;
}

/** Small in-process sliding-window limiter. The editor runs as a single container/process;
 * keeping only timestamps avoids writing visitor IP addresses to disk or logs. */
export class PreviewUploadLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = config.PREVIEW_UPLOAD_LIMIT,
    private readonly windowMs = config.PREVIEW_RATE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): { ok: true; ticket: RateTicket } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1, recent[0]! + this.windowMs - now) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true, ticket: { key, at: now } };
  }

  /** A disk/registry failure did not create a preview and therefore must not spend quota. */
  refund(ticket: RateTicket): void {
    const recent = this.hits.get(ticket.key);
    if (!recent) return;
    const index = recent.lastIndexOf(ticket.at);
    if (index >= 0) recent.splice(index, 1);
    if (recent.length) this.hits.set(ticket.key, recent);
    else this.hits.delete(ticket.key);
  }
}

function clientIp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Require one canonical value; accepting a forwarding chain would make the key ambiguous.
  const value = raw.trim();
  if (!value || value.length > 128 || value.includes(",") || /[\r\n\0]/.test(value)) return null;
  const normalized = value.startsWith("::ffff:") ? value.slice(7) : value;
  return isIP(normalized) ? normalized : null;
}

const isNoSpace = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error &&
  ((error as { code?: unknown }).code === "ENOSPC" || (error as { code?: unknown }).code === "EDQUOT");

const isUploadTooLarge = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error &&
  ((error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE" ||
    (error as { code?: unknown }).code === "FST_FILES_LIMIT");

export async function registerPreviewRoute(
  app: FastifyInstance,
  store: MapStore,
  options: {
    ttlMs?: number;
    limiter?: PreviewUploadLimiter;
    now?: () => number;
  } = {},
): Promise<void> {
  const ttlMs = options.ttlMs ?? config.PREVIEW_TTL_MS;
  const now = options.now ?? Date.now;
  const limiter = options.limiter ?? new PreviewUploadLimiter();
  type PreviewResult = { id: string; expiresAt: number; sha256: string; path: string };
  // Collapse a burst of simultaneous POSTs for the same tournament save into one disk write.
  const inFlight = new Map<string, Promise<PreviewResult>>();
  const resultFor = (id: string, expiresAt: number, sha256: string): PreviewResult => ({
    id,
    expiresAt,
    sha256,
    // The capability id is sufficient. Read-only is server metadata, never a client-controlled
    // query flag that could look like a switch the viewer is able to disable.
    path: `${config.BASE_PATH || ""}/?map=${encodeURIComponent(id)}`,
  });

  app.post(REST.previewUpload, async (req, reply) => {
    // Until service authentication is introduced, direct callers fall back to their network
    // address. The external service should pass the original visitor address; that header is
    // necessarily best-effort while this endpoint is public.
    const claimedIp = req.headers["x-preview-client-ip"];
    const ip = claimedIp === undefined ? clientIp(req.ip) : clientIp(claimedIp);
    if (!ip) return reply.code(400).send({ error: "preview_client_ip_invalid" });

    let file;
    try {
      file = await req.file({ limits: { fileSize: config.UPLOAD_MAX_BYTES, files: 1 } });
    } catch (error) {
      if (isUploadTooLarge(error)) {
        return reply.code(413).send({ error: "file_too_large", maxBytes: config.UPLOAD_MAX_BYTES });
      }
      throw error;
    }
    if (!file) return reply.code(400).send({ error: "no_file_uploaded" });
    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch (error) {
      if (isUploadTooLarge(error)) {
        return reply.code(413).send({ error: "file_too_large", maxBytes: config.UPLOAD_MAX_BYTES });
      }
      throw error;
    }
    if (file.file.truncated || buf.length > config.UPLOAD_MAX_BYTES) {
      return reply.code(413).send({ error: "file_too_large", maxBytes: config.UPLOAD_MAX_BYTES });
    }
    if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
      return reply.code(415).send({ error: "not_a_disciples_sg" });
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");

    // Existing capability sharing already handles any number of spectators. Repeated POSTs
    // merely recover that same active id; they neither create a file nor spend the IP quota.
    const cached = await store.findPreviewByHash(sha256);
    if (cached) return reply.code(200).send({ ...resultFor(cached.id, cached.expiresAt, sha256), cacheHit: true });
    const pending = inFlight.get(sha256);
    if (pending) {
      try {
        return reply.code(200).send({ ...(await pending), cacheHit: true });
      } catch (error) {
        return reply.code(isNoSpace(error) ? 507 : 500).send({
          error: isNoSpace(error) ? "preview_storage_full" : "preview_store_failed",
        });
      }
    }
    try {
      // Fail before spending quota or touching disk when a magic-prefixed but malformed save is
      // supplied. Full parse is acceptable for the normal 1–2 MiB files and is secret-gated.
      parseScenario(new Uint8Array(buf));
    } catch (error) {
      return reply.code(422).send({
        error: "invalid_sg",
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const allowance = limiter.consume(ip);
    if (!allowance.ok) {
      const retryAfter = Math.max(1, Math.ceil(allowance.retryAfterMs / 1000));
      return reply.header("retry-after", String(retryAfter)).code(429).send({
        error: "preview_upload_rate_limited",
        limit: config.PREVIEW_UPLOAD_LIMIT,
        retryAfterSeconds: retryAfter,
      });
    }

    // A new active lifetime gets a new capability path. The content hash deduplicates only
    // while that record is alive, so an old link cannot unexpectedly revive months later if
    // the exact same save is uploaded again.
    const stem = `preview-${sha256.slice(0, 16)}-${randomUUID()}`;
    const tempPath = join(config.UPLOAD_DIR, `${stem}.tmp`);
    const finalPath = join(config.UPLOAD_DIR, `${stem}.sg`);
    const create = (async (): Promise<PreviewResult> => {
      await mkdir(config.UPLOAD_DIR, { recursive: true });
      await writeFile(tempPath, buf, { flag: "wx" });
      await rename(tempPath, finalPath);
      const expiresAt = now() + ttlMs;
      const rec = await store.registerUpload(finalPath, undefined, {
        previewExpiresAtMs: expiresAt,
        previewContentHash: sha256,
      });
      return resultFor(rec.id, expiresAt, sha256);
    })();
    inFlight.set(sha256, create);
    try {
      return reply.code(201).send({ ...(await create), cacheHit: false });
    } catch (error) {
      limiter.refund(allowance.ticket);
      await rm(tempPath, { force: true }).catch(() => {});
      await rm(finalPath, { force: true }).catch(() => {});
      return reply.code(isNoSpace(error) ? 507 : 500).send({
        error: isNoSpace(error) ? "preview_storage_full" : "preview_store_failed",
      });
    } finally {
      if (inFlight.get(sha256) === create) inFlight.delete(sha256);
    }
  });
}
