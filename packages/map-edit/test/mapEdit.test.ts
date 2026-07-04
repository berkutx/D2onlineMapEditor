import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseScenarioRaw, parseScenario, validateMap, ByteBuffer, iterateObjects, ruinFrame } from "@d2/sg-parser";
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
  deleteMountainOps,
  placeLandmarkOps,
  placeLocationOps,
  placeVisitorOps,
  placeChestOps,
  placeVillageOps,
  placeStackOps,
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

/** Walk the MidgardPlan block of `b` and return its entry count. Layout byte-verified:
 *  BEGOBJECT\0 · <blockId(10)> i32 mapSize · <blockId(10)> i32 count · 40-byte entries. */
const planCount = (b: Uint8Array): number => {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const avc = buf.indexOf(".?AVCMidgardPlan@@");
  expect(avc).toBeGreaterThan(0);
  const beg = buf.indexOf("BEGOBJECT", avc);
  return buf.readInt32LE(beg + 10 + 10 + 4 + 10);
};
/** All plan cells whose ELEMENT ref equals `id` (entry = POS_X i32 POS_Y i32 ELEMENT ref). */
const planCellsOf = (b: Uint8Array, id: string): { x: number; y: number }[] => {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const avc = buf.indexOf(".?AVCMidgardPlan@@");
  const beg = buf.indexOf("BEGOBJECT", avc);
  let p = beg + 10 + 10 + 4 + 10;
  const count = buf.readInt32LE(p);
  p += 4;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const x = buf.readInt32LE(p + 5);
    const y = buf.readInt32LE(p + 14);
    const ref = buf.toString("latin1", p + 29, p + 39);
    if (ref === id) out.push({ x, y });
    p += 40;
  }
  return out;
};

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

