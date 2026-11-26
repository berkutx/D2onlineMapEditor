/**
 * Campaigns — the game's custom sagas (`.csg`), see REST.campaigns in @d2/socket-contract.
 *
 *  - install sagas: the `.csg` files of the scenario folders (campaigns/campaignScanner); each
 *    mission opens as a map of its own, read out of the saga;
 *  - own campaigns: made in the editor, copied or uploaded (campaigns/userCampaigns) — a
 *    header and the mission maps' ids. Listed only to the owner, open to anyone with the id.
 *
 * An export builds every mission with the caller's edits (the project sent along, else the one
 * saved on the server, else the map as it is), validates each like a map export and packs them
 * into a `.csg` the game opens.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  REST,
  CampaignInput,
  type CampaignEntry,
  type CampaignMissionInfo,
  type CampaignRaceKey,
} from "@d2/socket-contract";
import {
  CAMPAIGN_AUTHOR_MAX,
  CAMPAIGN_DESCRIPTION_MAX,
  CAMPAIGN_NAME_MAX,
  campaignMissionFileName,
  campaignMissionNameProblem,
  encodeCp1251,
  readCampaign,
  writeCampaign,
} from "@d2/sg-parser";
import { EditorProject, activeOps, campaignMissionIssues } from "@d2/map-edit";
import { config } from "../config.js";
import { clientIdOf } from "./routes.scenarios.js";
import { buildAndValidateForMod, savedProjectPath } from "./routes.maps.js";
import type { MapStore } from "../maps/mapStore.js";
import type { ModRegistry } from "../mods/modRegistry.js";
import type { InstallCampaign } from "../campaigns/campaignScanner.js";
import {
  createUserCampaign,
  getUserCampaign,
  listUserCampaigns,
  removeUserCampaign,
  updateUserCampaign,
  type StoredCampaign,
} from "../campaigns/userCampaigns.js";

/** Why a header cannot go into a saga, or null. */
function headerProblem(h: CampaignInput["header"]): string | null {
  const len = (s: string): number => encodeCp1251(s).length;
  try {
    if (!h.name.trim()) return "у кампании должно быть название";
    if (len(h.name) > CAMPAIGN_NAME_MAX) return `название длиннее ${CAMPAIGN_NAME_MAX} знаков`;
    if (len(h.description) > CAMPAIGN_DESCRIPTION_MAX) return `описание длиннее ${CAMPAIGN_DESCRIPTION_MAX} знаков`;
    if (len(h.author) > CAMPAIGN_AUTHOR_MAX) return `имя автора длиннее ${CAMPAIGN_AUTHOR_MAX} знаков`;
  } catch {
    return "в тексте есть знаки, которых нет в кодировке игры (Windows-1251)";
  }
  if (h.race === "neutral") return "за нейтралов сагу не сыграть — выберите расу";
  if (!Number.isInteger(h.heroLevel) || h.heroLevel < 1 || h.heroLevel > 99) return "уровень героя: от 1 до 99";
  return null;
}

const fileNameOf = (name: string): string => (name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "campaign") + ".csg";

