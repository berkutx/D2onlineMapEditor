import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { MapDocument } from "@d2/map-schema";
import { emptyProject, makeCell, mintPlayerIds, RACES } from "@d2/map-edit";
import { useEditStore } from "../src/stores/editStore";

vi.mock("../src/services/api", () => ({
  validateProject: vi.fn(), exportProject: vi.fn(), generateRegion: vi.fn(), copilotLlm: vi.fn(),
  fetchProjectRemote: vi.fn(), saveProjectRemote: vi.fn(),
}));

function fixture() {
  return MapDocument.parse({
    schemaVersion: "0.3", size: 8, header: { size: 8, version: "S143", playerSlots: [RACES.empire.raceType, RACES.clans.raceType, ...Array<number>(11).fill(99)] },
    terrain: { size: 8, cells: Array.from({ length: 64 }, (_, i) => makeCell(i % 8, Math.floor(i / 8), 0)) },
    players: [
      { id: "PL1", playerNo: 1, race: 0, raceId: "G000RR0000", name: "one" },
      { id: "PL2", playerNo: 2, race: 1, raceId: "G000RR0001", name: "two" },
    ],
    objects: [{ type: "capital", id: "FT1", owner: "PL1", pos: { x: 0, y: 0 } },
      { type: "location", id: "LO1", pos: { x: 3, y: 3 }, radius: 0, name: "zone" }],
  });
}

function setup() {
  const edit = useEditStore();
  edit.project = emptyProject("regression");
  edit.setBaseDoc(fixture());
  const send = vi.fn();
  edit.setCollab(true, send);
  return { edit, send };
}

