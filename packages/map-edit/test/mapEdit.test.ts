import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseScenarioRaw, parseScenario, validateMap, ByteBuffer, iterateObjects } from "@d2/sg-parser";
import {
  setTerrain,
  setGround,
  setForest,
  getTerrain,
  getGround,
  getForest,
  applyOp,
  applyOps,
  invertOps,
  foldOps,
  applyEditsToBytes,
  roundTripSemantic,
  roadBrush,
  roadTypeFromMask,
  eraseBrush,
  selectRoadSegment,
  eraseRoadCells,
  placeMountainOps,
  placeLandmarkOps,
  placeVisitorOps,
  emptyProject,
  pushOp,
  undo,
  redo,
  activeOps,
  canUndo,
  canRedo,
  serializeProject,
  deserializeProject,
  type EditOp,
} from "../src/index";

const RIDERS = String.raw`C:\GOG Games\last_version\Game\Campaign\The Power of Eldunari-v1-2 maps\Riders.sg`;
const DRAGON = String.raw`C:\GOG Games\last_version\Game\Campaign\The Power of Eldunari-v1-2 maps\Dragon_s teeth.sg`;
const bytes = new Uint8Array(readFileSync(RIDERS));

describe("@d2/map-edit bits", () => {
  it("setters change only their field and preserve the other bits", () => {
    const v = 0b1010_1010_1010_1010_1010_1010_1010_1010 | 0;
    expect(getTerrain(setTerrain(v, 5))).toBe(5);
    expect(getGround(setGround(v, 3))).toBe(3);
    expect(getForest(setForest(v, 17))).toBe(17);
    // changing terrain leaves ground + forest intact
    const v2 = setTerrain(v, 4);
    expect(getGround(v2)).toBe(getGround(v));
    expect(getForest(v2)).toBe(getForest(v));
  });
});

describe("@d2/map-edit applyOp + inverse", () => {
  const { doc } = parseScenarioRaw(bytes);

  it("setCell is reversible via its inverse", () => {
    const idx = 10 * doc.size + 10;
    const before = doc.terrain.cells[idx]!;
    const op: EditOp = { kind: "setCell", x: 10, y: 10, value: setTerrain(before.value, (before.terrain + 1) % 5) };
    const { doc: d2, inverse } = applyOp(doc, op);
    expect(d2.terrain.cells[idx]!.value).toBe(op.value);
    const { doc: d3 } = applyOp(d2, inverse);
    expect(d3.terrain.cells[idx]).toEqual(before);
    // purity: original untouched
    expect(doc.terrain.cells[idx]).toEqual(before);
  });

  it("moveObject is reversible", () => {
    const target = doc.objects.find((o) => o.type === "stack" || o.type === "village")!;
    const op: EditOp = { kind: "moveObject", id: target.id, x: target.pos.x + 1, y: target.pos.y + 1 };
    const { doc: d2, inverse } = applyOp(doc, op);
    expect(d2.objects.find((o) => o.id === target.id)!.pos).toEqual({ x: target.pos.x + 1, y: target.pos.y + 1 });
    const { doc: d3 } = applyOp(d2, inverse);
    expect(d3.objects.find((o) => o.id === target.id)!.pos).toEqual(target.pos);
  });

  it("addObject/deleteObject invert each other", () => {
    const victim = doc.objects.find((o) => o.type === "crystal")!;
    const { doc: d2, inverse } = applyOp(doc, { kind: "deleteObject", id: victim.id });
    expect(d2.objects.find((o) => o.id === victim.id)).toBeUndefined();
    const { doc: d3 } = applyOp(d2, inverse);
    expect(d3.objects.find((o) => o.id === victim.id)).toEqual(victim);
  });

  it("invertOps undoes a whole batch (collab undo / history-revert primitive)", () => {
    const i1 = 5 * doc.size + 5;
    const i2 = 6 * doc.size + 6;
    const before1 = doc.terrain.cells[i1]!;
    const before2 = doc.terrain.cells[i2]!;
    const ops: EditOp[] = [
      { kind: "setCell", x: 5, y: 5, value: setTerrain(before1.value, (before1.terrain + 1) % 5) },
      { kind: "setCell", x: 6, y: 6, value: setTerrain(before2.value, (before2.terrain + 2) % 5) },
    ];
    const inv = invertOps(doc, ops); // captured against the pre-op doc
    const applied = applyOps(doc, ops);
    expect(applied.terrain.cells[i1]!.value).toBe(ops[0]!.kind === "setCell" ? ops[0]!.value : -1);
    // applying the inverse batch restores the exact original cells
    const restored = applyOps(applied, inv);
    expect(restored.terrain.cells[i1]).toEqual(before1);
    expect(restored.terrain.cells[i2]).toEqual(before2);
  });
});

describe("@d2/map-edit byte writer + semantic round-trip", () => {
  it("setCell + moveObject survive a full export round-trip", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const stack = doc.objects.find(
      (o) => (o.type === "stack" || o.type === "village") && o.pos.x < doc.size - 3 && o.pos.y < doc.size - 3,
    )!;
    const cell = doc.terrain.cells[12 * doc.size + 12]!;
    const ops: EditOp[] = [
      { kind: "setCell", x: 12, y: 12, value: setTerrain(cell.value, (cell.terrain + 2) % 5) },
      { kind: "moveObject", id: stack.id, x: stack.pos.x + 2, y: stack.pos.y + 1 },
    ];
    const out = applyEditsToBytes(raw, ops);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("fails loud on a resizing op (addObject)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const obj = doc.objects.find((o) => o.type === "crystal")!;
    expect(() => applyEditsToBytes(raw, [{ kind: "addObject", object: { ...obj, id: "S143XX9999" } }])).toThrow();
  });
});

