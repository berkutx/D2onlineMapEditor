import { describe, expect, it } from "vitest";
import { EditOp } from "@d2/socket-contract";
import { detailOf, summarize, summarizeBatch } from "../src/services/historyPresentation";

// Runtime validation also keeps the examples aligned with the public operation contract.
const examples = {
  setCell: { kind: "setCell", x: 1, y: 2, value: 42 },
  addObject: { kind: "addObject", object: { type: "crystal", id: "CR1", pos: { x: 1, y: 2 }, resource: 5 } },
  moveObject: { kind: "moveObject", id: "FT1", x: 4, y: 5 },
  patchObject: { kind: "patchObject", id: "FT1", fields: { name: "Столица" } },
  deleteObject: { kind: "deleteObject", id: "FT1" },
  patchPlayer: { kind: "patchPlayer", id: "PL1", fields: { name: "Империя", isHuman: true } },
  upsertEvent: { kind: "upsertEvent", event: { id: "EV1", name: "Победа", appliesTo: {}, canTrigger: {} } },
  deleteEvent: { kind: "deleteEvent", id: "EV1" },
  setVariables: { kind: "setVariables", variables: [{ id: 1, name: "Ходы", value: 5 }] },
  upsertTemplate: { kind: "upsertTemplate", template: { id: "TM1", name: "Стража" } },
  deleteTemplate: { kind: "deleteTemplate", id: "TM1" },
  setScenarioInfo: { kind: "setScenarioInfo", fields: { name: "Новая карта", author: "Автор" } },
  setDiplomacy: { kind: "setDiplomacy", diplomacy: [{ race1: 0, race2: 1, relation: 100 }] },
  addPlayer: { kind: "addPlayer", spec: { race: "empire", name: "Империя", x: 4, y: 5, ids: { pl: "PL1" } } },
  removePlayer: { kind: "removePlayer", id: "PL1" },
} satisfies Record<EditOp["kind"], unknown>;

describe("history descriptions", () => {
  for (const [kind, raw] of Object.entries(examples)) {
    it(`describes ${kind} in both the row and expanded details`, () => {
      const op = EditOp.parse(raw);
      expect(summarize(op)).toEqual(expect.stringMatching(/\S/));
      expect(detailOf(op)).toEqual(expect.stringMatching(/\S/));
    });
  }

  it("keeps identifying values in the newly supported operation descriptions", () => {
    expect(detailOf(EditOp.parse(examples.patchPlayer))).toContain("PL1");
    expect(detailOf(EditOp.parse(examples.patchPlayer))).toContain("Империя");
    expect(detailOf(EditOp.parse(examples.setScenarioInfo))).toContain("Новая карта");
    expect(detailOf(EditOp.parse(examples.setScenarioInfo))).toContain("Автор");
    expect(detailOf(EditOp.parse(examples.setDiplomacy))).toContain("100");
    expect(detailOf(EditOp.parse(examples.addPlayer))).toContain("(4, 5)");
    expect(detailOf(EditOp.parse(examples.removePlayer))).toContain("PL1");
  });

  it("describes a restored faction snapshot without guessing its shape", () => {
    const op = EditOp.parse({ kind: "addPlayer", snapshot: { player: { id: "PL2", name: "Легионы" } } });
    expect(summarize(op)).toContain("Легионы");
    expect(detailOf(op)).toContain("PL2");
    expect(detailOf(op)).toContain("Легионы");
  });

  it("humanizes an object from context and distinguishes roads from terrain restoration", () => {
    const ctx = { objectOf: () => ({ type: "capital", name: "Хеленверд" }) };
    expect(summarize(EditOp.parse(examples.moveObject), ctx)).toContain("столица «Хеленверд»");
    const op = EditOp.parse(examples.setCell);
    expect(summarize({ ...op, kind: "setCell", x: 1, y: 2, value: 42, roadType: 2 })).toContain("дорога");
    expect(summarize({ ...op, kind: "setCell", x: 1, y: 2, value: 42, roadType: -1 })).toContain("рельеф");
    expect(summarizeBatch([op, op])).toBe("⛰ рельеф — 2 кл.");
  });
});
