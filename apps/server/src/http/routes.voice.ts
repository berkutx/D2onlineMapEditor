import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { MapEvent, type MapDocument } from "@d2/map-schema";
import { EditorProject } from "@d2/map-edit";
import {
  DialogHandoffV1,
  DialogReturnV1,
  REST,
  type DialogReturnV1 as DialogReturn,
  type VoiceConflict,
} from "@d2/socket-contract";
import { parseScenario } from "@d2/sg-parser";
import { config } from "../config.js";
import type { MapStore } from "../maps/mapStore.js";
import { clientIdOf } from "./routes.scenarios.js";
import { buildAndValidate, loadLandmarkSizeFn, loadTalismanTemplates } from "./routes.maps.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
export function stableHash(value: unknown): string {
  // Hash the JSON wire representation: object properties whose value is undefined
  // disappear during the server-to-server handoff and must not change the digest.
  return createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)))).digest("hex");
}
const eq = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

function sourceProjectId(mapId: string, clientId: string): string {
  return createHash("sha256").update(mapId + clientId).digest("hex");
}
function safeReturnPath(raw: unknown, mapId: string): string {
  const fallback = `${config.BASE_PATH || ""}/?map=${encodeURIComponent(mapId)}` || `/?map=${encodeURIComponent(mapId)}`;
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return fallback;
  try {
    const u = new URL(raw, "http://local");
    if (u.origin !== "http://local") return fallback;
    const allowedBase = config.BASE_PATH || "/";
    if (allowedBase !== "/" && !(u.pathname === allowedBase || u.pathname.startsWith(`${allowedBase}/`))) return fallback;
    return u.pathname + u.search;
  } catch { return fallback; }
}

/** Prefix a trusted root-relative voicer URL with its browser-facing nginx mount point.
 * Server-to-server responses bypass nginx, so their `/login.html` and `/?project=...`
 * paths otherwise point at the unrelated site root. */
export function prefixVoiceBrowserPath(raw: string, base = config.VOICE_PUBLIC_BASE_PATH): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) throw new Error("Некорректный адрес войсера");
  const u = new URL(raw, "http://voice.local");
  if (u.origin !== "http://voice.local") throw new Error("Некорректный адрес войсера");
  const path = u.pathname + u.search + u.hash;
  if (!base || u.pathname === base || u.pathname.startsWith(`${base}/`)) return path;
  return `${base}${path}`;
}

export function voiceBrowserUrl(
  raw: string,
  base = config.VOICE_PUBLIC_BASE_PATH,
  origin = config.VOICE_PUBLIC_ORIGIN,
): string {
  const path = prefixVoiceBrowserPath(raw, base);
  return origin ? new URL(path, `${origin}/`).toString() : path;
}

export function voiceLoginPath(next: string): string {
  return `/login.html?from=editor&next=${encodeURIComponent(next)}`;
}

interface CurrentBuild { project: EditorProject; doc: MapDocument; bytes: Uint8Array }
async function currentBuild(store: MapStore, id: string, raw: unknown): Promise<CurrentBuild | { error: unknown; status: number }> {
  const parsed = EditorProject.safeParse(raw);
  if (!parsed.success) return { status: 400, error: { error: "invalid EditorProject", detail: parsed.error.message } };
  if (parsed.data.baseScenarioId !== id) return { status: 400, error: { error: "project baseScenarioId mismatch" } };
  const base = await store.getRawBytes(id);
  if (!base) return { status: 404, error: { error: "map not found" } };
  const built = buildAndValidate(base.bytes, parsed.data, await loadTalismanTemplates(), await loadLandmarkSizeFn());
  if (!built.report.ok || !built.bytes) return { status: 422, error: built.report };
  return { project: parsed.data, bytes: built.bytes, doc: parseScenario(built.bytes) };
}