describe("@d2/map-edit scenario variables (E3)", () => {
  it("parses MidScenVariables (Riders has named script vars)", () => {
    const { doc } = parseScenarioRaw(bytes);
    expect(doc.variables.length).toBeGreaterThan(0);
    expect(doc.variables[0]).toMatchObject({ id: expect.any(Number), name: expect.any(String) });
    expect(doc.variables.some((v) => v.name === "QUEST")).toBe(true);
  });

  it("re-serializes the variables block identically (setVariables to itself)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const ops: EditOp[] = [{ kind: "setVariables", variables: doc.variables }];
    const out = applyEditsToBytes(raw, ops);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("edits + adds a variable and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const nextId = Math.max(0, ...doc.variables.map((v) => v.id)) + 1;
    const variables = [
      ...doc.variables.map((v) => (v.name === "QUEST" ? { ...v, value: 42 } : v)),
      { id: nextId, name: "MY_FLAG", value: 7 },
    ];
    const ops: EditOp[] = [{ kind: "setVariables", variables }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect(re.variables.find((v) => v.name === "QUEST")!.value).toBe(42);
    expect(re.variables.find((v) => v.name === "MY_FLAG")).toMatchObject({ id: nextId, value: 7 });
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(validateMap(re).ok).toBe(true);
  });
});

describe("@d2/map-edit stack templates (E3)", () => {
  it("parses MidStackTemplate blocks (Riders has ~79) with resolved unit cells", () => {
    const { doc } = parseScenarioRaw(bytes);
    expect(doc.templates.length).toBeGreaterThan(0);
    const t = doc.templates.find((x) => x.units.some((u) => u));
    expect(t).toBeTruthy();
    expect(t!.leader).toMatch(/^G/); // a global Gunit id
    expect(t!.units.filter(Boolean).length).toBeGreaterThan(0);
  });

  it("EVERY template re-serializes semantically (upsert each to itself)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const ops: EditOp[] = doc.templates.map((t) => ({ kind: "upsertTemplate", template: t }));
    const out = applyEditsToBytes(raw, ops);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("edits a template (name + a unit cell) and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const src = doc.templates.find((t) => t.units.some((u) => u))!;
    const units = src.units.slice();
    // change the first filled cell's level
    const ci = units.findIndex((u) => u);
    units[ci] = { ...(units[ci]!), level: 5 };
    const edited = { ...src, name: "Тест-шаблон", units };
    const ops: EditOp[] = [{ kind: "upsertTemplate", template: edited }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const got = re.templates.find((t) => t.id === src.id)!;
    expect(got.name).toBe("Тест-шаблон");
    expect(got.units[ci]!.level).toBe(5);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(validateMap(re).ok).toBe(true);
  });

  it("adds a NEW template (valid TM id) + round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    let next = 0;
    for (const t of doc.templates) { const m = /TM([0-9a-fA-F]{4})$/.exec(t.id); if (m) next = Math.max(next, parseInt(m[1]!, 16) + 1); }
    const id = `${doc.header.version}TM${next.toString(16).padStart(4, "0")}`;
    const leaderUnit = doc.templates.find((t) => t.leader)?.leader ?? "G000UU0001";
    const fresh = {
      id, name: "Засадный отряд", owner: "", leader: leaderUnit, leaderLevel: 1,
      orderTarget: "", subRace: "", order: 1,
      units: [null, null, { unit: leaderUnit, level: 1 }, null, null, null],
      useFacing: false, facing: 0, aiPriority: 0, modifiers: [],
    } as import("@d2/map-schema").StackTemplate;
    const ops: EditOp[] = [{ kind: "upsertTemplate", template: fresh }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect(re.templates.length).toBe(doc.templates.length + 1);
    const got = re.templates.find((t) => t.id === id)!;
    expect(got.name).toBe("Засадный отряд");
    expect(got.units[2]).toMatchObject({ unit: leaderUnit, level: 1 });
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });
});

describe("@d2/map-edit scenario settings + diplomacy (E4)", () => {
  it("parses the extended ScenarioInfo (texts + limits) and diplomacy from Riders", () => {
    const { doc } = parseScenarioRaw(bytes);
    expect(doc.header.winText).toContain("Поздравляем");
    expect(doc.header.story!.length).toBeGreaterThan(300); // BRIEFLONG1-3 joined
    expect(doc.header.loseText!.length).toBeGreaterThan(0);
    expect(doc.header.limits).toEqual({ unit: 10, spell: 5, leader: 99, city: 5 });
    expect(doc.header.suggestedLevel).toBe(1);
    expect(doc.diplomacy).toEqual([
      { race1: 4, race2: 0, relation: 0 },
      { race1: 4, race2: 1, relation: 0 },
      { race1: 0, race2: 1, relation: 0 },
    ]);
  });

  it("setScenarioInfo round-trips: name (header+block), long win text (multi-part), limits", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const longWin = "Победа! ".repeat(60).trim(); // ~470 chars -> needs 2 multi-parts
    const ops: EditOp[] = [{
      kind: "setScenarioInfo",
      fields: {
        name: "Riders-2",
        author: "тест",
        objective: "Новая цель",
        winText: longWin,
        limits: { unit: 8, spell: 4, leader: 50, city: 4 },
        suggestedLevel: 3,
      },
    }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect(re.header.name).toBe("Riders-2");
    expect(re.header.author).toBe("тест");
    expect(re.header.objective).toBe("Новая цель");
    expect(re.header.winText).toBe(longWin);
    expect(re.header.limits).toEqual({ unit: 8, spell: 4, leader: 50, city: 4 });
    expect(re.header.suggestedLevel).toBe(3);
    // the FILE HEADER name (fixed offset 321, 64B zero-padded) must match too
    const headerName = Buffer.from(out.buffer, out.byteOffset + 321, 64);
    expect(headerName.toString("latin1").replace(/\0+$/, "")).toBe("Riders-2");
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(validateMap(re).ok).toBe(true);
  });

  it("setDiplomacy round-trips (change relation + add a pair)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const diplomacy = [
      { race1: 4, race2: 0, relation: 49 },
      { race1: 4, race2: 1, relation: 0 },
      { race1: 0, race2: 1, relation: 100 },
    ];
    const ops: EditOp[] = [{ kind: "setDiplomacy", diplomacy }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect(re.diplomacy).toEqual(diplomacy);
    const res = roundTripSemantic(doc, out, ops);
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

  it("fails loud on refused/unsupported types and unknown ids", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    // capitals are load-bearing (race integrity) — deletion is REFUSED, not just unsupported
    const capital = doc.objects.find((o) => o.type === "capital")!;
    expect(capital, "Riders has a capital").toBeTruthy();
    expect(() => applyEditsToBytes(raw, [{ kind: "deleteObject", id: capital.id }])).toThrow(
      /refused/,
    );
    // sites still lack a re-add frame for undo — unsupported, fail loud
    const site = doc.objects.find(
      (o) => o.type === "merchant" || o.type === "mage" || o.type === "trainer" || o.type === "mercenary",
    );
    if (site) {
      expect(() => applyEditsToBytes(raw, [{ kind: "deleteObject", id: site.id }])).toThrow(
        /not supported yet/,
      );
    }
    expect(() => applyEditsToBytes(raw, [{ kind: "deleteObject", id: "S143XX9999" }])).toThrow(
      /unknown object/,
    );
  });

  it("deletes a FREE stack: cascades garrison MidUnit + inventory MidItem, round-trips", () => {
    // seed a fresh army (leader + a unit + an inventory item), export + reparse so it becomes a
    // PRE-EXISTING block, then delete it — exercises the dependent-block cascade + OB0000 decrement.
    const { doc: d0, raw: r0 } = parseScenarioRaw(bytes);
    const owner = d0.players[0]!.id;
    const units: ({ unit: string; level?: number; hp?: number } | null)[] =
      [{ unit: "G000UU0001", level: 1, hp: 110 }, null, { unit: "G000UU0001", level: 3, hp: 50 }, null, null, null];
    const place = placeStackOps(d0, 24, 25, { owner, units, leaderCell: 2 });
    const stackId = (place.find((o) => o.kind === "addObject") as Extract<EditOp, { kind: "addObject" }>).object.id;
    // give it an inventory item so a MidItem instance is also cascaded
    const seedOps: EditOp[] = [...place, { kind: "patchObject", id: stackId, fields: { inventory: ["G000IG0001"] } }];
    const seeded = applyEditsToBytes(r0, seedOps);

    const { doc, raw } = parseScenarioRaw(seeded);
    const stack = doc.objects.find((o) => o.id === stackId)!;
    expect(stack, "seeded stack is now pre-existing").toBeTruthy();
    const midUnits = (b: Uint8Array): number =>
      [...iterateObjects(new ByteBuffer(b))].filter((o) => o.typeName === "MidUnit").length;
    const midItems = (b: Uint8Array): number =>
      [...iterateObjects(new ByteBuffer(b))].filter((o) => o.typeName === "MidItem").length;

    const ops: EditOp[] = [{ kind: "deleteObject", id: stackId }];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect(re.objects.find((o) => o.id === stackId)).toBeUndefined();
    // the 2 garrison MidUnit instances + the 1 inventory MidItem are gone with the stack
    expect(midUnits(out)).toBe(midUnits(seeded) - 2);
    expect(midItems(out)).toBe(midItems(seeded) - 1);

    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(validateMap(re).ok).toBe(true);
  });

  it("delete-a-free-stack then UNDO (inverse addObject) restores its army and round-trips", () => {
    const { doc: d0, raw: r0 } = parseScenarioRaw(bytes);
    const owner = d0.players[0]!.id;
    const units: ({ unit: string; level?: number; hp?: number } | null)[] =
      [{ unit: "G000UU0001", level: 2, hp: 90 }, null, null, null, null, null];
    const place = placeStackOps(d0, 26, 27, { owner, units, leaderCell: 0 });
    const stackId = (place.find((o) => o.kind === "addObject") as Extract<EditOp, { kind: "addObject" }>).object.id;
    const seeded = applyEditsToBytes(r0, [...place]);
    const { doc, raw } = parseScenarioRaw(seeded);

    const del: EditOp = { kind: "deleteObject", id: stackId };
    const inverse = invertOps(doc, [del]); // = addObject(the full stack, garrison intact)
    const journal = [del, ...inverse];
    const out = applyEditsToBytes(raw, journal);
    const re = parseScenario(out);
    const restored = re.objects.find(
      (o) => o.type === "stack" && o.pos.x === 26 && o.pos.y === 27,
    ) as { garrison?: ({ unit: string } | null)[] } | undefined;
    expect(restored).toBeTruthy();
    expect(restored!.garrison?.[0]?.unit).toBe("G000UU0001"); // army survived the delete+re-add
    const res = roundTripSemantic(doc, out, journal);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("refuses to delete a city's VISITING hero stack (manage it via the city)", () => {
    // seed a city visitor (empty stack linked via INSIDE + city.STACK), reparse, then try to delete
    const { doc: d0, raw: r0 } = parseScenarioRaw(bytes);
    const city = d0.objects.find((o) => o.type === "capital" || o.type === "village")!;
    const place = placeVisitorOps(d0, { id: city.id, pos: city.pos, owner: (city as { owner?: string }).owner });
    const visitorId = (place.find((o) => o.kind === "addObject") as Extract<EditOp, { kind: "addObject" }>).object.id;
    const seeded = applyEditsToBytes(r0, place);
    const { raw } = parseScenarioRaw(seeded);
    expect(() => applyEditsToBytes(raw, [{ kind: "deleteObject", id: visitorId }])).toThrow(
      /visiting hero/,
    );
  });

  // MidTalismanCharges entry count: <blockId(10)> int32 count right after BEGOBJECT\0
  // (byte-verified layout: toolsqt D2TalismanCharges.h == Riders.sg hexdump).
  const talismanCount = (b: Uint8Array): number => {
    const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    const avc = buf.indexOf(".?AVCMidTalismanCharges@@");
    expect(avc, "map has a MidTalismanCharges block").toBeGreaterThan(0);
    let p = buf.indexOf("BEGOBJECT", avc) + 9;
    if (buf[p] === 0) p++;
    return buf.readInt32LE(p + 10);
  };
  // a real GItem talisman template (itemCatalog catKey L_TALISMAN — "Амулет Орд Нежити")
  const TALISMAN = "G000IG9126";
  const TALIS_OPTS = { talismanTemplates: new Set([TALISMAN]) };

  it("chest with a TALISMAN: minted MidItem gets a charges entry; chest delete purges it", () => {
    const { doc: d0, raw: r0 } = parseScenarioRaw(bytes);
    const tc0 = talismanCount(bytes);
    const place = placeChestOps(d0, 30, 31, 1, [TALISMAN, "G000IG0001"]);
    const chestId = (place.find((o) => o.kind === "addObject") as Extract<EditOp, { kind: "addObject" }>).object.id;
    const seeded = applyEditsToBytes(r0, place, TALIS_OPTS);
    // exactly ONE charges entry added (the potion G000IG0001 gets none), Riders' 14 intact
    expect(talismanCount(seeded)).toBe(tc0 + 1);
    const resAdd = roundTripSemantic(d0, seeded, place);
    expect(resAdd.reason).toBeUndefined();
    expect(resAdd.ok).toBe(true);

    // delete the chest -> its 2 MidItem instances cascade, the talisman's TC entry purged
    const { doc, raw } = parseScenarioRaw(seeded);
    const ops: EditOp[] = [{ kind: "deleteObject", id: chestId }];
    const out = applyEditsToBytes(raw, ops);
    expect(talismanCount(out)).toBe(tc0);
    const re = parseScenario(out);
    expect(re.objects.find((o) => o.id === chestId)).toBeUndefined();
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(validateMap(re).ok).toBe(true);
  });

  it("stack with a TALISMAN in inventory: delete cascades the item AND its charges entry", () => {
    const { doc: d0, raw: r0 } = parseScenarioRaw(bytes);
    const tc0 = talismanCount(bytes);
    const owner = d0.players[0]!.id;
    const place = placeStackOps(d0, 32, 33, {
      owner, units: [{ unit: "G000UU0001", level: 1, hp: 100 }, null, null, null, null, null], leaderCell: 0,
    });
    const stackId = (place.find((o) => o.kind === "addObject") as Extract<EditOp, { kind: "addObject" }>).object.id;
    const seeded = applyEditsToBytes(
      r0,
      [...place, { kind: "patchObject", id: stackId, fields: { inventory: [TALISMAN] } }],
      TALIS_OPTS,
    );
    expect(talismanCount(seeded)).toBe(tc0 + 1);

    const { doc, raw } = parseScenarioRaw(seeded);
    const ops: EditOp[] = [{ kind: "deleteObject", id: stackId }];
    const out = applyEditsToBytes(raw, ops);
    expect(talismanCount(out)).toBe(tc0); // removeItem cascade: entry gone with the instance
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(validateMap(parseScenario(out)).ok).toBe(true);
  });

  it("deletes a VILLAGE: garrison MidUnit cascade, plan -16; delete+UNDO keeps ONE plan set", () => {
    const { doc: d0, raw: r0 } = parseScenarioRaw(bytes);
    const place = placeVillageOps(d0, 40, 41, "Сносимск");
    const vilId = (place.find((o) => o.kind === "addObject") as Extract<EditOp, { kind: "addObject" }>).object.id;
    const g = [null, { unit: "G000UU0001", level: 2, hp: 80 }, null, null, null, null];
    const seeded = applyEditsToBytes(r0, [...place, { kind: "patchObject", id: vilId, fields: { garrison: g } }]);
    const { doc, raw } = parseScenarioRaw(seeded);
    const midUnits = (b: Uint8Array): number =>
      [...iterateObjects(new ByteBuffer(b))].filter((o) => o.typeName === "MidUnit").length;

    // plain delete: village + its garrison unit gone, its 16 plan entries purged
    const del: EditOp = { kind: "deleteObject", id: vilId };
    const out = applyEditsToBytes(raw, [del]);
    const re = parseScenario(out);
    expect(re.objects.find((o) => o.id === vilId)).toBeUndefined();
    expect(midUnits(out)).toBe(midUnits(seeded) - 1);
    expect(planCount(out)).toBe(planCount(seeded) - 16);
    const res = roundTripSemantic(doc, out, [del]);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(validateMap(re).ok).toBe(true);

    // delete + UNDO (same-id re-add): the survivor keeps EXACTLY ONE set of plan entries
    // (the reviewer's regression: purge used to kill both the original AND the re-added set)
    const inverse = invertOps(doc, [del]);
    const journal = [del, ...inverse];
    const outUndo = applyEditsToBytes(raw, journal);
    expect(planCount(outUndo)).toBe(planCount(seeded)); // not -16, not +16
    expect(planCellsOf(outUndo, vilId).length).toBe(16);
    const resU = roundTripSemantic(doc, outUndo, journal);
    expect(resU.reason).toBeUndefined();
    expect(resU.ok).toBe(true);
  });

  it("duplicate deleteObject of the same id (peer race) splices ONE frame, not two", () => {
    const { raw, doc } = parseScenarioRaw(bytes);
    const victim = doc.objects.find((o) => o.type === "landmark" && o.baseType)!;
    const twice: EditOp[] = [
      { kind: "deleteObject", id: victim.id },
      { kind: "deleteObject", id: victim.id },
    ];
    const out = applyEditsToBytes(raw, twice); // must not shift-cut an innocent range
    const countAt = (b: Uint8Array): number => {
      const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
      const obAt = buf.lastIndexOf("OB0000", buf.indexOf("WHAT"));
      return buf.readInt32LE(obAt + 6);
    };
    expect(countAt(out)).toBe(countAt(bytes) - 1); // decremented ONCE
    const re = parseScenario(out);
    expect(re.objects.find((o) => o.id === victim.id)).toBeUndefined();
    expect(validateMap(re).ok).toBe(true);
  });

  it("ruinFrame reproduces a REAL Riders ruin frame byte-for-byte (layout gold check)", () => {
    const { raw } = parseScenarioRaw(bytes);
    const buf = new ByteBuffer(bytes);
    const ruin = raw.objects.find((o) => o.typeName === "MidRuin")!;
    // original frame slice: [WHAT .. ENDOBJECT+NUL)
    const start = buf.lastIndexOf("WHAT", ruin.fieldsFrom);
    const end = buf.indexOf("ENDOBJECT", ruin.fieldsFrom) + 10;
    const original = bytes.subarray(start, end);
    // rebuild the frame from RAW field reads (same instance ids -> must be byte-identical)
    const rd = (tag: string): string | null => {
      const i = buf.indexOf(tag, ruin.fieldsFrom);
      if (i < 0 || i >= ruin.fieldsEnd) return null;
      let at = i + tag.length;
      const len = buf.readInt32LE(at);
      at += 4;
      return buf.cp1251Slice(at, at + len).replace(/\0+$/, "");
    };
    const ri = (tag: string): number => {
      const i = buf.indexOf(tag, ruin.fieldsFrom);
      return buf.readInt32LE(i + tag.length);
    };
    const unitSlots = Array.from({ length: 6 }, (_, s) => rd(`UNIT_${s}`) ?? "G000000000");
    const posOfCell = Array.from({ length: 6 }, (_, s) => ri(`POS_${s}`));
    const second = parseInt(ruin.id.slice(6), 16);
    const rebuilt = ruinFrame("S143", second, {
      posX: ri("POS_X"), posY: ri("POS_Y"),
      name: rd("TITLE") ?? "", desc: rd("DESC") ?? "",
      image: ri("IMAGE"), reward: rd("CASH") ?? "",
      item: rd("ITEM") ?? undefined, looter: rd("LOOTER") ?? undefined,
      priority: ri("AIPRIORITY"),
      unitSlots, posOfCell,
    });
    expect(Buffer.from(rebuilt).toString("hex")).toBe(Buffer.from(original).toString("hex"));
  });

  it("deletes a RUIN: guardian MidUnit cascade, plan -9; delete+UNDO restores the guards", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    // count [0B 00 00 00]+id refs in the whole file: own frame carries 3 (OBJ_ID/RUIN_ID/
    // GROUP_ID) + 9 plan entries = 12; MORE means an event/quest still points at the ruin
    // (the referential guard would — correctly — refuse that delete; pick a clean one).
    const refCount = (id: string): number => {
      const hay = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const needle = Buffer.concat([Buffer.from([0x0b, 0, 0, 0]), Buffer.from(id, "latin1")]);
      let n = 0;
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) n++;
      return n;
    };
    const ruin = doc.objects.find(
      (o) =>
        o.type === "ruin" &&
        (o as { garrison?: unknown[] }).garrison?.some(Boolean) &&
        refCount(o.id) === 12,
    ) as { id: string; garrison: ({ unit: string } | null)[] };
    expect(ruin, "Riders has an event-free guarded ruin").toBeTruthy();
    const guards = ruin.garrison.filter(Boolean).length;
    expect(guards).toBeGreaterThan(0);
    const midUnits = (b: Uint8Array): number =>
      [...iterateObjects(new ByteBuffer(b))].filter((o) => o.typeName === "MidUnit").length;

    // plain delete: ruin + its guards gone, its 9 plan entries purged
    const del: EditOp = { kind: "deleteObject", id: ruin.id };
    const out = applyEditsToBytes(raw, [del]);
    const re = parseScenario(out);
    expect(re.objects.find((o) => o.id === ruin.id)).toBeUndefined();
    expect(midUnits(out)).toBe(midUnits(bytes) - guards);
    expect(planCount(out)).toBe(planCount(bytes) - 9);
    const res = roundTripSemantic(doc, out, [del]);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(validateMap(re).ok).toBe(true);

    // delete + UNDO: the guards come back (fresh MidUnit instances, same units/levels/hp)
    const journal = [del, ...invertOps(doc, [del])];
    const outUndo = applyEditsToBytes(raw, journal);
    const reU = parseScenario(outUndo);
    const restored = reU.objects.find((o) => o.id === ruin.id) as typeof ruin | undefined;
    expect(restored).toBeTruthy();
    expect(restored!.garrison.filter(Boolean).length).toBe(guards);
    expect(planCount(outUndo)).toBe(planCount(bytes)); // survivor keeps ONE set of entries
    const resU = roundTripSemantic(doc, outUndo, journal);
    expect(resU.reason).toBeUndefined();
    expect(resU.ok).toBe(true);
  });

  it("deletes a mountain entry: block rebuilt, survivors renumber, terrain restored, round-trips", () => {
    // seed 3 mountains on EMPTY cells (Riders already has 168 mountains — placing on one would
    // share its footprint and correctly skip the restore), reparse so they're pre-existing
    // entries, then delete the 2nd-to-last so exactly one survivor renumbers.
    const { doc: d0, raw: r0 } = parseScenarioRaw(bytes);
    const mtnCells = new Set(
      d0.objects.filter((o) => o.type === "mountains").flatMap((m) => {
        const w = (m as { w?: number }).w ?? 1, h = (m as { h?: number }).h ?? 1, out: string[] = [];
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) out.push(`${m.pos.x + dx},${m.pos.y + dy}`);
        return out;
      }),
    );
    const spots: [number, number, number][] = [];
    for (let y = 2; y < d0.size - 1 && spots.length < 3; y += 5)
      for (let x = 2; x < d0.size - 1 && spots.length < 3; x += 5)
        if (!mtnCells.has(`${x},${y}`) && d0.terrain.cells[y * d0.size + x]!.value !== 5)
          spots.push([x, y, 3]);
    expect(spots.length).toBe(3);
    let d = d0;
    const seedOps: EditOp[] = [];
    for (const [x, y, img] of spots) {
      const ops = placeMountainOps(d, x, y, 1, 1, img);
      seedOps.push(...ops);
      d = applyOps(d, ops);
    }
    const seeded = applyEditsToBytes(r0, seedOps);
    const { doc, raw } = parseScenarioRaw(seeded);
    const mnts = doc.objects.filter((o) => o.type === "mountains");
    expect(mnts.length).toBeGreaterThanOrEqual(3);
    const target = mnts[mnts.length - 2]!; // one entry follows it -> renumbers
    const tx = target.pos.x, ty = target.pos.y;

    const ops = deleteMountainOps(doc, target.id);
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    expect(re.objects.filter((o) => o.type === "mountains").length).toBe(mnts.length - 1);
    // the target's footprint reverted to the bare mountain-terrain value (5)
    expect(re.terrain.cells[ty * re.size + tx]!.value).toBe(5);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(validateMap(re).ok).toBe(true);
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

  it("placing a location appends a MidLocation block (CP1251 name) and round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const before = doc.objects.filter((o) => o.type === "location").length;
    const ops = placeLocationOps(doc, 33, 34, 2, "Зона испытаний");
    const id = (ops[0] as Extract<EditOp, { kind: "addObject" }>).object.id;
    expect(id).toMatch(/LO[0-9a-f]{4}$/);
    const out = applyEditsToBytes(raw, ops);
    expect(out.length).toBeGreaterThan(bytes.length); // a block was appended
    const re = parseScenario(out);
    expect(re.objects.filter((o) => o.type === "location").length).toBe(before + 1);
    const reLoc = re.objects.find((o) => o.id === id) as {
      name: string; radius: number; pos: { x: number; y: number };
    };
    expect(reLoc).toBeTruthy();
    expect(reLoc.name).toBe("Зона испытаний"); // CP1251 survives the round-trip
    expect(reLoc.radius).toBe(2);
    expect(reLoc.pos).toEqual({ x: 33, y: 34 });
    expect(validateMap(re).ok).toBe(true);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("place THEN patch name/radius in one session folds into the appended block", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const place = placeLocationOps(doc, 41, 42, 0, "Старое имя");
    const id = (place[0] as Extract<EditOp, { kind: "addObject" }>).object.id;
    const ops: EditOp[] = [
      ...place,
      { kind: "patchObject", id, fields: { name: "Новое имя", radius: 1 } },
      { kind: "moveObject", id, x: 43, y: 44 },
    ];
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const reLoc = re.objects.find((o) => o.id === id) as {
      name: string; radius: number; pos: { x: number; y: number };
    };
    expect(reLoc).toBeTruthy();
    expect(reLoc.name).toBe("Новое имя");
    expect(reLoc.radius).toBe(1);
    expect(reLoc.pos).toEqual({ x: 43, y: 44 });
    expect(validateMap(re).ok).toBe(true);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });
});

describe("@d2/map-edit addObject writers (chest / village / stack) + MidgardPlan", () => {
  const addedId = (ops: EditOp[]): string =>
    (ops.find((o) => o.kind === "addObject") as Extract<EditOp, { kind: "addObject" }>).object.id;

  it("places a chest with 2 items: fresh MidBag + MidItem instances, plan +1, round-trips", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const ops = placeChestOps(doc, 18, 19, 2, ["G001IG0108", "G000IG0001"]);
    const id = addedId(ops);
    expect(id).toMatch(/BG[0-9a-f]{4}$/);
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const chest = re.objects.find((o) => o.id === id) as {
      items?: string[]; image?: number; pos: { x: number; y: number };
    };
    expect(chest).toBeTruthy();
    expect(chest.pos).toEqual({ x: 18, y: 19 });
    expect(chest.image).toBe(2);
    expect(chest.items).toEqual(["G001IG0108", "G000IG0001"]); // instances resolve to the templates
    expect(re.objects.length).toBe(doc.objects.length + 1); // MidItem instances aren't placed objects
    expect(validateMap(re).ok).toBe(true);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    // plan: exactly ONE new entry, at the chest's cell
    expect(planCount(out)).toBe(planCount(bytes) + 1);
    expect(planCellsOf(out, id)).toEqual([{ x: 18, y: 19 }]);
  });

  it("SAME-SESSION item edit on an ADDED chest folds into the appended frame (no splice)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const place = placeChestOps(doc, 18, 19, 1, ["G001IG0108"]);
    const id = addedId(place);
    const ops: EditOp[] = [
      ...place,
      { kind: "patchObject", id, fields: { items: ["G000IG0001", "G001IG0108"] } },
    ];
    const out = applyEditsToBytes(raw, ops); // must NOT throw (no raw ranges for an added id)
    const re = parseScenario(out);
    expect((re.objects.find((o) => o.id === id) as { items?: string[] }).items).toEqual([
      "G000IG0001", "G001IG0108",
    ]);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("places a village 'Тестбург': CP1251 name, neutral owner, tier 1, plan +16 (4×4)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const ops = placeVillageOps(doc, 20, 30, "Тестбург");
    const id = addedId(ops);
    expect(id).toMatch(/FT[0-9a-f]{4}$/);
    // fresh id must not collide with ANY existing FT id (capitals share the prefix)
    expect(doc.objects.some((o) => o.id === id)).toBe(false);
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const v = re.objects.find((o) => o.id === id) as {
      name?: string; tier?: number; owner?: string; race?: number;
      garrison?: (unknown | null)[]; pos: { x: number; y: number };
    };
    expect(v).toBeTruthy();
    expect(v.name).toBe("Тестбург"); // CP1251 survives
    expect(v.tier).toBe(1);
    expect(v.owner).toBeUndefined(); // race-neutral
    expect(v.race).toBeUndefined();
    expect((v.garrison ?? []).filter(Boolean).length).toBe(0);
    expect(v.pos).toEqual({ x: 20, y: 30 });
    expect(validateMap(re).ok).toBe(true);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    // plan: the 4×4 fort footprint (16 entries) anchored at the village pos
    expect(planCount(out)).toBe(planCount(bytes) + 16);
    const cells = planCellsOf(out, id);
    expect(cells.length).toBe(16);
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        expect(cells).toContainEqual({ x: 20 + dx, y: 30 + dy });
      }
    }
  });

  it("SAME-SESSION garrison edit on an ADDED village folds into the appended frame", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const place = placeVillageOps(doc, 20, 30, "Гарнизонный");
    const id = addedId(place);
    const g = [null, null, null, { unit: "G000UU0001", level: 1, hp: 110 }, null, null];
    const ops: EditOp[] = [...place, { kind: "patchObject", id, fields: { garrison: g } }];
    const out = applyEditsToBytes(raw, ops); // must NOT throw (fort-slot splices need raw ranges)
    const re = parseScenario(out);
    const reV = re.objects.find((o) => o.id === id) as { garrison?: ({ unit: string } | null)[] };
    expect(reV.garrison?.[3]?.unit).toBe("G000UU0001");
    expect(reV.garrison?.filter(Boolean).length).toBe(1);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("places a REAL stack (leader + 1 unit): formation + LEADER_ID round-trip, plan +1", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    // a real Gunit id from an existing Riders stack's leader
    const src = doc.objects.find(
      (o) => o.type === "stack" && (o as { leaderCell?: number }).leaderCell !== undefined,
    ) as { leaderCell: number; garrison: ({ unit: string } | null)[] };
    expect(src).toBeTruthy();
    const leaderUnit = src.garrison[src.leaderCell]!.unit;
    const owner = doc.players[0]!.id;
    const units: ({ unit: string; level?: number; hp?: number } | null)[] =
      [{ unit: "G000UU0001", level: 1, hp: 110 }, null, { unit: leaderUnit, level: 3, hp: 50 }, null, null, null];
    const ops = placeStackOps(doc, 22, 23, { owner, units, leaderCell: 2 });
    const id = addedId(ops);
    expect(id).toMatch(/KC[0-9a-f]{4}$/);
    const out = applyEditsToBytes(raw, ops);
    const re = parseScenario(out);
    const st = re.objects.find((o) => o.id === id) as {
      owner?: string; leaderCell?: number; leaderImage?: string;
      garrison: ({ unit: string; level: number; hp: number } | null)[];
      pos: { x: number; y: number };
    };
    expect(st).toBeTruthy();
    expect(st.pos).toEqual({ x: 22, y: 23 });
    expect(st.owner).toBe(owner);
    // formation matches cell-for-cell (cell i = UNIT_[POS_i] decoding)
    expect(st.garrison[0]).toMatchObject({ unit: "G000UU0001", level: 1, hp: 110 });
    expect(st.garrison[2]).toMatchObject({ unit: leaderUnit, level: 3, hp: 50 });
    expect(st.garrison[1]).toBeNull();
    expect(st.leaderCell).toBe(2); // LEADER_ID resolved back to the leader's cell
    expect(st.leaderImage).toBe(leaderUnit);
    expect(re.objects.length).toBe(doc.objects.length + 1); // MidUnit instances aren't placed objects
    expect(validateMap(re).ok).toBe(true);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(planCount(out)).toBe(planCount(bytes) + 1);
    expect(planCellsOf(out, id)).toEqual([{ x: 22, y: 23 }]);
  });

  it("SAME-SESSION formation edit (the stack editor's op) on an ADDED stack folds in", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const src = doc.objects.find(
      (o) => o.type === "stack" && (o as { leaderCell?: number }).leaderCell !== undefined,
    ) as { leaderCell: number; garrison: ({ unit: string } | null)[] };
    const leaderUnit = src.garrison[src.leaderCell]!.unit;
    const place = placeStackOps(doc, 24, 25, {
      units: [{ unit: leaderUnit, level: 1, hp: 50 }, null, null, null, null, null],
      leaderCell: 0,
    });
    const id = addedId(place);
    // the stack editor emits patchObject {garrison, leaderCell, leaderImage}
    const g = [
      { unit: leaderUnit, level: 1, hp: 50 },
      { unit: "G000UU0001", level: 1, hp: 110 },
      null, null, null, null,
    ];
    const ops: EditOp[] = [
      ...place,
      { kind: "patchObject", id, fields: { garrison: g, leaderCell: 0, leaderImage: leaderUnit } },
    ];
    const out = applyEditsToBytes(raw, ops); // must NOT throw
    const re = parseScenario(out);
    const st = re.objects.find((o) => o.id === id) as {
      leaderCell?: number; garrison: ({ unit: string } | null)[];
    };
    expect(st.garrison[1]?.unit).toBe("G000UU0001");
    expect(st.leaderCell).toBe(0);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("plan entries for landmark (1×1) and location (anchor only) placements", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const lm = doc.objects.find((o) => o.type === "landmark" && o.baseType)!;
    const ops: EditOp[] = [
      ...placeLandmarkOps(doc, 31, 32, lm.baseType!),
      ...placeLocationOps(doc, 35, 36, 2, "Зона плана"),
    ];
    const ids = ops
      .filter((o): o is Extract<EditOp, { kind: "addObject" }> => o.kind === "addObject")
      .map((o) => o.object.id);
    const out = applyEditsToBytes(raw, ops);
    expect(planCount(out)).toBe(planCount(bytes) + 2);
    expect(planCellsOf(out, ids[0]!)).toEqual([{ x: 31, y: 32 }]);
    // a location gets EXACTLY ONE entry (anchor cell), radius-independent — as in Riders
    expect(planCellsOf(out, ids[1]!)).toEqual([{ x: 35, y: 36 }]);
    const res = roundTripSemantic(doc, out, ops);
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it("mountains get NO plan entries (byte-verified: none in Riders)", () => {
    const { doc, raw } = parseScenarioRaw(bytes);
    const ops = placeMountainOps(doc, 40, 40, 2, 2, 5);
    const out = applyEditsToBytes(raw, ops);
    expect(planCount(out)).toBe(planCount(bytes));
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
