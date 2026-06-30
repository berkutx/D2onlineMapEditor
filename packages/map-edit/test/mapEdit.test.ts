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
  applyEditsToBytes,
  roundTripSemantic,
  roadBrush,
  roadTypeFromMask,
  eraseBrush,
  selectRoadSegment,
  eraseRoadCells,
  placeMountainOps,
  placeLandmarkOps,
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