describe("@d2/map-edit road brush + append export", () => {
  it("a new road appends a MidRoad block and survives the round-trip", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const n = doc.size;
    // bitmask table sanity (a few cases from the editor)
    expect(roadTypeFromMask(0)).toBe(0);
    expect(roadTypeFromMask(12)).toBe(2);
    expect(roadTypeFromMask(3)).toBe(3);

    // paint a road on a cell that currently has none
    const cx = 15, cy = 15;
    expect(raw.roadByCell.has(`${cx},${cy}`)).toBe(false);
    const ops = roadBrush(doc, cx, cy);
    expect(ops.length).toBeGreaterThan(0);
    const painted = ops.find((o) => o.kind === "setCell" && o.x === cx && o.y === cy)!;
    expect(painted.kind === "setCell" && painted.roadType! >= 0).toBe(true);

    const out = applyEditsToBytes(raw, ops);
    expect(out.length).toBeGreaterThan(bytes.length); // grew (a MidRoad block appended)
    const re = parseScenario(out);
    expect(re.terrain.cells[cy * n + cx]!.roadType).toBeGreaterThanOrEqual(0);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("erasing an existing road removes it and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const roadCell = doc.terrain.cells.find((c) => c.roadType >= 0)!;
    const ops = eraseBrush(doc, roadCell.x, roadCell.y, 1);
    expect(
      ops.some((o) => o.kind === "setCell" && o.x === roadCell.x && o.y === roadCell.y && o.roadType === -1),
    ).toBe(true);
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect(re.terrain.cells[roadCell.y * re.size + roadCell.x]!.roadType).toBe(-1);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });
});

describe("@d2/map-edit road segment selection", () => {
  const key = (c: { x: number; y: number }) => `${c.x},${c.y}`;

  it("selects monotonically growing road sets by level (0 ⊆ 1 ⊆ 2, all roads)", () => {
    const { doc } = parseScenarioRaw(bytes);
    const rc = doc.terrain.cells.find((c) => c.roadType >= 0)!;
    const s0 = selectRoadSegment(doc, rc.x, rc.y, 0);
    const s1 = selectRoadSegment(doc, rc.x, rc.y, 1);
    const s2 = selectRoadSegment(doc, rc.x, rc.y, 2);
    const set0 = new Set(s0.map(key)), set1 = new Set(s1.map(key)), set2 = new Set(s2.map(key));
    expect(set0.has(key(rc))).toBe(true);
    for (const c of s2) expect(doc.terrain.cells[c.y * doc.size + c.x]!.roadType).toBeGreaterThanOrEqual(0);
    for (const k of set0) expect(set1.has(k)).toBe(true);
    for (const k of set1) expect(set2.has(k)).toBe(true);
    expect(s1.length).toBeGreaterThanOrEqual(s0.length);
    expect(s2.length).toBeGreaterThanOrEqual(s1.length);
  });

  it("erases a selected segment (roads gone, terrain kept) and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const rc = doc.terrain.cells.find((c) => c.roadType >= 0)!;
    const sel = selectRoadSegment(doc, rc.x, rc.y, 1);
    const ops = eraseRoadCells(doc, sel);
    expect(ops.length).toBeGreaterThan(0);
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    for (const c of sel) {
      const cell = re.terrain.cells[c.y * re.size + c.x]!;
      expect(cell.roadType).toBe(-1);
      expect(cell.value).toBe(doc.terrain.cells[c.y * doc.size + c.x]!.value); // terrain unchanged
    }
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });
});

