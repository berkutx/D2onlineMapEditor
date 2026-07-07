/**
 * POST /api/maps/upload — user-provided `.sg` maps are PRIVATE: listed only to their owner
 * (x-client-id), openable by anyone holding the id link (capability / share), permanent (the
 * ephemeral sweeper never touches them), and re-uploading the same file is idempotent with no
 * ghost duplicate entry (the pending.sg two-step is gone). Non-.sg payloads are rejected.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { REST, type ScenarioEntry } from "@d2/socket-contract";
import { buildApp } from "../src/app";
import { MapStore } from "../src/maps/mapStore";

let app: FastifyInstance;
let sgBytes: Buffer; // a real .sg pulled from the scanned install, reused as the upload payload

const OWNER = "up-owner-cccc";
const STRANGER = "up-stranger-dddd";

/** Minimal multipart/form-data body carrying ONE file field (for app.inject). */
function multipart(filename: string, bytes: Buffer): { body: Buffer; contentType: string } {
  const boundary = "----d2test" + bytes.length.toString(36);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function upload(bytes: Buffer, clientId?: string, filename = "mine.sg") {
  const { body, contentType } = multipart(filename, bytes);
  return app.inject({
    method: "POST",
    url: REST.upload,
    headers: { "content-type": contentType, ...(clientId ? { "x-client-id": clientId } : {}) },
    payload: body,
  });
}

async function listFor(clientId?: string): Promise<ScenarioEntry[]> {
  const res = await app.inject({
    method: "GET",
    url: REST.scenarios,
    headers: clientId ? { "x-client-id": clientId } : {},
  });
  return res.json() as ScenarioEntry[];
}

beforeAll(async () => {
  ({ app } = await buildApp());
  await app.ready();
  // reuse a REAL install scenario's bytes as the upload payload (valid magic + parseable header)
  const install = (await listFor()).filter((e) => e.source === "install");
  expect(install.length).toBeGreaterThan(0);
  const raw = await app.inject({ method: "GET", url: REST.mapRaw(install[0]!.id) });
  sgBytes = raw.rawPayload;
});

describe("POST /api/maps/upload — private user maps", () => {
  it("registers a private, owner-scoped map: listed to owner only, open by id (share link)", async () => {
    const res = await upload(sgBytes, OWNER);
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;

    expect((await listFor(OWNER)).some((e) => e.id === id && e.source === "upload")).toBe(true);
    expect((await listFor(STRANGER)).some((e) => e.id === id)).toBe(false);
    expect((await listFor()).some((e) => e.id === id)).toBe(false);

    // by-id access stays open for anyone with the link (capability model)
    const byId = await app.inject({ method: "GET", url: REST.map(id), headers: { "x-client-id": STRANGER } });
    expect(byId.statusCode).toBe(200);
  });

  it("re-upload by same owner = same id (idempotent, no pending.sg ghost); other owner = own copy", async () => {
    const a = (await upload(sgBytes, OWNER)).json() as { id: string };
    const b = (await upload(sgBytes, OWNER)).json() as { id: string };
    expect(b.id).toBe(a.id); // idempotent — no duplicate

    // exactly ONE owner entry for that id, and no "pending.sg" ghost leaked into the listing
    expect((await listFor(OWNER)).filter((e) => e.id === a.id).length).toBe(1);
    expect((await listFor(OWNER)).some((e) => e.fileName === "pending.sg")).toBe(false);

    // a different visitor uploading identical content gets their OWN copy (no ownership collision)
    const c = (await upload(sgBytes, STRANGER)).json() as { id: string };
    expect(c.id).not.toBe(a.id);
    expect((await listFor(STRANGER)).some((e) => e.id === c.id)).toBe(true);
    expect((await listFor(OWNER)).some((e) => e.id === c.id)).toBe(false);
  });

  it("is PERMANENT — the ephemeral sweeper never removes an upload", async () => {
    const id = ((await upload(sgBytes, OWNER)).json() as { id: string }).id;
    const store = new MapStore(); // fresh instance reading registry.json
    await new Promise((r) => setTimeout(r, 5));
    await store.sweepEphemeral(0); // sweep everything past a 0ms TTL
    expect(await store.resolve(id)).toBeTruthy(); // the upload survives (it is not ephemeral)
  });

  it("rejects a non-.sg payload (415)", async () => {
    const res = await upload(Buffer.from("NOT A SCENARIO — no magic here"), OWNER);
    expect(res.statusCode).toBe(415);
  });
});
