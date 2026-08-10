/** Public one-hour preview handoff: content-addressed sharing, hard read-only policy and
 * per-originating-IP limit for NEW unique uploads. */

import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createBlankMap } from "@d2/sg-parser";
import { emptyProject } from "@d2/map-edit";
import { REST } from "@d2/socket-contract";
import { buildApp } from "../src/app";
import { config } from "../src/config";
import { MapStore } from "../src/maps/mapStore";
import { PreviewUploadLimiter } from "../src/http/routes.preview";

let app: FastifyInstance;

function sg(name: string): Buffer {
  return Buffer.from(createBlankMap({ size: 48, fill: "default", name, races: ["empire"] }));
}

function multipart(filename: string, bytes: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----preview-${filename.replace(/\W/g, "")}-${bytes.length}`;
  return {
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n",
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function upload(bytes: Buffer, ip?: string) {
  const form = multipart("match.sg", bytes);
  return app.inject({
    method: "POST",
    url: REST.previewUpload,
    headers: {
      "content-type": form.contentType,
      ...(ip ? { "x-preview-client-ip": ip } : {}),
    },
    payload: form.body,
  });
}

beforeAll(async () => {
  ({ app } = await buildApp());
  await app.ready();
});

describe("POST /api/maps/preview", () => {
  it("is temporarily public, with an optional original-client IP", async () => {
    const bytes = sg("preview-public");
    expect((await upload(bytes)).statusCode).toBe(201);
    expect((await upload(bytes, "203.0.113.1")).statusCode).toBe(200);
    expect((await upload(bytes, "not-an-ip")).statusCode).toBe(400);
  });

  it("stores one content-addressed map and reuses its capability for every spectator", async () => {
    const bytes = sg("championship-final");
    const first = await upload(bytes, "203.0.113.10");
    expect(first.statusCode).toBe(201);
    const created = first.json() as {
      id: string; expiresAt: number; sha256: string; path: string; cacheHit: boolean;
    };
    expect(created.cacheHit).toBe(false);
    expect(created.path).toContain(`map=${created.id}`);
    expect(created.path).not.toContain("preview=");
    expect(created.sha256).toMatch(/^[a-f0-9]{64}$/);

    const second = await upload(bytes, "198.51.100.88");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      id: created.id,
      expiresAt: created.expiresAt,
      sha256: created.sha256,
      cacheHit: true,
    });

    // Content sharing survives a container restart: a fresh store restores the hash and
    // returns the original capability without extending its fixed deadline.
    expect(await new MapStore().findPreviewByHash(created.sha256)).toEqual({
      id: created.id,
      expiresAt: created.expiresAt,
    });

    const meta = await app.inject({ method: "GET", url: REST.mapMeta(created.id) });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({ id: created.id, readOnly: true, expiresAt: created.expiresAt });
    expect((await app.inject({ method: "GET", url: REST.map(created.id) })).statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: REST.scenarios });
    expect((list.json() as { id: string }[]).some((entry) => entry.id === created.id)).toBe(false);

    // The policy is server-side: hiding buttons alone cannot recover bytes or create a writable copy.
    expect((await app.inject({ method: "GET", url: REST.mapRaw(created.id) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: REST.mapClone(created.id), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({
      method: "GET",
      url: REST.mapProject(created.id),
      headers: { "x-client-id": "viewer" },
    })).statusCode).toBe(403);
    const project = emptyProject(created.id);
    expect((await app.inject({
      method: "PUT",
      url: REST.mapProject(created.id),
      headers: { "x-client-id": "viewer", "content-type": "application/json" },
      payload: project,
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: REST.mapExport(created.id),
      headers: { "content-type": "application/json" },
      payload: project,
    })).statusCode).toBe(403);
  });

  it("allows five new unique maps per IP/hour while cache hits remain free", async () => {
    const ip = "203.0.113.55";
    const created: Buffer[] = [];
    for (let i = 0; i < 5; i++) {
      const bytes = sg(`rate-${i}`);
      created.push(bytes);
      expect((await upload(bytes, ip)).statusCode).toBe(201);
    }
    const denied = await upload(sg("rate-six"), ip);
    expect(denied.statusCode).toBe(429);
    expect(denied.headers["retry-after"]).toBeTruthy();
    // Many viewers (or a retrying external service) can recover an existing shared id even
    // after the originating IP used its quota; no extra file is created.
    const hit = await upload(created[0]!, ip);
    expect(hit.statusCode).toBe(200);
    expect((hit.json() as { cacheHit: boolean }).cacheHit).toBe(true);
  });
});

describe("preview expiry and limiter window", () => {
  it("physically removes an expired preview and its registry entry", async () => {
    const bytes = sg("already-expired");
    await mkdir(config.UPLOAD_DIR, { recursive: true });
    const file = join(config.UPLOAD_DIR, "expired-preview.sg");
    await writeFile(file, bytes);
    const store = new MapStore();
    const rec = await store.registerUpload(file, undefined, {
      previewExpiresAtMs: Date.now() - 1,
      previewContentHash: "f".repeat(64),
    });
    expect(await store.resolve(rec.id)).toBeUndefined();
    await expect(access(file)).rejects.toBeTruthy();
    expect(await new MapStore().resolve(rec.id)).toBeUndefined();
  });

  it("uses a sliding one-hour window", () => {
    let now = 10_000;
    const limiter = new PreviewUploadLimiter(5, 3_600_000, () => now);
    for (let i = 0; i < 5; i++) expect(limiter.consume("ip").ok).toBe(true);
    expect(limiter.consume("ip").ok).toBe(false);
    now += 3_600_001;
    expect(limiter.consume("ip").ok).toBe(true);
  });
});