export async function registerCampaignRoutes(
  app: FastifyInstance,
  store: MapStore,
  mods: ModRegistry,
): Promise<void> {
  const installById = async (id: string): Promise<InstallCampaign | undefined> =>
    (await store.installCampaigns()).find((c) => c.id === id);

  /** A mission of an own campaign, as a listing shows it (the map's name and size). */
  const ownMission = async (mapId: string, fileNames?: Record<string, string>): Promise<CampaignMissionInfo> => {
    try {
      const loaded = await store.getMap(mapId);
      if (loaded) {
        const fileName = fileNames?.[mapId] ?? `${loaded.doc.header.name || mapId}.sg`;
        return { mapId, fileName, title: loaded.doc.header.name || fileName, mapSize: loaded.doc.size };
      }
    } catch {
      /* unreadable: reported below */
    }
    return { fileName: fileNames?.[mapId] ?? mapId, title: "?", issues: ["unreadable"] };
  };

  /** Add the game-breaking issues of every mission (one full parse each, cached by the store). */
  const withIssues = async (
    missions: CampaignMissionInfo[],
    race: CampaignRaceKey | null,
  ): Promise<CampaignMissionInfo[]> =>
    Promise.all(
      missions.map(async (m, index) => {
        if (!m.mapId) return { ...m, issues: ["unreadable" as const] };
        try {
          const loaded = await store.getMap(m.mapId);
          if (!loaded) return { ...m, issues: ["unreadable" as const] };
          return { ...m, issues: campaignMissionIssues(loaded.doc, race, index) };
        } catch {
          return { ...m, issues: ["unreadable" as const] };
        }
      }),
    );

  const entryOfInstall = async (c: InstallCampaign, detail: boolean): Promise<CampaignEntry> => {
    const missions: CampaignMissionInfo[] = c.missions.map((m) => ({
      ...(m.mapId ? { mapId: m.mapId } : {}),
      fileName: m.fileName,
      title: m.title,
      ...(m.mapSize !== undefined ? { mapSize: m.mapSize } : {}),
      ...(m.mapId ? {} : { issues: ["unreadable" as const] }),
    }));
    return {
      id: c.id,
      source: "install",
      header: c.header,
      missions: detail ? await withIssues(missions, c.header.race) : missions,
      // a hidden mod is not named: its missions open on the mods visitors are shown
      ...(c.modId && !mods.isHidden(c.modId) ? { mod: c.modId } : {}),
      fileName: c.fileName,
      editable: false,
    };
  };

  /** The mod a campaign of own maps is played in: its first mission's. */
  const modOfMissions = async (missions: readonly string[]): Promise<string | undefined> => {
    if (!missions[0]) return undefined;
    try {
      return (await store.modOf(missions[0]))?.id;
    } catch {
      return undefined;
    }
  };

  const entryOfOwn = async (c: StoredCampaign, viewer: string | undefined, detail: boolean): Promise<CampaignEntry> => {
    const missions = await Promise.all(c.missions.map((id) => ownMission(id, c.fileNames)));
    const mod = await modOfMissions(c.missions);
    return {
      id: c.id,
      source: "own",
      header: c.header,
      missions: detail ? await withIssues(missions, c.header.race) : missions,
      ...(mod ? { mod } : {}),
      editable: viewer !== undefined && viewer === c.owner,
    };
  };

  /** Validate an own campaign's body: a header the game takes and missions that open. */
  const parseInput = async (body: unknown, reply: FastifyReply): Promise<CampaignInput | undefined> => {
    const parsed = CampaignInput.safeParse(body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid campaign", detail: parsed.error.message });
      return undefined;
    }
    const problem = headerProblem(parsed.data.header);
    if (problem) {
      reply.code(400).send({ error: problem });
      return undefined;
    }
    for (const id of parsed.data.missions) {
      const policy = await store.getAccessPolicy(id);
      if (!policy || policy.readOnly) {
        reply.code(400).send({ error: `карта ${id} не найдена или открыта только для просмотра` });
        return undefined;
      }
    }
    return { header: { ...parsed.data.header, name: parsed.data.header.name.trim() }, missions: parsed.data.missions };
  };

  const ownOf = async (id: string, req: FastifyRequest, reply: FastifyReply) => {
    const c = await getUserCampaign(id);
    if (!c) {
      reply.code(404).send({ error: (await installById(id)) ? "кампанию мода можно изменить только в копии" : "campaign not found" });
      return undefined;
    }
    if (c.owner !== clientIdOf(req)) {
      reply.code(403).send({ error: "only the owner can change this campaign" });
      return undefined;
    }
    return c;
  };

  app.get(REST.campaigns, async (req) => {
    const viewer = clientIdOf(req);
    // the sagas a hidden mod ships with are not listed (config HIDDEN_MODS); by id they open
    mods.refresh();
    const install = (await store.installCampaigns()).filter((c) => !mods.isHidden(c.modId));
    const own = viewer ? await listUserCampaigns(viewer) : [];
    return {
      campaigns: [
        ...(await Promise.all(own.map((c) => entryOfOwn(c, viewer, false)))),
        ...(await Promise.all(install.map((c) => entryOfInstall(c, false)))),
      ],
    };
  });

  app.get<{ Params: { id: string } }>(REST.campaign(":id"), async (req, reply) => {
    const own = await getUserCampaign(req.params.id);
    if (own) return entryOfOwn(own, clientIdOf(req), true);
    const install = await installById(req.params.id);
    if (install) return entryOfInstall(install, true);
    return reply.code(404).send({ error: "campaign not found" });
  });

  app.post(REST.campaigns, async (req, reply) => {
    const owner = clientIdOf(req);
    if (!owner) return reply.code(400).send({ error: "x-client-id required" });
    const input = await parseInput(req.body, reply);
    if (!input) return;
    return reply.code(201).send(await entryOfOwn(await createUserCampaign(owner, input), owner, true));
  });

  app.put<{ Params: { id: string } }>(REST.campaign(":id"), async (req, reply) => {
    const c = await ownOf(req.params.id, req, reply);
    if (!c) return;
    const input = await parseInput(req.body, reply);
    if (!input) return;
    return entryOfOwn(await updateUserCampaign(c, input), c.owner, true);
  });

  app.delete<{ Params: { id: string } }>(REST.campaign(":id"), async (req, reply) => {
    const c = await ownOf(req.params.id, req, reply);
    if (!c) return;
    await removeUserCampaign(c.id); // the mission maps stay: they are the visitor's maps
    return { ok: true };
  });

  // a copy of any campaign the caller can open, as their own: the same mission maps (so the
  // edits made to them carry over), a header and an order they may now change
  app.post<{ Params: { id: string } }>(REST.campaignCopy(":id"), async (req, reply) => {
    const owner = clientIdOf(req);
    if (!owner) return reply.code(400).send({ error: "x-client-id required" });
    const own = await getUserCampaign(req.params.id);
    const install = own ? undefined : await installById(req.params.id);
    if (!own && !install) return reply.code(404).send({ error: "campaign not found" });
    const header = own?.header ?? install!.header;
    if (!header.race) return reply.code(422).send({ error: "у саги неизвестная раса" });
    const missions = own
      ? own.missions
      : install!.missions.flatMap((m) => (m.mapId ? [m.mapId] : []));
    if (missions.length === 0) return reply.code(422).send({ error: "в саге нет миссий, которые открывает редактор" });
    const fileNames = own
      ? own.fileNames
      : Object.fromEntries(install!.missions.flatMap((m) => (m.mapId ? [[m.mapId, m.fileName]] : [])));
    const copy = await createUserCampaign(owner, { header: { ...header, race: header.race }, missions }, fileNames);
    return reply.code(201).send(await entryOfOwn(copy, owner, true));
  });

  // a .csg from the visitor's disk: its missions become their own maps (like an uploaded .sg),
  // all on the one mod most of them are detected for
  app.post(REST.campaignUpload, async (req, reply) => {
    const owner = clientIdOf(req);
    if (!owner) return reply.code(400).send({ error: "x-client-id required" });
    const file = await req.file({ limits: { fileSize: config.UPLOAD_MAX_BYTES, files: 1 } });
    if (!file) return reply.code(400).send({ error: "no file uploaded" });
    const buf = await file.toBuffer();
    if (file.file.truncated || buf.length > config.UPLOAD_MAX_BYTES) {
      return reply.code(413).send({ error: "file exceeds 32MiB cap" });
    }
    let saga;
    try {
      saga = readCampaign(new Uint8Array(buf));
    } catch {
      return reply.code(415).send({ error: "это не файл саги Disciples 2 (.csg)" });
    }
    if (saga.savePackage) return reply.code(415).send({ error: "это сохранённая игра, а не сага" });
    if (!saga.header.race || saga.header.race === "neutral") {
      return reply.code(415).send({ error: "у саги неизвестная раса" });
    }
    if (saga.missions.length === 0) return reply.code(415).send({ error: "в саге нет миссий" });
    if (saga.missions.some((m) => m.format !== "sg")) {
      return reply.code(415).send({ error: "миссии саги в старом формате (MidFile) — редактор их не открывает" });
    }
    await mkdir(config.UPLOAD_DIR, { recursive: true });
    const ids: string[] = [];
    const fileNames: Record<string, string> = {};
    for (const m of saga.missions) {
      const key = createHash("sha1").update(owner).update("\0").update(m.bytes).digest("hex").slice(0, 32);
      const path = join(config.UPLOAD_DIR, `${key}.sg`);
      await writeFile(path, m.bytes);
      const rec = await store.registerUpload(path, owner);
      ids.push(rec.id);
      fileNames[rec.id] = m.name;
    }
    const decided = await Promise.all(ids.map((id) => store.modOf(id)));
    const votes = new Map<string, number>();
    for (const d of decided) if (d?.source === "detected") votes.set(d.id, (votes.get(d.id) ?? 0) + 1);
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (best && mods.has(best)) {
      for (const [k, id] of ids.entries()) if (decided[k]?.id !== best) await store.setMod(id, best);
    }
    const header = { ...saga.header, race: saga.header.race };
    const c = await createUserCampaign(owner, { header, missions: ids }, fileNames);
    return reply.code(201).send(await entryOfOwn(c, owner, true));
  });

  app.post<{ Params: { id: string }; Body: { projects?: Record<string, unknown> } }>(
    REST.campaignExport(":id"),
    async (req, reply) => {
      const viewer = clientIdOf(req);
      const own = await getUserCampaign(req.params.id);
      const install = own ? undefined : await installById(req.params.id);
      if (!own && !install) return reply.code(404).send({ error: "campaign not found" });
      const header = own?.header ?? install!.header;
      if (!header.race || header.race === "neutral") return reply.code(422).send({ error: "у саги неизвестная раса" });
      const missions = own
        ? own.missions.map((mapId) => ({ mapId, fileName: own.fileNames?.[mapId] }))
        : install!.missions.map((m) => ({ mapId: m.mapId, fileName: m.fileName }));
      const sent = req.body?.projects ?? {};

      const taken = new Set<string>();
      const out: { name: string; bytes: Uint8Array }[] = [];
      for (const [index, m] of missions.entries()) {
        if (!m.mapId) return reply.code(422).send({ mission: index, error: "миссию в старом формате редактор не открывает" });
        const base = await store.getRawBytes(m.mapId);
        if (!base) return reply.code(422).send({ mission: index, error: "карта миссии не найдена" });
        let project: EditorProject | undefined;
        const fromBody = EditorProject.safeParse(sent[m.mapId]);
        if (fromBody.success && fromBody.data.baseScenarioId === m.mapId) project = fromBody.data;
        else if (viewer) {
          try {
            const saved = EditorProject.safeParse(JSON.parse(await readFile(savedProjectPath(m.mapId, viewer), "utf-8")));
            if (saved.success && saved.data.baseScenarioId === m.mapId) project = saved.data;
          } catch {
            /* no saved project: the map as it is */
          }
        }
        let bytes = base.bytes;
        let title = "";
        if (project && activeOps(project).length > 0) {
          const built = await buildAndValidateForMod(mods.get((await store.modOf(m.mapId))?.id), base.bytes, project);
          if (!built.report.ok || !built.bytes) {
            title = (await store.getMap(m.mapId))?.doc.header.name ?? "";
            return reply.code(422).send({ mission: index, title, report: built.report });
          }
          bytes = built.bytes;
        }
        title = (await store.getMap(m.mapId))?.doc.header.name || `mission ${index + 1}`;
        const kept =
          m.fileName && !campaignMissionNameProblem(m.fileName) && !taken.has(m.fileName.toUpperCase())
            ? m.fileName
            : undefined;
        const name = kept ?? campaignMissionFileName(title, taken);
        taken.add(name.toUpperCase());
        out.push({ name, bytes });
      }
      let csg: Uint8Array;
      try {
        csg = writeCampaign({ header: { ...header, race: header.race }, missions: out });
      } catch (e) {
        return reply.code(422).send({ error: e instanceof Error ? e.message : String(e) });
      }
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="${encodeURIComponent(fileNameOf(header.name))}"`)
        .send(Buffer.from(csg));
    },
  );
}
