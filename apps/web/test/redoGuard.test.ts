import { describe, expect, it } from "vitest";
import { MapDocument } from "@d2/map-schema";
import { EditOp } from "@d2/socket-contract";
import { makeCell } from "@d2/map-edit";
import { captureRedoState } from "../src/services/redoGuard";

function fixture(): MapDocument {
  return MapDocument.parse({
    schemaVersion: "0.3", size: 1, header: { size: 1 },
    terrain: { size: 1, cells: [makeCell(0, 0, 0)] }, players: [], objects: [],
  });
}

const examples = {
  setCell: { kind: "setCell", x: 0, y: 0, value: 1 },
  addObject: { kind: "addObject", object: { type: "location", id: "LO1", pos: { x: 0, y: 0 } } },
  moveObject: { kind: "moveObject", id: "LO1", x: 0, y: 0 },
  patchObject: { kind: "patchObject", id: "LO1", fields: { name: "edit" } },
  deleteObject: { kind: "deleteObject", id: "LO1" },
  patchPlayer: { kind: "patchPlayer", id: "PL1", fields: { name: "edit" } },
  addPlayer: { kind: "addPlayer", snapshot: {} },
  removePlayer: { kind: "removePlayer", id: "PL1" },
  upsertEvent: { kind: "upsertEvent", event: { id: "EV1", appliesTo: {}, canTrigger: {} } },
  deleteEvent: { kind: "deleteEvent", id: "EV1" },
  upsertTemplate: { kind: "upsertTemplate", template: { id: "TM1" } },
  deleteTemplate: { kind: "deleteTemplate", id: "TM1" },
  setVariables: { kind: "setVariables", variables: [] },
  setDiplomacy: { kind: "setDiplomacy", diplomacy: [] },
  setScenarioInfo: { kind: "setScenarioInfo", fields: { name: "edit" } },
} satisfies Record<EditOp["kind"], unknown>;

describe("exhaustive redo footprints", () => {
  for (const [kind, raw] of Object.entries(examples)) {
    it(`captures a stable, nonempty footprint for ${kind}`, () => {
      const doc = fixture(), ops = [EditOp.parse(raw)];
      const before = captureRedoState(doc, ops);
      expect(Object.keys(before)).toHaveLength(1);
      expect(Object.values(before).every(v => typeof v === "string" && v.length > 0)).toBe(true);
      expect(captureRedoState(structuredClone(doc), ops)).toEqual(before);
    });
  }

  const changes = {
    players: { players: [{ id: "PL1", playerNo: 1, race: 0 }] },
    subraces: { subraces: [{ id: "SR1", subrace: 1, playerId: "PL1", number: 0, name: "", banner: 0 }] },
    objects: { objects: [{ type: "location", id: "LO1", pos: { x: 0, y: 0 } }] },
    fogs: { satellites: { fogs: [{ id: "FG1", rows: [{ y: 0, mask: [0] }] }] } },
    spells: { satellites: { playerSpells: [{ id: "KS1", spells: [] }] } },
    buildings: { satellites: { playerBuildings: [{ id: "PB1", buildings: [] }] } },
    plan: { plan: { id: "PN1", size: 1, entries: [{ x: 0, y: 0, element: "LO1" }] } },
    diplomacy: { diplomacy: [{ race1: 0, race2: 1, relation: 100 }] },
    slots: { header: { size: 1, playerSlots: [0] } },
  };
  for (const [field, patch] of Object.entries(changes)) {
    it(`invalidates roster redo when ${field} changes`, () => {
      const doc = fixture();
      const changed = MapDocument.parse({ ...doc, ...patch });
      for (const op of [EditOp.parse(examples.addPlayer), EditOp.parse(examples.removePlayer)]) {
        expect(captureRedoState(changed, [op])).not.toEqual(captureRedoState(doc, [op]));
      }
    });
  }
});
