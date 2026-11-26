/**
 * Campaigns (custom sagas): an install saga is listed with its missions, a mission opens as a
 * map read out of the saga, an own copy can be changed by its owner only, a .csg upload
 * becomes an own campaign, and an export packs the missions with the caller's edits.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { REST, type CampaignEntry, type CampaignList, type ScenarioEntry } from "@d2/socket-contract";
import { createBlankMap, parseHeaderOnly, readCampaign, writeCampaign } from "@d2/sg-parser";
import { emptyProject, pushCommit } from "@d2/map-edit";
import { buildApp } from "../src/app";
import { config } from "../src/config";
import { installScenarioFixture } from "./scenarioFixture";

let app: FastifyInstance;
let restore: (() => void) | undefined;
const A = "campaign-owner-aaaa";
const B = "campaign-stranger-bb";

const first = createBlankMap({ size: 48, name: "Первая", races: ["empire", "undead"] });
const second = createBlankMap({ size: 48, name: "Без Империи", races: ["undead"] });
const sagaBytes = writeCampaign({
  header: { name: "Тестовая сага", description: "Описание", author: "Автор", race: "empire", heroLevel: 2 },
  missions: [
    { name: "first.sg", bytes: first },
    { name: "second.sg", bytes: second },
  ],
});

const as = (who?: string) => (who ? { "x-client-id": who } : {});

async function list(who?: string): Promise<CampaignEntry[]> {
  const res = await app.inject({ method: "GET", url: REST.campaigns, headers: as(who) });
  expect(res.statusCode).toBe(200);
  return (res.json() as CampaignList).campaigns;
}

function multipart(bytes: Uint8Array, filename: string): { headers: Record<string, string>; payload: Buffer } {
  const boundary = "----campaign-upload";
  const CRLF = String.fromCharCode(13, 10);
  const head = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    "Content-Type: application/octet-stream",
    "",
    "",
  ].join(CRLF);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(head), Buffer.from(bytes), Buffer.from(`${CRLF}--${boundary}--${CRLF}`)]),
  };
}

beforeAll(async () => {
  const fixture = await installScenarioFixture();
  restore = fixture.restore;
  const campaignDir = join(dirname(config.UPLOAD_DIR), "install-scenarios", "Campaign");
  await mkdir(campaignDir, { recursive: true });
  await writeFile(join(campaignDir, "Test.csg"), sagaBytes);
  ({ app } = await buildApp());
  await app.ready();
});

afterAll(async () => {
  try {
    if (app) await app.close();
  } finally {
    restore?.();
  }
});

describe("install sagas", () => {
  it("are listed with their missions, which open as maps but stay out of the map list", async () => {
    const [saga] = (await list()).filter((c) => c.source === "install");
    expect(saga).toBeDefined();
    expect(saga!.header).toEqual({
      name: "Тестовая сага",
      description: "Описание",
      author: "Автор",
      race: "empire",
      heroLevel: 2,
    });
    expect(saga!.editable).toBe(false);
    expect(saga!.fileName).toBe("Test.csg");
    expect(saga!.missions.map((m) => [m.fileName, m.title, m.mapSize])).toEqual([
      ["first.sg", "Первая", 48],
      ["second.sg", "Без Империи", 48],
    ]);

    const mapId = saga!.missions[0]!.mapId!;
    const doc = await app.inject({ method: "GET", url: REST.map(mapId) });
    expect(doc.statusCode).toBe(200);
    expect(doc.json().header.name).toBe("Первая");
    const raw = await app.inject({ method: "GET", url: REST.mapRaw(mapId) });
    expect(Buffer.from(raw.rawPayload).equals(Buffer.from(first))).toBe(true);

    const maps = await app.inject({ method: "GET", url: REST.scenarios });
    expect((maps.json() as ScenarioEntry[]).some((e) => e.id === mapId)).toBe(false);
  });

  it("report a mission the game could not play", async () => {
    const [saga] = (await list()).filter((c) => c.source === "install");
    const res = await app.inject({ method: "GET", url: REST.campaign(saga!.id) });
    const detail = res.json() as CampaignEntry;
    expect(detail.missions.map((m) => m.issues)).toEqual([[], ["no-seat"]]);
  });

  it("change only as an own copy", async () => {
    const [saga] = (await list()).filter((c) => c.source === "install");
    const put = await app.inject({
      method: "PUT",
      url: REST.campaign(saga!.id),
      headers: as(A),
      payload: { header: { ...saga!.header, race: "empire" }, missions: [] },
    });
    expect(put.statusCode).toBe(404);
    expect(put.json().error).toContain("копии");
  });
});

describe("own campaigns", () => {
  let own: CampaignEntry;

  it("a copy of a saga is the caller's, listed only to them", async () => {
    const [saga] = (await list()).filter((c) => c.source === "install");
    const res = await app.inject({ method: "POST", url: REST.campaignCopy(saga!.id), headers: as(A) });
    expect(res.statusCode).toBe(201);
    own = res.json() as CampaignEntry;
    expect(own.source).toBe("own");
    expect(own.editable).toBe(true);
    expect(own.missions.map((m) => m.mapId)).toEqual(saga!.missions.map((m) => m.mapId));
    expect((await list(A)).some((c) => c.id === own.id)).toBe(true);
    expect((await list(B)).some((c) => c.id === own.id)).toBe(false);
  });

  it("its owner reorders it and adds a new map; anyone else is refused", async () => {
    const made = await app.inject({
      method: "POST",
      url: REST.mapNew,
      headers: as(A),
      payload: { size: 48, name: "Третья", races: ["empire"] },
    });
    const third = (made.json() as { id: string }).id;
    const missions = [own.missions[1]!.mapId!, own.missions[0]!.mapId!, third];
    const body = { header: { ...own.header, name: "Своя сага", race: "empire" }, missions };
    const stranger = await app.inject({ method: "PUT", url: REST.campaign(own.id), headers: as(B), payload: body });
    expect(stranger.statusCode).toBe(403);
    const res = await app.inject({ method: "PUT", url: REST.campaign(own.id), headers: as(A), payload: body });
    expect(res.statusCode).toBe(200);
    own = res.json() as CampaignEntry;
    expect(own.header.name).toBe("Своя сага");
    expect(own.missions.map((m) => m.title)).toEqual(["Без Империи", "Первая", "Третья"]);
    // a header the game cannot take is refused
    const long = await app.inject({
      method: "PUT",
      url: REST.campaign(own.id),
      headers: as(A),
      payload: { ...body, header: { ...body.header, name: "x".repeat(33) } },
    });
    expect(long.statusCode).toBe(400);
  });

  it("exports as a .csg with the caller's edits baked in", async () => {
    const mapId = own.missions[1]!.mapId!;
    const project = pushCommit(emptyProject(mapId), [{ kind: "setScenarioInfo", fields: { name: "Переименована" } }]);
    const res = await app.inject({
      method: "POST",
      url: REST.campaignExport(own.id),
      headers: as(A),
      payload: { projects: { [mapId]: project } },
    });
    expect(res.statusCode).toBe(200);
    const saga = readCampaign(new Uint8Array(res.rawPayload));
    expect(saga.header.name).toBe("Своя сага");
    expect(saga.header.race).toBe("empire");
    expect(saga.missions.map((m) => m.name)).toEqual(["second.sg", "first.sg", "Tretya.sg"]);
    expect(saga.missions.map((m) => parseHeaderOnly(m.bytes).header.name)).toEqual([
      "Без Империи",
      "Переименована",
      "Третья",
    ]);
  });

  it("a .csg upload becomes an own campaign of own maps", async () => {
    const up = multipart(sagaBytes, "Test.csg");
    const res = await app.inject({
      method: "POST",
      url: REST.campaignUpload,
      headers: { ...up.headers, ...as(B) },
      payload: up.payload,
    });
    expect(res.statusCode).toBe(201);
    const c = res.json() as CampaignEntry;
    expect(c.source).toBe("own");
    expect(c.missions.map((m) => [m.fileName, m.title])).toEqual([
      ["first.sg", "Первая"],
      ["second.sg", "Без Империи"],
    ]);
    const maps = (await app.inject({ method: "GET", url: REST.scenarios, headers: as(B) })).json() as ScenarioEntry[];
    for (const m of c.missions) expect(maps.some((e) => e.id === m.mapId && e.source === "upload")).toBe(true);

    const notSaga = multipart(first, "x.csg");
    const bad = await app.inject({
      method: "POST",
      url: REST.campaignUpload,
      headers: { ...notSaga.headers, ...as(B) },
      payload: notSaga.payload,
    });
    expect(bad.statusCode).toBe(415);
  });

  it("its owner deletes it; the maps stay", async () => {
    const mapId = own.missions[2]!.mapId!;
    const res = await app.inject({ method: "DELETE", url: REST.campaign(own.id), headers: as(A) });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: REST.campaign(own.id) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: REST.mapMeta(mapId) })).statusCode).toBe(200);
  });
});
