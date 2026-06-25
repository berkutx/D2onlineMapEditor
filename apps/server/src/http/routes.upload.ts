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
import type { FastifyInstance } from "fastify";
import { REST } from "@d2/socket-contract";
import { config } from "../config.js";
import { idForPath } from "../ingest/idCodec.js";
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

    await mkdir(config.UPLOAD_DIR, { recursive: true });
    // id is content-addressed via its eventual realpath; pre-compute by target
    const target = join(config.UPLOAD_DIR, "pending.sg");
    await writeFile(target, buf);
    const rec = await store.registerUpload(target);

    // rename to the stable id-based name so future scans are deterministic
    const finalPath = join(config.UPLOAD_DIR, `${idForPath(rec.realPath)}.sg`);
    if (finalPath !== rec.realPath) {
      await writeFile(finalPath, buf);
      const finalRec = await store.registerUpload(finalPath);
      return reply.code(201).send({ id: finalRec.id });
    }
    return reply.code(201).send({ id: rec.id });
  });
}
