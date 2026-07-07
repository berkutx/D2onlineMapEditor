/**
 * POST /api/maps/upload — optional Stage-1 ingest of a user `.sg` file.
 *
 * Guards: 32 MiB cap (enforced by @fastify/multipart limits + a recheck) and the
 * `D2EESFISIG` magic. Accepted files are stored as var/uploads/<id>.sg and
 * registered with the MapStore so they appear in /api/scenarios and are loadable
 * at /api/maps/:id.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { REST } from "@d2/socket-contract";
import { config } from "../config.js";
import { clientIdOf } from "./routes.scenarios.js";
import type { MapStore } from "../maps/mapStore.js";

const MAGIC = Buffer.from(config.SG_MAGIC, "ascii");

export async function registerUploadRoute(
  app: FastifyInstance,
  store: MapStore,
): Promise<void> {
  app.post(REST.upload, async (req, reply) => {
    const file = await req.file({
      limits: { fileSize: config.UPLOAD_MAX_BYTES, files: 1 },
    });
    if (!file) {
      return reply.code(400).send({ error: "no file uploaded" });
    }

    const buf = await file.toBuffer();
    if (file.file.truncated || buf.length > config.UPLOAD_MAX_BYTES) {
      return reply.code(413).send({ error: "file exceeds 32MiB cap" });
    }
    if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
      return reply.code(415).send({ error: "not a Disciples 2 .sg scenario" });
    }

    const owner = clientIdOf(req);
    await mkdir(config.UPLOAD_DIR, { recursive: true });
    // Deterministic per (owner, content) filename → ONE write, ONE registration. Re-uploading the
    // same file by the same visitor is idempotent (same id, no duplicate); a different visitor gets
    // their OWN copy (owner keyed into the hash → no cross-user ownership collision on identical
    // content). Content+owner hash is a server-private filename; the public id stays base32(sha1
    // (realpath)). (Replaces the old pending.sg two-step, which left a ghost duplicate entry.)
    const key = createHash("sha1").update(owner ?? "").update("\0").update(buf).digest("hex").slice(0, 32);
    const finalPath = join(config.UPLOAD_DIR, `${key}.sg`);
    await writeFile(finalPath, buf);
    const rec = await store.registerUpload(finalPath, owner);
    return reply.code(201).send({ id: rec.id });
  });
}
