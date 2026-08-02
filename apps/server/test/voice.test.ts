import { describe, expect, it } from "vitest";
import { MapEvent, type MapEvent as Event } from "@d2/map-schema";
import { DialogHandoffV1, DialogReturnV1 } from "@d2/socket-contract";
import { mergeVoiceReturn, prefixVoiceBrowserPath, stableHash, voiceBrowserUrl, voiceLoginPath } from "../src/http/routes.voice";

const races = {};
function ev(id: string, text: string, overrides: Record<string, unknown> = {}): Event {
  return MapEvent.parse({
    id, name: `Event ${id}`, enabled: true, occurOnce: true, chance: 100, order: 0,
    appliesTo: races, canTrigger: races, conditions: [],
    effects: [{
      kind: "popup", num: 0, text, image: "G000UU0001", image2: "G000UU0002",
      sound: "voice", music: "theme", leftSide: true, popupShow: 2, boolValue: true,
    }],
    ...overrides,
  });
}
const change = (eventId: string, base: Event | null, next: Event | null) => ({ eventId, base, next });

describe("DialogHandoffV1 / DialogReturnV1", () => {
  it("carries every popup field and a complete audio manifest", () => {
    const baseEvent = ev("EV00000001", "Маркус: Текст");
    const event = {
      ...baseEvent,
      futureEventField: { keep: true },
      effects: [{ ...baseEvent.effects[0]!, futurePopupField: "keep" }],
    } as Event;
    const handoff = DialogHandoffV1.parse({
      contractVersion: 1, sourceProjectId: "a".repeat(64), sourceMapId: "map-1", mapName: "Карта",
      mapRevision: stableHash({ whole: true }), eventsRevision: stableHash([event]),
      eventHashes: { [event.id]: stableHash(event) }, events: [event], returnPath: "/map/?map=map-1",
    });
    expect(handoff.events[0]!.effects[0]).toMatchObject({
      kind: "popup", text: "Маркус: Текст", image: "G000UU0001", image2: "G000UU0002",
      sound: "voice", music: "theme", leftSide: true, popupShow: 2, boolValue: true,
    });
    expect(handoff.events[0]).toMatchObject({ futureEventField: { keep: true } });
    expect(handoff.events[0]!.effects[0]).toMatchObject({ futurePopupField: "keep" });
    const returned = DialogReturnV1.parse({
      contractVersion: 1, returnId: "b".repeat(64), sourceProjectId: handoff.sourceProjectId,
      sourceMapId: handoff.sourceMapId, baseRevision: handoff.eventsRevision,
      changedEvents: [change(event.id, event, ev(event.id, "Маркус: Новый текст"))],
      audio: [{ assetId: "asset", kind: "audio", logicalName: "voice.mp3", sha256: "c".repeat(64), size: 123 }],
      returnPath: handoff.returnPath, createdAt: 1, expiresAt: 2, status: "pending",
    });
    expect(returned.audio[0]).toEqual(expect.objectContaining({ logicalName: "voice.mp3", size: 123 }));
  });
});

describe("three-way voice merge", () => {
  it("applies an independent voice edit without touching other changed events", () => {
    const base = ev("EV00000001", "base"), voice = ev(base.id, "voice");
    const unrelated = ev("EV00000002", "edited elsewhere");
    const result = mergeVoiceReturn([base, unrelated], [change(base.id, base, voice)]);
    expect(result.conflicts).toEqual([]);
    expect(result.ops).toEqual([{ kind: "upsertEvent", event: voice }]);
    expect(result.acceptedEvents.find((e) => e.id === unrelated.id)).toEqual(unrelated);
  });

  it("reports a same-event conflict and honors either explicit resolution", () => {
    const base = ev("EV00000001", "base"), editor = ev(base.id, "editor"), voice = ev(base.id, "voice");
    const unresolved = mergeVoiceReturn([editor], [change(base.id, base, voice)]);
    expect(unresolved.conflicts).toHaveLength(1);
    expect(unresolved.conflicts[0]!.editorSummary).toContain("editor");
    expect(unresolved.conflicts[0]!.voiceSummary).toContain("voice");
    expect(mergeVoiceReturn([editor], [change(base.id, base, voice)], { [base.id]: "editor" }).ops).toEqual([]);
    expect(mergeVoiceReturn([editor], [change(base.id, base, voice)], { [base.id]: "voice" }).ops)
      .toEqual([{ kind: "upsertEvent", event: voice }]);
  });

  it("handles add/delete and a repeated return without duplicate ops", () => {
    const old = ev("EV00000001", "delete"), added = ev("EV00000002", "add");
    const first = mergeVoiceReturn([old], [change(old.id, old, null), change(added.id, null, added)]);
    expect(first.ops).toEqual([{ kind: "deleteEvent", id: old.id }, { kind: "upsertEvent", event: added }]);
    const repeated = mergeVoiceReturn([added], [change(old.id, old, null), change(added.id, null, added)]);
    expect(repeated.ops).toEqual([]);
    expect(repeated.alreadyAppliedEventIds).toEqual([old.id, added.id]);
  });
});

describe("stableHash", () => {
  it("is independent from object key insertion order", () => {
    expect(stableHash({ b: 2, a: { y: 1, x: 0 } })).toBe(stableHash({ a: { x: 0, y: 1 }, b: 2 }));
  });
});

describe("voice browser paths behind nginx", () => {
  it("mounts voicer pages below /dialogeditor without double-prefixing", () => {
    expect(prefixVoiceBrowserPath("/?project=abc", "/dialogeditor")).toBe("/dialogeditor/?project=abc");
    expect(prefixVoiceBrowserPath("/login.html?next=%2Fmap%2F", "/dialogeditor"))
      .toBe("/dialogeditor/login.html?next=%2Fmap%2F");
    expect(prefixVoiceBrowserPath("/dialogeditor/?project=abc", "/dialogeditor"))
      .toBe("/dialogeditor/?project=abc");
  });

  it("marks editor logins explicitly and pins direct-IP navigation to HTTP", () => {
    const login = voiceLoginPath("/map/?map=abc&resumeVoice=1");
    expect(login).toContain("from=editor");
    expect(voiceBrowserUrl(login, "/dialogeditor", "http://151.115.56.12"))
      .toBe("http://151.115.56.12/dialogeditor/login.html?from=editor&next=%2Fmap%2F%3Fmap%3Dabc%26resumeVoice%3D1");
    expect(voiceBrowserUrl("/?project=abc", "/dialogeditor", ""))
      .toBe("/dialogeditor/?project=abc");
  });

  it("rejects scheme-relative navigation supplied by the private service", () => {
    expect(() => prefixVoiceBrowserPath("//evil.example/", "/dialogeditor")).toThrow(/Некорректный/);
  });
});