beforeEach(() => { vi.useFakeTimers(); setActivePinia(createPinia()); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("collaborative redo through the actual Pinia store", () => {
  it("does not overwrite a peer's player edit after undo", () => {
    const { edit, send } = setup();
    edit.commit([{ kind: "patchPlayer", id: "PL1", fields: { name: "mine" } }]);
    edit.undoEdit();
    edit.applyIncoming([{ kind: "patchPlayer", id: "PL1", fields: { name: "peer" } }]);
    const before = edit.project;
    send.mockClear();
    edit.redoEdit();
    expect(edit.liveDoc?.players.find(p => p.id === "PL1")?.name).toBe("peer");
    expect(edit.project).toBe(before);
    expect(send).not.toHaveBeenCalled();
    expect(edit.redoBlockedTick).toBe(1);
    expect(edit.redoable).toBe(false);
  });

  it("allows redo after an independent edit of a different player", () => {
    const { edit } = setup();
    edit.commit([{ kind: "patchPlayer", id: "PL1", fields: { name: "mine" } }]);
    edit.undoEdit();
    edit.applyIncoming([{ kind: "patchPlayer", id: "PL2", fields: { name: "peer" } }]);
    edit.redoEdit();
    expect(edit.liveDoc?.players.map(p => p.name)).toEqual(["mine", "peer"]);
    expect(edit.redoBlockedTick).toBe(0);
  });

  it("does not redo removal of a faction whose capital a peer changed", () => {
    const { edit, send } = setup();
    edit.commit([{ kind: "removePlayer", id: "PL1" }]);
    edit.undoEdit();
    edit.applyIncoming([{ kind: "patchObject", id: "FT1", fields: { name: "peer capital" } }]);
    send.mockClear();
    edit.redoEdit();
    expect(edit.liveDoc?.objects.find(o => o.id === "FT1")).toMatchObject({ name: "peer capital" });
    expect(send).not.toHaveBeenCalled();
    expect(edit.redoBlockedTick).toBe(1);
  });

  it("allows faction redo after independent terrain edits", () => {
    const { edit } = setup();
    edit.commit([{ kind: "removePlayer", id: "PL1" }]);
    edit.undoEdit();
    edit.applyIncoming([{ kind: "setCell", x: 7, y: 7, value: 9 }]);
    edit.redoEdit();
    expect(edit.liveDoc?.players.map(p => p.id)).toEqual(["PL2"]);
    expect(edit.liveDoc?.header.playerSlots).toEqual([RACES.clans.raceType, ...Array<number>(12).fill(99)]);
    expect(edit.liveDoc?.terrain.cells[63]?.value).toBe(9);
  });

  it("blocks add-player redo after a peer changes diplomacy", () => {
    const { edit, send } = setup();
    const doc = edit.liveDoc;
    if (!doc) throw new Error("Missing document");
    edit.commit([{ kind: "addPlayer", spec: { race: "elves", x: 1, y: 1, ids: { ...mintPlayerIds(doc) } } }]);
    edit.undoEdit();
    edit.applyIncoming([{ kind: "setDiplomacy", diplomacy: [{ race1: 0, race2: 1, relation: 100 }] }]);
    const before = edit.project;
    send.mockClear();
    edit.redoEdit();
    expect(edit.redoBlockedTick).toBe(1);
    expect(edit.project).toBe(before);
    expect(edit.liveDoc?.players).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
  });

  it("permits add-player redo after an unrelated scenario-title edit", () => {
    const { edit } = setup();
    const doc = edit.liveDoc;
    if (!doc) throw new Error("Missing document");
    edit.commit([{ kind: "addPlayer", spec: { race: "elves", x: 1, y: 1, ids: { ...mintPlayerIds(doc) } } }]);
    edit.undoEdit();
    edit.applyIncoming([{ kind: "setScenarioInfo", fields: { name: "peer title" } }]);
    edit.redoEdit();
    expect(edit.redoBlockedTick).toBe(0);
    expect(edit.liveDoc?.players).toHaveLength(3);
    expect(edit.liveDoc?.header.name).toBe("peer title");
  });

  it("reports a stale faction undo without throwing or changing the journal", () => {
    const { edit, send } = setup();
    const base = fixture();
    edit.setBaseDoc(MapDocument.parse({ ...base,
      header: { ...base.header, playerSlots: [RACES.empire.raceType, RACES.clans.raceType, RACES.legions.raceType, ...Array<number>(10).fill(99)] },
      players: [...base.players, { id: "PL3", playerNo: 3, race: 2, raceId: "G000RR0002" }],
    }));
    // Inverse terrain edit executes before the stale roster restore fails: nothing may leak.
    edit.commit([{ kind: "removePlayer", id: "PL1" }, { kind: "setCell", x: 0, y: 0, value: 9 }]);
    edit.applyIncoming([{ kind: "removePlayer", id: "PL2" }]);
    edit.takeTerrainDirty();
    const beforeDoc = edit.liveDoc, beforeProject = edit.project;
    send.mockClear();
    expect(() => edit.undoEdit()).not.toThrow();
    expect(edit.liveDoc).toBe(beforeDoc);
    expect(edit.project).toBe(beforeProject);
    expect(send).not.toHaveBeenCalled();
    expect(edit.undoBlockedTick).toBe(1);
    expect(edit.undoable).toBe(true);
    expect(edit.takeTerrainDirty()).toEqual({ full: false, cells: [] });
  });
});

describe("zone movement is validated before any mutation", () => {
  it.each(["3", "3,", "x,3", "3,3,4", "3.5,3", "-1,3"])("rejects malformed mask %s atomically", (cell) => {
    const { edit, send } = setup();
    edit.project = { ...edit.project!, zones: { z: { name: "zone", cells: [cell], locIds: ["LO1"], eventGroups: [] } } };
    const beforeDoc = edit.liveDoc, beforeProject = edit.project;
    expect(edit.moveZone("z", 1, 0)).toBe(false);
    expect(edit.liveDoc).toBe(beforeDoc);
    expect(edit.project).toBe(beforeProject);
    expect(send).not.toHaveBeenCalled();
  });

  it("moves valid mask and locations together in one commit", () => {
    const { edit, send } = setup();
    edit.project = { ...edit.project!, zones: { z: { name: "zone", cells: ["3,3"], locIds: ["LO1"], eventGroups: [] } } };
    expect(edit.moveZone("z", 1, -1)).toBe(true);
    expect(edit.project?.zones?.z?.cells).toEqual(["4,2"]);
    expect(edit.liveDoc?.objects.find(o => o.id === "LO1")?.pos).toEqual({ x: 4, y: 2 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(edit.project?.journal).toHaveLength(1);
  });

  it.each([
    { dx: 8, dy: 0, readOnly: false, ids: ["LO1"] },
    { dx: 0.5, dy: 0, readOnly: false, ids: ["LO1"] },
    { dx: 1, dy: 0, readOnly: true, ids: ["LO1"] },
    { dx: 1, dy: 0, readOnly: false, ids: ["LO1", "missing"] },
    { dx: 1, dy: 0, readOnly: false, ids: ["FT1"] },
  ])("rejects an invalid zone move without partial changes: %j", ({ dx, dy, readOnly, ids }) => {
    const { edit, send } = setup();
    edit.project = { ...edit.project!, zones: { z: { name: "zone", cells: ["3,3"], locIds: ids, eventGroups: [] } } };
    edit.readOnly = readOnly;
    const beforeDoc = edit.liveDoc, beforeProject = edit.project;
    expect(edit.moveZone("z", dx, dy)).toBe(false);
    expect(edit.liveDoc).toBe(beforeDoc);
    expect(edit.project).toBe(beforeProject);
    expect(send).not.toHaveBeenCalled();
  });
});