describe("@d2/map-edit place mountains + landmarks (addObject export)", () => {
  it("placing a mountain rebuilds MidMountains, stamps 37, and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const before = doc.objects.filter((o) => o.type === "mountains").length;
    const ops = placeMountainOps(doc, 20, 20, 2, 2, 5);
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect(re.objects.filter((o) => o.type === "mountains").length).toBe(before + 1);
    expect(re.terrain.cells[20 * re.size + 20]!.value).toBe(37); // footprint stamped
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("placing a landmark appends a MidLandmark block and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const existing = doc.objects.find((o) => o.type === "landmark" && o.baseType)!;
    const key = existing.baseType!;
    const before = doc.objects.filter((o) => o.type === "landmark").length;
    const ops = placeLandmarkOps(doc, 30, 30, key);
    const out = applyEditsToBytes(raw, ops);
    expect(out.length).toBeGreaterThan(bytes.length); // a block was appended
    const re = parseScenario(out);
    expect(re.objects.filter((o) => o.type === "landmark").length).toBe(before + 1);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("places THEN moves a landmark in one session, exporting at the final position", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const existing = doc.objects.find((o) => o.type === "landmark" && o.baseType)!;
    const place = placeLandmarkOps(doc, 30, 30, existing.baseType!);
    const id = (place.find((o) => o.kind === "addObject") as Extract<EditOp, { kind: "addObject" }>)
      .object.id;
    const ops: EditOp[] = [...place, { kind: "moveObject", id, x: 40, y: 41 }];
    const out = applyEditsToBytes(raw, ops); // must NOT throw (was the place+move bug)
    const re = parseScenario(out);
    const moved = re.objects.find((o) => o.id === id);
    expect(moved).toBeTruthy();
    expect(moved!.pos).toEqual({ x: 40, y: 41 });
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("places THEN moves a mountain in one session, exporting at the final position", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const place = placeMountainOps(doc, 20, 20, 2, 2, 5);
    const id = (place.find((o) => o.kind === "addObject") as Extract<EditOp, { kind: "addObject" }>)
      .object.id;
    const ops: EditOp[] = [...place, { kind: "moveObject", id, x: 25, y: 26 }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const moved = re.objects.find((o) => o.type === "mountains" && o.pos.x === 25 && o.pos.y === 26);
    expect(moved).toBeTruthy();
  });
});

describe("@d2/map-edit events (E1 read + E2 write)", () => {
  it("parses MidEvent blocks into the document (Riders has many)", () => {
    const { doc } = parseScenarioRaw(bytes);
    expect(doc.events.length).toBeGreaterThan(0);
    const ev = doc.events[0]!;
    expect(ev.id).toMatch(/EV[0-9a-f]{4}$/);
    expect(typeof ev.name).toBe("string");
    // some event on Riders must carry a WIN_OR_LOSE or POPUP effect
    const kinds = new Set(doc.events.flatMap((e) => e.effects.map((f) => f.kind)));
    expect(kinds.size).toBeGreaterThan(0);
  });

  it("EVERY existing event re-serializes byte-identically (reader<->writer agree)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    // upsert each event to itself -> writer re-emits its frame via replaceBlock; the export
    // must round-trip semantically (each event deepEquals its reparse).
    const ops: EditOp[] = doc.events.map((e) => ({ kind: "upsertEvent", event: e }));
    const out = applyEditsToBytes(raw, ops);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("edits an event (name + a popup effect) and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const src = doc.events[0]!;
    const edited = {
      ...src,
      name: "Тест: сигнал",
      effects: [
        ...src.effects,
        { kind: "popup", num: 99, text: "Привет, герой!", music: "", sound: "", image: "GEV0000", image2: "", leftSide: true, popupShow: 0, boolValue: false },
      ],
    } as (typeof src);
    const ops: EditOp[] = [{ kind: "upsertEvent", event: edited }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const got = re.events.find((e) => e.id === src.id)!;
    expect(got.name).toBe("Тест: сигнал");
    expect(got.effects.some((f) => f.kind === "popup" && (f as { text: string }).text === "Привет, герой!")).toBe(true);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(validateMap(re).ok).toBe(true);
  });

  it("adds a NEW event (append) then deletes it (splice) — round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const before = doc.events.length;
    const fresh = {
      id: "NEW00000001",
      name: "Новое событие",
      enabled: true, occurOnce: true, chance: 100, order: 0,
      appliesTo: { human: true, dwarf: false, undead: false, heretic: false, neutral: false, elf: false },
      canTrigger: { human: true, dwarf: false, undead: false, heretic: false, neutral: false, elf: false },
      conditions: [{ kind: "frequency", days: 7 }],
      effects: [{ kind: "winLose", num: 0, win: true, player: "" }],
    } as import("@d2/map-schema").MapEvent;
    const add: EditOp[] = [{ kind: "upsertEvent", event: fresh }];
    const outAdd = applyEditsToBytes(raw, add);
    const reAdd = parseScenario(outAdd);
    expect(reAdd.events.length).toBe(before + 1);
    const created = reAdd.events.find((e) => e.name === "Новое событие");
    expect(created).toBeTruthy();
    expect(created!.conditions[0]).toMatchObject({ kind: "frequency", days: 7 });
    // NOTE: parse(add) can't equal applyOps(add) because the client id "NEW*" is rewritten to
    // a real EV id on export — so we assert content, not roundTripSemantic, for the add case.

    // delete an EXISTING event splices its frame + decrements the count
    const victim = doc.events.find((e) => e.effects.every((f) => f.kind !== "changeFog"))!;
    // pick one not referenced by another event's enableEvent (guard would reject those)
    const refd = new Set(
      doc.events.flatMap((e) => e.effects.filter((f) => f.kind === "enableEvent").map((f) => (f as { eventId: string }).eventId)),
    );
    const del = doc.events.find((e) => !refd.has(e.id)) ?? victim;
    const delOps: EditOp[] = [{ kind: "deleteEvent", id: del.id }];
    const outDel = applyEditsToBytes(raw, delOps);
    const reDel = parseScenario(outDel);
    expect(reDel.events.find((e) => e.id === del.id)).toBeUndefined();
    expect(reDel.events.length).toBe(before - 1);
    const res = roundTripSemantic(doc, outDel, delOps);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });
});

describe("@d2/map-edit deleteObject (M4 mid-stream block splice)", () => {
  it("deletes a BASE landmark: block gone, OB0000 decremented, semantic + structural ok", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const victim = doc.objects.find((o) => o.type === "landmark" && o.baseType)!;
    const before = doc.objects.filter((o) => o.type === "landmark").length;
    const ops: EditOp[] = [{ kind: "deleteObject", id: victim.id }];

    const out = applyEditsToBytes(raw, ops);
    expect(out.length).toBeLessThan(bytes.length); // a whole block was spliced out

    // OB0000 count decremented by exactly 1
    const countAt = (b: Uint8Array): number => {
      const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
      const firstWhat = buf.indexOf("WHAT");
      const obAt = buf.lastIndexOf("OB0000", firstWhat);
      return buf.readInt32LE(obAt + 6);
    };
    expect(countAt(out)).toBe(countAt(bytes) - 1);

    const re = parseScenario(out);
    expect(re.objects.find((o) => o.id === victim.id)).toBeUndefined();
    expect(re.objects.filter((o) => o.type === "landmark").length).toBe(before - 1);

    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(validateMap(re).ok).toBe(true);
  });

  it("delete then UNDO (inverse addObject) restores the landmark and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const victim = doc.objects.find((o) => o.type === "landmark" && o.baseType)!;
    const del: EditOp = { kind: "deleteObject", id: victim.id };
    const inverse = invertOps(doc, [del]); // = addObject(victim)
    const journal = [del, ...inverse];

    const out = applyEditsToBytes(raw, journal);
    const re = parseScenario(out);
    const restored = re.objects.find(
      (o) => o.type === "landmark" && o.baseType === victim.baseType && o.pos.x === victim.pos.x && o.pos.y === victim.pos.y,
    );
    expect(restored).toBeTruthy();
    const res = roundTripSemantic(doc, out, journal);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("fails loud on unsupported types and unknown ids", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const stack = doc.objects.find((o) => o.type === "stack")!;
    expect(() => applyEditsToBytes(raw, [{ kind: "deleteObject", id: stack.id }])).toThrow(
      /not supported yet/,
    );
    expect(() => applyEditsToBytes(raw, [{ kind: "deleteObject", id: "S143XX9999" }])).toThrow(
      /unknown object/,
    );
  });
});

describe("@d2/map-edit foldOps (collab append-inverse undo of a placement)", () => {
  it("drops add→delete pairs plus every op targeting that id in between", () => {
    const obj = { type: "landmark", id: "CLIENT0001", pos: { x: 1, y: 1 } } as never;
    const ops: EditOp[] = [
      { kind: "setCell", x: 0, y: 0, value: 5 },
      { kind: "addObject", object: obj },
      { kind: "moveObject", id: "CLIENT0001", x: 2, y: 2 },
      { kind: "patchObject", id: "CLIENT0001", fields: { baseType: "MOMNE1" } },
      { kind: "setCell", x: 1, y: 0, value: 6 },
      { kind: "deleteObject", id: "CLIENT0001" },
    ];
    const folded = foldOps(ops);
    expect(folded).toEqual([
      { kind: "setCell", x: 0, y: 0, value: 5 },
      { kind: "setCell", x: 1, y: 0, value: 6 },
    ]);
  });

  it("keeps a deleteObject of a BASE object (no matching add) so the writer fails loudly", () => {
    const ops: EditOp[] = [{ kind: "deleteObject", id: "S143MM0001" }];
    expect(foldOps(ops)).toEqual(ops);
  });

  it("keeps a re-add after an undone add (add,delete,add of the same id)", () => {
    const obj = { type: "landmark", id: "CLIENT0001", pos: { x: 1, y: 1 } } as never;
    const ops: EditOp[] = [
      { kind: "addObject", object: obj },
      { kind: "deleteObject", id: "CLIENT0001" },
      { kind: "addObject", object: obj },
    ];
    expect(foldOps(ops)).toEqual([{ kind: "addObject", object: obj }]);
  });

  it("place mountain + append-inverse undo folds to a byte-appliable no-op (the ↻ bug)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const place = placeMountainOps(doc, 20, 20, 2, 2, 5);
    // collab undo = the exact inverses of the commit, appended as forward ops
    const undo = invertOps(doc, place);
    const journal = [...place, ...undo];
    // unfolded, the writer rejects deleteObject (M4)
    expect(() => applyEditsToBytes(raw, journal)).toThrow(/deleteObject/);
    // folded, it exports — and the result matches the in-memory model (semantic tier)
    const folded = foldOps(journal);
    expect(folded.some((o) => o.kind === "deleteObject" || o.kind === "addObject")).toBe(false);
    const out = applyEditsToBytes(raw, folded);
    const re = parseScenario(out);
    expect(re.objects.filter((o) => o.type === "mountains").length).toBe(
      doc.objects.filter((o) => o.type === "mountains").length,
    );
    expect(re.terrain.cells[20 * re.size + 20]!.value).toBe(
      doc.terrain.cells[20 * doc.size + 20]!.value, // 37-stamp restored by the inverse setCells
    );
    const res = roundTripSemantic(doc, out, folded);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });
});

describe("@d2/map-edit patchObject re-roll (look change, keeps footprint)", () => {
  it("re-rolls a landmark's baseType (TYPE) in place and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const lm = doc.objects.find((o) => o.type === "landmark" && o.baseType)!;
    const other = doc.objects.find(
      (o) => o.type === "landmark" && o.baseType && o.baseType !== lm.baseType,
    )!;
    const ops: EditOp[] = [{ kind: "patchObject", id: lm.id, fields: { baseType: other.baseType } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect(re.objects.find((o) => o.id === lm.id)!.baseType).toBe(other.baseType);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("re-rolls a mountain's image in place and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const mtn = doc.objects.find((o) => o.type === "mountains")!;
    const newImage = (mtn.image ?? 0) + 1;
    const ops: EditOp[] = [{ kind: "patchObject", id: mtn.id, fields: { image: newImage } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect(re.objects.find((o) => o.id === mtn.id)!.image).toBe(newImage);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("edits chest/ruin/city int fields (priority/image) in place and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const ops: EditOp[] = [];
    const checks: { id: string; field: "priority" | "image"; val: number }[] = [];
    // priority is only set when AIPRIORITY exists (so setObjectInt will find the tag)
    const withPrio = doc.objects.find(
      (o) => ["treasure", "ruin", "village"].includes(o.type) && (o as { priority?: number }).priority !== undefined,
    );
    if (withPrio) {
      const v = (((withPrio as { priority?: number }).priority ?? 0) + 1) % 7;
      ops.push({ kind: "patchObject", id: withPrio.id, fields: { priority: v } });
      checks.push({ id: withPrio.id, field: "priority", val: v });
    }
    // image only on a chest/ruin that actually carries IMAGE (mountains use a different path)
    const withImg = doc.objects.find(
      (o) => (o.type === "treasure" || o.type === "ruin") && (o as { image?: number }).image !== undefined,
    );
    if (withImg) {
      const v = ((withImg as { image?: number }).image ?? 0) + 1;
      ops.push({ kind: "patchObject", id: withImg.id, fields: { image: v } });
      checks.push({ id: withImg.id, field: "image", val: v });
    }
    expect(ops.length).toBeGreaterThan(0); // Riders has cities with AIPRIORITY at least
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    for (const c of checks) {
      expect((re.objects.find((o) => o.id === c.id) as Record<string, unknown>)[c.field]).toBe(c.val);
    }
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("edits a city NAME_TXT (variable-length) via the M4 growable splice — grow + shrink", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    // a village whose NAME_TXT is present (non-empty) so the field exists to resize
    const village = doc.objects.find((o) => o.type === "village" && ((o as { name?: string }).name?.length ?? 0) > 0);
    expect(village).toBeTruthy();
    const id = village!.id;
    for (const newName of ["Новый город с очень длинным именем", "Х"]) {
      const ops: EditOp[] = [{ kind: "patchObject", id, fields: { name: newName } }];
      const out = applyEditsToBytes(raw, ops);
      const re = parseScenario(out);
      expect((re.objects.find((o) => o.id === id) as { name?: string }).name).toBe(newName);
      expect(re.objects.length).toBe(doc.objects.length); // no object added/lost
      const res = roundTripSemantic(doc, out, ops);
      expect(res.reason).toBeUndefined();
      expect(res.ok).toBe(true);
    }
  });
});

describe("@d2/map-edit chest item list (M4 growable list — items are GItem templates)", () => {
  it("adds an item: list grows, new entry resolves to the chosen template, semantic round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const chest = doc.objects.find(
      (o) => o.type === "treasure" && ((o as { items?: string[] }).items?.length ?? 0) >= 1,
    ) as { id: string; items: string[] };
    expect(chest).toBeTruthy();
    const baseItems = chest.items; // already resolved to template ids
    const TEMPLATE = "G001IG0108";
    const desired = [...baseItems, TEMPLATE];
    const ops: EditOp[] = [{ kind: "patchObject", id: chest.id, fields: { items: desired } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reChest = re.objects.find((o) => o.id === chest.id) as { items: string[] };
    // the chest's items (resolved to templates) equal the desired list, in order
    expect(reChest.items).toEqual(desired);
    expect(validateMap(re).ok).toBe(true);
    const sem = roundTripSemantic(doc, out, ops);
    expect(sem.reason).toBeUndefined();
    expect(sem.ok).toBe(true);
  });

  it("removes an item: list shrinks, semantic round-trips, stays valid", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const chest = doc.objects.find(
      (o) => o.type === "treasure" && ((o as { items?: string[] }).items?.length ?? 0) >= 2,
    ) as { id: string; items: string[] };
    expect(chest).toBeTruthy();
    const kept = chest.items.slice(1); // drop the first item
    const ops: EditOp[] = [{ kind: "patchObject", id: chest.id, fields: { items: kept } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reChest = re.objects.find((o) => o.id === chest.id) as { items?: string[] };
    expect(reChest.items ?? []).toEqual(kept);
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("clears all items: list count goes to zero, semantic round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const chest = doc.objects.find(
      (o) => o.type === "treasure" && ((o as { items?: string[] }).items?.length ?? 0) >= 1,
    ) as { id: string };
    const ops: EditOp[] = [{ kind: "patchObject", id: chest.id, fields: { items: [] } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reChest = re.objects.find((o) => o.id === chest.id) as { items?: string[] };
    expect(reChest.items ?? []).toEqual([]);
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });
});

describe("@d2/map-edit site / capital / crystal edits", () => {
  const dragon = new Uint8Array(readFileSync(DRAGON));

  it("site (merchant/mage/…) name + image -> TXT_TITLE/IMG_ISO, round-trips", () => {
    const { doc, raw } = parseScenarioRaw(dragon);
    const site = doc.objects.find(
      (o) => ["merchant", "mage", "trainer", "mercenary"].includes(o.type) && (o as { name?: string }).name !== undefined,
    ) as { id: string };
    expect(site).toBeTruthy();
    const ops: EditOp[] = [{ kind: "patchObject", id: site.id, fields: { name: "Лавка диковин", image: 2 } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reSite = re.objects.find((o) => o.id === site.id) as { name?: string; image?: number };
    expect(reSite.name).toBe("Лавка диковин");
    expect(reSite.image).toBe(2);
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("crystal RESOURCE (mana school) round-trips", () => {
    const { doc, raw } = parseScenarioRaw(dragon);
    const cr = doc.objects.find((o) => o.type === "crystal") as { id: string; resource?: number };
    expect(cr).toBeTruthy();
    const newR = ((cr.resource ?? 0) + 1) % 6;
    const ops: EditOp[] = [{ kind: "patchObject", id: cr.id, fields: { resource: newR } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect((re.objects.find((o) => o.id === cr.id) as { resource?: number }).resource).toBe(newR);
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("capital name (NAME_TXT, variable-length) round-trips", () => {
    const { doc, raw } = parseScenarioRaw(dragon);
    const cap = doc.objects.find((o) => o.type === "capital") as { id: string };
    expect(cap).toBeTruthy();
    const ops: EditOp[] = [{ kind: "patchObject", id: cap.id, fields: { name: "Оплот героев" } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect((re.objects.find((o) => o.id === cap.id) as { name?: string }).name).toBe("Оплот героев");
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });
});

describe("@d2/map-edit garrison + site stocks", () => {
  const dragon = new Uint8Array(readFileSync(DRAGON));

  it("fort garrison: change a cell's unit -> new MidUnit instance, round-trips", () => {
    const { doc, raw } = parseScenarioRaw(dragon);
    const cap = doc.objects.find(
      (o) => o.type === "capital" && (o as { garrison?: unknown[] }).garrison?.some(Boolean),
    ) as { id: string; garrison: ({ unit: string; level: number; hp: number } | null)[] };
    expect(cap).toBeTruthy();
    const g = [...cap.garrison];
    g[0] = { unit: "G000UU0001", level: 1, hp: 110 }; // Squire
    const ops: EditOp[] = [{ kind: "patchObject", id: cap.id, fields: { garrison: g } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reCap = re.objects.find((o) => o.id === cap.id) as { garrison: ({ unit: string } | null)[] };
    expect(reCap.garrison[0]?.unit).toBe("G000UU0001");
    expect(re.objects.length).toBe(doc.objects.length); // MidUnit instances aren't placed objects
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("fort garrison: POS_i is CELL-indexed (cell i = UNIT_[POS_i]), matching D2RSG", () => {
    // Place units in SCATTERED cells (0 and 3 only) so the slot-vs-cell indexing direction
    // matters — a slot-indexed writer (the old bug) would mis-encode this and the game would
    // read it wrong. Decode the written bytes with the GAME formula independently of our reader.
    const { doc, raw } = parseScenarioRaw(dragon);
    const cap = doc.objects.find(
      (o) => o.type === "capital" && (o as { garrison?: unknown[] }).garrison,
    ) as { id: string };
    const g: ({ unit: string; level: number; hp: number } | null)[] = [null, null, null, null, null, null];
    g[0] = { unit: "G000UU0011", level: 1, hp: 50 }; // front-left
    g[3] = { unit: "G000UU0006", level: 1, hp: 45 }; // back-left
    const out = applyEditsToBytes(raw, [{ kind: "patchObject", id: cap.id, fields: { garrison: g } }]);

    // Read the fort's raw UNIT_0..5 + POS_0..5 from the written bytes.
    const bb = new ByteBuffer(out);
    let fFrom = -1, fEnd = -1;
    for (const o of iterateObjects(bb)) if (o.id === cap.id) { fFrom = o.fieldsFrom; fEnd = o.fieldsEnd; }
    expect(fFrom).toBeGreaterThan(0);
    const readUnit = (i: number): string => {
      const at = bb.indexOf(`UNIT_${i}`, fFrom);
      const p = at + `UNIT_${i}`.length;
      const len = bb.readInt32LE(p);
      return bb.asciiSlice(p + 4, p + 4 + Math.max(0, len - 1));
    };
    const readPos = (i: number): number => {
      const at = bb.indexOf(`POS_${i}`, fFrom);
      return bb.readInt32LE(at + `POS_${i}`.length);
    };
    expect(bb.indexOf("UNIT_0", fFrom)).toBeLessThan(fEnd);
    const UNIT = [0, 1, 2, 3, 4, 5].map(readUnit);
    const POS = [0, 1, 2, 3, 4, 5].map(readPos);

    // Two filled cells pack into the low UNIT_ slots (insertion order = ascending cell).
    expect(UNIT[0]).toMatch(/UN[0-9a-f]{4}$/); // cell 0's unit instance
    expect(UNIT[1]).toMatch(/UN[0-9a-f]{4}$/); // cell 3's unit instance
    expect(UNIT[2]).toBe("G000000000");
    // POS is CELL-indexed: cell0 -> slot 0, cell3 -> slot 1, the rest empty.
    expect(POS).toEqual([0, -1, -1, 1, -1, -1]);
    // GAME formula: cell i = UNIT_[POS_i].
    expect(UNIT[POS[0]!]).toBe(UNIT[0]); // cell 0 occupant
    expect(UNIT[POS[3]!]).toBe(UNIT[1]); // cell 3 occupant

    // And our reader agrees: garrison[0] + garrison[3] resolve to the chosen units, rest empty.
    const re = parseScenario(out);
    const reCap = re.objects.find((o) => o.id === cap.id) as { garrison: ({ unit: string } | null)[] };
    expect(reCap.garrison[0]?.unit).toBe("G000UU0011");
    expect(reCap.garrison[3]?.unit).toBe("G000UU0006");
    expect(reCap.garrison[1]).toBeNull();
    expect(reCap.garrison[2]).toBeNull();
    expect(reCap.garrison[4]).toBeNull();
    expect(reCap.garrison[5]).toBeNull();
    expect(validateMap(re).ok).toBe(true);
  });

  it("fort garrison: re-committing a real fort's garrison unchanged preserves every cell", () => {
    // Real forts have non-trivial POS permutations; an unchanged rewrite must reproduce the
    // exact cell->unit mapping (reader+writer agree on the cell-indexed convention).
    for (const src of [bytes, dragon]) {
      const { doc, raw } = parseScenarioRaw(src);
      const forts = doc.objects.filter(
        (o) => (o.type === "capital" || o.type === "village") &&
          (o as { garrison?: ({ unit: string } | null)[] }).garrison?.some(Boolean),
      ) as { id: string; garrison: ({ unit: string; level: number; hp: number } | null)[] }[];
      if (!forts.length) continue;
      const ops: EditOp[] = forts.map((ft) => ({
        kind: "patchObject", id: ft.id,
        fields: { garrison: ft.garrison.map((c) => (c ? { unit: c.unit, level: c.level, hp: c.hp } : null)) },
      }));
      const re = parseScenario(applyEditsToBytes(raw, ops));
      for (const ft of forts) {
        const reFt = re.objects.find((o) => o.id === ft.id) as { garrison: ({ unit: string } | null)[] };
        for (let cell = 0; cell < 6; cell++) {
          expect(reFt.garrison[cell]?.unit ?? null).toBe(ft.garrison[cell]?.unit ?? null);
        }
      }
    }
  });

  it("city defense and visitor are SEPARATE armies (no stackRef fallback merge)", () => {
    const doc = parseScenario(bytes); // Riders
    const cities = doc.objects.filter((o) => o.type === "village" || o.type === "capital") as {
      id: string; stackRef?: string; garrison?: ({ unit: string } | null)[];
    }[];
    // A city with a visiting stack but EMPTY own defense (Riders village FT0002 'Маргилла').
    const visited = cities.find((c) => c.stackRef && !(c.garrison ?? []).some(Boolean));
    expect(visited).toBeTruthy();
    expect((visited!.garrison ?? []).filter(Boolean).length).toBe(0); // defense stays empty (no merge)
    const visitor = doc.objects.find((o) => o.id === visited!.stackRef) as {
      type: string; garrison?: ({ unit: string } | null)[];
    };
    expect(visitor?.type).toBe("stack");
    expect((visitor.garrison ?? []).filter(Boolean).length).toBeGreaterThan(0); // the visitor has its own units
  });

  it("capital desc + AI priority round-trip", () => {
    const { doc, raw } = parseScenarioRaw(dragon);
    const cap = doc.objects.find((o) => o.type === "capital") as { id: string };
    const ops: EditOp[] = [{ kind: "patchObject", id: cap.id, fields: { desc: "Тест столицы", priority: 5 } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reCap = re.objects.find((o) => o.id === cap.id) as { desc?: string; priority?: number };
    expect(reCap.desc).toBe("Тест столицы");
    expect(reCap.priority).toBe(5);
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("merchant stock: add an item -> QTY_ITEM list, round-trips", () => {
    const { doc, raw } = parseScenarioRaw(dragon);
    const m = doc.objects.find((o) => o.type === "merchant" && (o as { items?: unknown[] }).items?.length) as {
      id: string; items: { id: string; count: number }[];
    };
    const items = [...m.items, { id: "G000IG0001", count: 7 }];
    const ops: EditOp[] = [{ kind: "patchObject", id: m.id, fields: { items } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reM = re.objects.find((o) => o.id === m.id) as { items: { id: string; count: number }[] };
    expect(reM.items).toEqual(items);
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("mage stock: drop a spell -> QTY_SPELL list, round-trips", () => {
    const { doc, raw } = parseScenarioRaw(dragon);
    const m = doc.objects.find((o) => o.type === "mage" && (o as { spells?: unknown[] }).spells?.length) as {
      id: string; spells: string[];
    };
    const spells = m.spells.slice(1);
    const ops: EditOp[] = [{ kind: "patchObject", id: m.id, fields: { spells } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect((re.objects.find((o) => o.id === m.id) as { spells: string[] }).spells).toEqual(spells);
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("mercenary stock: add a unit -> QTY_UNIT list, round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes); // Riders has a mercenary camp
    const m = doc.objects.find((o) => o.type === "mercenary" && (o as { units?: unknown[] }).units?.length) as {
      id: string; units: { id: string; level: number; unique: boolean }[];
    };
    expect(m).toBeTruthy();
    const units = [...m.units, { id: "G000UU0093", level: 2, unique: false }];
    const ops: EditOp[] = [{ kind: "patchObject", id: m.id, fields: { units } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect((re.objects.find((o) => o.id === m.id) as { units: unknown[] }).units).toEqual(units);
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });
});

describe("@d2/map-edit stack (Отряд) editor", () => {
  it("formation + leader round-trip (units recreate, LEADER_ID follows the leader cell)", () => {
    const { doc, raw } = parseScenarioRaw(bytes); // Riders
    const st = doc.objects.find(
      (o) => o.type === "stack" && !(o as { garrisoned?: boolean }).garrisoned &&
        (o as { garrison?: ({ unit: string } | null)[] }).garrison?.some(Boolean),
    ) as { id: string; garrison: ({ unit: string; level: number; hp: number } | null)[] };
    expect(st).toBeTruthy();
    const g = st.garrison.map((c) => (c ? { unit: c.unit, level: c.level, hp: c.hp } : null));
    while (g.length < 6) g.push(null);
    const free = g.findIndex((c) => !c);
    if (free >= 0) g[free] = { unit: "G000UU0001", level: 1, hp: 110 };
    const leaderCell = g.findIndex(Boolean);
    const leaderImage = g[leaderCell]!.unit;
    const ops: EditOp[] = [{ kind: "patchObject", id: st.id, fields: { garrison: g, leaderCell, leaderImage } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reSt = re.objects.find((o) => o.id === st.id) as {
      leaderCell?: number; leaderImage?: string; garrison: ({ unit: string } | null)[];
    };
    expect(reSt.leaderCell).toBe(leaderCell);
    expect(reSt.leaderImage).toBe(leaderImage);
    if (free >= 0) expect(reSt.garrison[free]?.unit).toBe("G000UU0001");
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("scalar fields (order/facing/morale/move) round-trip", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const st = doc.objects.find(
      (o) => o.type === "stack" &&
        ["order", "facing", "morale", "move"].every((k) => (o as Record<string, unknown>)[k] !== undefined),
    ) as { id: string };
    expect(st).toBeTruthy();
    const ops: EditOp[] = [{ kind: "patchObject", id: st.id, fields: { order: 3, facing: 4, morale: 2, move: 25 } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reSt = re.objects.find((o) => o.id === st.id) as { order: number; facing: number; morale: number; move: number };
    expect([reSt.order, reSt.facing, reSt.morale, reSt.move]).toEqual([3, 4, 2, 25]);
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("leader equipment round-trip (set an artifact slot)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const st = doc.objects.find((o) => o.type === "stack" && (o as { equip?: object }).equip) as {
      id: string; equip: Record<string, string | undefined>;
    };
    expect(st).toBeTruthy();
    const equip = { ...st.equip, artifact1: "G000IG0001" };
    const ops: EditOp[] = [{ kind: "patchObject", id: st.id, fields: { equip } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reSt = re.objects.find((o) => o.id === st.id) as { equip: Record<string, string | undefined> };
    expect(reSt.equip.artifact1).toBe("G000IG0001");
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("banner slot round-trip (BANNER ref)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const st = doc.objects.find((o) => o.type === "stack") as { id: string };
    const ops: EditOp[] = [{ kind: "patchObject", id: st.id, fields: { banner: "G000IG0001" } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect((re.objects.find((o) => o.id === st.id) as { banner?: string }).banner).toBe("G000IG0001");
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("add a visiting hero to a city — new MidStack + STACK link, round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes); // Riders
    const city = doc.objects.find(
      (o) => (o.type === "village" || o.type === "capital") && !(o as { stackRef?: string }).stackRef,
    ) as { id: string; pos: { x: number; y: number }; owner?: string };
    expect(city).toBeTruthy();
    const ops = placeVisitorOps(doc, city);
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reCity = re.objects.find((o) => o.id === city.id) as { stackRef?: string };
    expect(reCity.stackRef).toBeTruthy();
    const vis = re.objects.find((o) => o.id === reCity.stackRef) as {
      type: string; inside?: string; garrisoned?: boolean; garrison?: ({ unit: string } | null)[];
    };
    expect(vis.type).toBe("stack");
    expect(vis.inside).toBe(city.id);
    expect(vis.garrisoned).toBe(true);
    expect((vis.garrison ?? []).filter(Boolean).length).toBe(0); // empty formation
    expect(re.objects.length).toBe(doc.objects.length + 1); // exactly one new placed object
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });

  it("inventory round-trip (mid-block ITEM_ID list — add an item)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const st = doc.objects.find((o) => o.type === "stack") as { id: string; inventory?: string[] };
    const inventory = [...(st.inventory ?? []), "G000IG0001"];
    const ops: EditOp[] = [{ kind: "patchObject", id: st.id, fields: { inventory } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect((re.objects.find((o) => o.id === st.id) as { inventory?: string[] }).inventory).toEqual(inventory);
    expect(re.objects.length).toBe(doc.objects.length); // MidItem instances aren't placed objects
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });
});

describe("@d2/map-edit location editor", () => {
  it("name + radius round-trip", () => {
    const { doc, raw } = parseScenarioRaw(bytes); // Riders
    const loc = doc.objects.find((o) => o.type === "location") as { id: string };
    expect(loc).toBeTruthy();
    const ops: EditOp[] = [{ kind: "patchObject", id: loc.id, fields: { name: "Тестовая область", radius: 3 } }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reLoc = re.objects.find((o) => o.id === loc.id) as { name: string; radius: number };
    expect(reLoc.name).toBe("Тестовая область");
    expect(reLoc.radius).toBe(3);
    expect(validateMap(re).ok).toBe(true);
    expect(roundTripSemantic(doc, out, ops).ok).toBe(true);
  });
});

describe("@d2/map-edit project (journal + undo/redo)", () => {
  it("pushOp / undo / redo move the cursor and gate activeOps", () => {
    const op1: EditOp = { kind: "setCell", x: 1, y: 1, value: 1 };
    const op2: EditOp = { kind: "setCell", x: 2, y: 2, value: 2 };
    let p = emptyProject("map-id", { name: "test" });
    p = pushOp(p, op1);
    p = pushOp(p, op2);
    expect(activeOps(p)).toEqual([op1, op2]);
    expect(canUndo(p)).toBe(true);
    expect(canRedo(p)).toBe(false);
    p = undo(p);
    expect(activeOps(p)).toEqual([op1]);
    expect(canRedo(p)).toBe(true);
    p = redo(p);
    expect(activeOps(p)).toEqual([op1, op2]);
    // a new op after undo truncates the redo tail
    p = undo(p);
    const op3: EditOp = { kind: "setCell", x: 3, y: 3, value: 3 };
    p = pushOp(p, op3);
    expect(activeOps(p)).toEqual([op1, op3]);
    expect(canRedo(p)).toBe(false);
  });

  it("serialize / deserialize round-trips and validates", () => {
    let p = emptyProject("map-id");
    p = pushOp(p, { kind: "moveObject", id: "S143ST0001", x: 5, y: 6 });
    const restored = deserializeProject(serializeProject(p));
    expect(restored).toEqual(p);
  });
});