function integrationHeaders(req: FastifyRequest, clientId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "x-integration-secret": config.VOICE_INTEGRATION_SECRET,
    "x-editor-client-id": clientId,
  };
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  return headers;
}
async function voiceFetch(req: FastifyRequest, clientId: string, path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  if (!config.VOICE_INTEGRATION_ENABLED || !config.VOICE_INTERNAL_URL) {
    return new Response(JSON.stringify({ error: "Интеграция с озвучкой не настроена" }), { status: 503, headers: { "content-type": "application/json" } });
  }
  if (config.VOICE_INTEGRATION_CLIENTS.length && !config.VOICE_INTEGRATION_CLIENTS.includes(clientId)) {
    return new Response(JSON.stringify({ error: "Интеграция пока не включена для этого браузера" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const headers = { ...integrationHeaders(req, clientId), ...(init.headers as Record<string, string> || {}) };
  try { return await fetch(`${config.VOICE_INTERNAL_URL}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { return new Response(JSON.stringify({ error: `Сервис озвучки недоступен: ${e instanceof Error ? e.message : String(e)}` }), { status: 502, headers: { "content-type": "application/json" } }); }
}
async function relayJson(reply: { code(n: number): { send(v: unknown): unknown } }, res: Response): Promise<unknown> {
  const data = await res.json().catch(() => ({ error: `voice service HTTP ${res.status}` }));
  return reply.code(res.status).send(data);
}

function eventSummary(e: MapEvent | null): string {
  if (!e) return "событие удалено";
  const popups = e.effects.filter((x) => x.kind === "popup").map((x) => {
    const p = x as { text?: string; image?: string; image2?: string; sound?: string; music?: string; leftSide?: boolean; popupShow?: number };
    return { text: p.text || "", image: p.image || "", image2: p.image2 || "", sound: p.sound || "", music: p.music || "", leftSide: !!p.leftSide, popupShow: p.popupShow ?? 0 };
  });
  return JSON.stringify({
    name: e.name || e.id, enabled: e.enabled, occurOnce: e.occurOnce, chance: e.chance, order: e.order,
    conditions: e.conditions, dialogs: popups, otherEffects: e.effects.filter((x) => x.kind !== "popup"),
  }, null, 2).slice(0, 6000);
}

function eventHashes(events: readonly MapEvent[], changes: DialogReturn["changedEvents"]): Record<string, string> {
  const byId = new Map(events.map((e) => [e.id, e]));
  return Object.fromEntries(changes.map((c) => [c.eventId, stableHash(byId.get(c.eventId) ?? null)]));
}

export interface MergeResult {
  ops: Array<{ kind: "upsertEvent"; event: MapEvent } | { kind: "deleteEvent"; id: string }>;
  conflicts: VoiceConflict[];
  autoEventIds: string[];
  alreadyAppliedEventIds: string[];
  acceptedEvents: MapEvent[];
}

/** Whole-event three-way merge. Unrelated terrain/objects/events are absent from this input and
 * remain untouched; a same-event divergence is resolved explicitly by the user. */
export function mergeVoiceReturn(
  currentEvents: readonly MapEvent[],
  changes: DialogReturn["changedEvents"],
  resolutions: Record<string, "editor" | "voice"> = {},
): MergeResult {
  const current = new Map(currentEvents.map((e) => [e.id, e]));
  const ops: MergeResult["ops"] = [], conflicts: VoiceConflict[] = [], autoEventIds: string[] = [], alreadyAppliedEventIds: string[] = [];
  for (const change of changes) {
    const cur = current.get(change.eventId) ?? null;
    let take: "editor" | "voice";
    if (eq(cur, change.next)) { alreadyAppliedEventIds.push(change.eventId); take = "editor"; }
    else if (eq(cur, change.base)) { autoEventIds.push(change.eventId); take = "voice"; }
    else if (resolutions[change.eventId]) take = resolutions[change.eventId]!;
    else {
      conflicts.push({
        eventId: change.eventId,
        eventName: change.next?.name || change.base?.name || change.eventId,
        editorSummary: eventSummary(cur), voiceSummary: eventSummary(change.next),
      });
      continue;
    }
    if (take === "voice") {
      if (change.next) { current.set(change.eventId, change.next); ops.push({ kind: "upsertEvent", event: change.next }); }
      else if (cur) { current.delete(change.eventId); ops.push({ kind: "deleteEvent", id: change.eventId }); }
    }
  }
  return { ops, conflicts, autoEventIds, alreadyAppliedEventIds, acceptedEvents: [...current.values()] };
}

async function getReturn(req: FastifyRequest, clientId: string, token: string): Promise<{ response: Response; data?: DialogReturn }> {
  const response = await voiceFetch(req, clientId, `/internal/editor/returns/${encodeURIComponent(token)}`);
  if (!response.ok) return { response };
  const raw = await response.json();
  const parsed = DialogReturnV1.safeParse(raw);
  if (!parsed.success) return { response: new Response(JSON.stringify({ error: "Некорректный ответ войсера", detail: parsed.error.message }), { status: 502, headers: { "content-type": "application/json" } }) };
  return { response, data: parsed.data };
}

export async function registerVoiceRoutes(app: FastifyInstance, store: MapStore): Promise<void> {
  app.post<{ Params: { id: string }; Body: { project?: unknown; returnPath?: string } | unknown }>(REST.voiceHandoff(":id"), async (req, reply) => {
    const clientId = clientIdOf(req); if (!clientId) return reply.code(400).send({ error: "x-client-id required" });
    const body = (req.body || {}) as { project?: unknown; returnPath?: string };
    const built = await currentBuild(store, req.params.id, body.project ?? req.body);
    if ("status" in built) return reply.code(built.status).send(built.error);
    const events = built.doc.events.map((e) => MapEvent.parse(e));
    const payload = DialogHandoffV1.parse({
      contractVersion: 1,
      sourceProjectId: sourceProjectId(req.params.id, clientId), sourceMapId: req.params.id,
      mapName: built.doc.header.name || req.params.id, mapRevision: stableHash(built.doc),
      eventsRevision: stableHash(events), eventHashes: Object.fromEntries(events.map((e) => [e.id, stableHash(e)])),
      events, returnPath: safeReturnPath(body.returnPath, req.params.id),
    });
    const response = await voiceFetch(req, clientId, "/internal/editor/handoffs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!response.ok) {
      if (response.status === 401) return reply.code(401).send({
        error: "Требуется вход в сервис озвучки",
        loginUrl: voiceBrowserUrl(voiceLoginPath(payload.returnPath + (payload.returnPath.includes("?") ? "&" : "?") + "resumeVoice=1")),
      });
      return relayJson(reply, response);
    }
    const result = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!result || typeof result.launchUrl !== "string") return reply.code(502).send({ error: "Войсер не вернул адрес проекта" });
    try { return reply.send({ ...result, launchUrl: voiceBrowserUrl(result.launchUrl) }); }
    catch (e) { return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) }); }
  });

  const prepare = async (req: FastifyRequest<{ Params: { id: string; token: string }; Body: { project?: unknown; resolutions?: Record<string, "editor" | "voice">; expectedEventHashes?: Record<string, string> } }>) => {
    const clientId = clientIdOf(req); if (!clientId) return { error: { status: 400, body: { error: "x-client-id required" } } };
    const built = await currentBuild(store, req.params.id, req.body?.project);
    if ("status" in built) return { error: { status: built.status, body: built.error } };
    const got = await getReturn(req, clientId, req.params.token);
    if (!got.data) return { errorResponse: got.response };
    const expected = sourceProjectId(req.params.id, clientId);
    if (got.data.sourceProjectId !== expected || got.data.sourceMapId !== req.params.id) return { error: { status: 409, body: { error: "Возврат относится к другой карте" } } };
    const events = built.doc.events.map((e) => MapEvent.parse(e));
    return { clientId, built, ret: got.data, events, merged: mergeVoiceReturn(events, got.data.changedEvents, req.body?.resolutions || {}) };
  };

  const previewBody = (p: Awaited<ReturnType<typeof prepare>>, merged = "merged" in p ? p.merged : undefined) => ({
    returnId: "ret" in p ? p.ret?.returnId : "", sourceProjectId: "ret" in p ? p.ret?.sourceProjectId : "",
    currentEventsRevision: "events" in p ? stableHash(p.events) : "",
    currentEventHashes: "events" in p && "ret" in p && p.ret ? eventHashes(p.events, p.ret.changedEvents) : {},
    autoEventIds: merged?.autoEventIds || [], alreadyAppliedEventIds: merged?.alreadyAppliedEventIds || [], conflicts: merged?.conflicts || [],
  });

  app.post<{ Params: { id: string; token: string }; Body: { project?: unknown } }>(REST.voiceReturnPreview(":id", ":token"), async (req, reply) => {
    const p = await prepare(req);
    if ("errorResponse" in p) return relayJson(reply, p.errorResponse!);
    if ("error" in p) return reply.code(p.error!.status).send(p.error!.body);
    return previewBody(p);
  });

  app.post<{ Params: { id: string; token: string }; Body: { project?: unknown; resolutions?: Record<string, "editor" | "voice">; expectedEventHashes?: Record<string, string> } }>(REST.voiceReturnApply(":id", ":token"), async (req, reply) => {
    const p = await prepare(req);
    if ("errorResponse" in p) return relayJson(reply, p.errorResponse!);
    if ("error" in p) return reply.code(p.error!.status).send(p.error!.body);
    if (!req.body?.expectedEventHashes || !eq(req.body.expectedEventHashes, eventHashes(p.events, p.ret!.changedEvents))) {
      const refreshed = mergeVoiceReturn(p.events, p.ret!.changedEvents, {});
      return reply.code(409).send({ error: "Затронутые события изменились — проверьте конфликты ещё раз", preview: previewBody(p, refreshed) });
    }
    if (p.merged!.conflicts.length) return reply.code(409).send({ error: "Нужно разрешить новые конфликты", preview: {
      ...previewBody(p),
    } });
    const uids = p.merged!.ops.map((op) => `voice-${p.ret!.returnId.slice(0, 16)}-${stableHash(op.kind === "upsertEvent" ? op.event.id : op.id).slice(0, 16)}`);
    return { returnId: p.ret!.returnId, currentEventsRevision: stableHash(p.events), ops: p.merged!.ops, uids, acceptedEvents: p.merged!.acceptedEvents };
  });

  app.post<{ Params: { id: string; token: string }; Body: { project?: unknown } }>(REST.voiceReturnAck(":id", ":token"), async (req, reply) => {
    const clientId = clientIdOf(req); if (!clientId) return reply.code(400).send({ error: "x-client-id required" });
    const built = await currentBuild(store, req.params.id, req.body?.project);
    if ("status" in built) return reply.code(built.status).send(built.error);
    const acceptedEvents = built.doc.events.map((e) => MapEvent.parse(e));
    const response = await voiceFetch(req, clientId, `/internal/editor/returns/${encodeURIComponent(req.params.token)}/ack`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ acceptedEvents }),
    });
    if (!response.ok) return relayJson(reply, response);
    return reply.send(await response.json());
  });

  app.post<{ Params: { id: string }; Body: { project?: unknown; allowMissing?: boolean; returnPath?: string } }>(REST.mapExportPackage(":id"), async (req, reply) => {
    const clientId = clientIdOf(req); if (!clientId) return reply.code(400).send({ error: "x-client-id required" });
    const built = await currentBuild(store, req.params.id, req.body?.project);
    if ("status" in built) return reply.code(built.status).send(built.error);
    const mapName = `${built.doc.header.name || req.params.id}-edited.sg`;
    const response = await voiceFetch(req, clientId, "/internal/editor/package", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-source-project-id": sourceProjectId(req.params.id, clientId),
        "x-map-file-name": encodeURIComponent(mapName),
        "x-allow-missing": req.body?.allowMissing ? "1" : "0",
      },
      body: Buffer.from(built.bytes),
    }, 180_000);
    if (response.status === 401) {
      const back = new URL(safeReturnPath(req.body?.returnPath, req.params.id), "http://local");
      back.searchParams.set("resumeVoiceExport", "1");
      return reply.code(401).send({
        error: "Требуется вход в сервис озвучки",
        loginUrl: voiceBrowserUrl(voiceLoginPath(back.pathname + back.search)),
      });
    }
    if (!response.ok) return relayJson(reply, response);
    const disp = response.headers.get("content-disposition");
    if (!response.body) return reply.code(502).send({ error: "Войсер вернул пустой архив" });
    const stream = Readable.fromWeb(response.body as never);
    return reply.header("content-type", "application/zip").header("content-disposition", disp || `attachment; filename="${encodeURIComponent(mapName.replace(/\.sg$/i, ".zip"))}"`).send(stream);
  });
}
