/**
 * FULL model-rebuild export — the genuine "no patch, no fallback" path:
 *   bytes = serializeMapFromModelBytes(originalBytes, materializeForExport(doc, ops))
 * The whole `.sg` is re-serialised from the MODEL (applyEditsToBytes is gone from the export path;
 * it survives here only as the PARITY ORACLE). Two guarantees:
 *   - UNEDITED: byte-identical to the original (the from-model container reproduces it exactly).
 *   - EDITED: VALID + SEMANTICALLY EQUAL to the gold-checked patch (applyEditsToBytes, task #122) —
 *     instance ids differ (each side mints independently), so we compare content, not bytes.
 * The road-draw and talisman cases are the ones the earlier model-derived approach got wrong; they
 * are pinned here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseScenario, parseScenarioRaw, serializeMapFromModelBytes,
  validateMap, verifyBlockIntegrity, parsePlanEntries,
} from "@d2/sg-parser";
import type { MapDocument, StackTemplate } from "@d2/map-schema";
import { MapEvent } from "@d2/map-schema";
import {
  materializeForExport, applyEditsToBytes, occupancyErrors, planCoverageErrors,
  placeChestOps, placeVillageOps, placeLocationOps, type EditOp,
} from "@d2/map-edit";
import { campaignMap } from "../../../test-helpers/gameDir";

const RIDERS = campaignMap(join("The Power of Eldunari-v1-2 maps", "Riders.sg"));
const REPO = join(__dirname, "..", "..", "..");
const base = new Uint8Array(readFileSync(RIDERS));
const doc: MapDocument = parseScenario(base);

const itemCat = JSON.parse(readFileSync(join(REPO, "public/assets/itemCatalog.json"), "utf8")) as { id: string; catKey?: string }[];
const talismanTemplates = new Set(itemCat.filter((i) => i.catKey === "L_TALISMAN").map((i) => i.id));
const talismanId = [...talismanTemplates][0]!;
const opts = { talismanTemplates };

const fromModel = (ops: readonly EditOp[]): Uint8Array =>
  serializeMapFromModelBytes(base, materializeForExport(doc, ops, opts));

// content signatures (instance-id independent): objects, plan-occupancy KINDS, roads, charge count.
const kindOf = (el: string): string => el.replace(/[0-9a-fA-F]{4}$/, "").replace(/^S\d+/, "");
const objSig = (d: MapDocument): string => d.objects.map((o) => {
  const items = o.type === "treasure" || o.type === "village" || o.type === "capital" ? (o.items ?? []) : [];
  const inv = o.type === "stack" ? (o.inventory ?? []) : [];
  const garr = ("garrison" in o ? o.garrison ?? [] : []).filter(Boolean).map((m) => m!.unit);
  return `${o.id}:${o.type}:${o.pos.x},${o.pos.y}:[${items}]:[${inv}]:{${garr}}`;
}).sort().join("\n");
const planSig = (d: MapDocument): string =>
  (d.plan?.entries ?? []).map((e) => `${e.x},${e.y},${kindOf(e.element)}`).sort().join("|");
const roadSig = (d: MapDocument): string =>
  (d.roads ?? []).map((r) => `${r.x},${r.y}:${r.index}:${r.variant}`).sort().join("|");
const chargeCount = (d: MapDocument): number =>
  (d.satellites?.talismanCharges ?? []).reduce((n, tc) => n + tc.entries.length, 0);

/** Every validity metric of a produced .sg (structural + placement). */
function validity(bytes: Uint8Array): { vm: boolean; vbi: boolean; occ: number; plan: number } {
  const built = parseScenario(bytes);
  return {
    vm: validateMap(built).ok,
    vbi: verifyBlockIntegrity(bytes).ok,
    occ: occupancyErrors(built, {}).length,
    plan: planCoverageErrors(built, parsePlanEntries(bytes), {}).length,
  };
}

/**
 * from-model export ≡ the gold-checked patch, SEMANTICALLY. Instance ids differ (each side mints
 * independently), so we compare content + every validity metric — which must be EQUAL to patch's
 * (placement-dependent occupancy is identical on both sides, so this measures from-model fidelity,
 * not the test's choice of cell). `expectClean` additionally requires structural validity.
 */
function expectEquivalentToPatch(ops: EditOp[], expectClean = true): void {
  const fm = fromModel(ops);
  const patch = applyEditsToBytes(parseScenarioRaw(base).raw, ops, opts);
  const dfm = parseScenario(fm), dp = parseScenario(patch);
  expect(objSig(dfm), "objects").toBe(objSig(dp));
  expect(planSig(dfm), "plan occupancy").toBe(planSig(dp));
  expect(roadSig(dfm), "roads").toBe(roadSig(dp));
  expect(chargeCount(dfm), "talisman charges").toBe(chargeCount(dp));
  expect(validity(fm), "validity ≡ patch").toEqual(validity(patch));
  if (expectClean) {
    const v = validity(fm);
    expect(v.vm && v.vbi, "structurally valid").toBe(true);
  }
}

/** A non-water land cell with no road overlay — for the road-draw case. */
function roadFreeLandCell(): { x: number; y: number; value: number } {
  const n = doc.size;
  for (let y = 5; y < n - 5; y++) for (let x = 5; x < n - 5; x++) {
    const c = doc.terrain.cells[y * n + x]!;
    if (c.ground !== 3 && c.roadType < 0) return { x, y, value: c.value };
  }
  throw new Error("no road-free land cell");
}

describe("full model-rebuild export", () => {
  it("UNEDITED → byte-identical to the original (from-model container reproduces it)", () => {
    const out = fromModel([]);
    expect(out.length).toBe(base.length);
    expect(Buffer.from(out).equals(Buffer.from(base))).toBe(true);
  });

  it("place chest with items ≡ patch", () => expectEquivalentToPatch(placeChestOps(doc, 46, 46, 0, ["G000IG0001", "G000IG0002"])));
  it("place location ≡ patch", () => expectEquivalentToPatch(placeLocationOps(doc, 41, 41, 1, "Зона")));

  // regression pins for the review's CONFIRMED bugs — now content-equal to patch:
  it("DRAW A NEW ROAD → MidRoad + RA plan entry present (≡ patch)", () => {
    const c = roadFreeLandCell();
    expectEquivalentToPatch([{ kind: "setCell", x: c.x, y: c.y, value: c.value, roadType: 0, roadVar: 0 }]);
  });
  it("chest with a TALISMAN → MidTalismanCharges row present (≡ patch)", () => {
    expect(talismanId).toBeTruthy();
    expectEquivalentToPatch(placeChestOps(doc, 48, 48, 0, [talismanId]));
  });

  it("place village (4×4 footprint plan entries) ≡ patch", () => {
    // occupancy on dense Riders is placement-dependent and identical to patch; expectEquivalentToPatch
    // compares the metric to patch's, so we only need the 16 plan entries + block to match.
    expectEquivalentToPatch(placeVillageOps(doc, 44, 44, "Град"), /*expectClean*/ false);
  });

  // ---- adversarial-review regression pins ----

  it("delete-then-re-add a landmark (collab undo) keeps its plan footprint — NOT purged", () => {
    // journal = [delete(id), add({...same,id})]; foldOps keeps both. The survivor must retain its
    // ORIGINAL MidgardPlan entries (a landmark with no footprint fails planCoverageErrors → 422).
    const lm = doc.objects.find((o) => o.type === "landmark")!;
    const out = fromModel([{ kind: "deleteObject", id: lm.id }, { kind: "addObject", object: lm }]);
    const built = parseScenario(out);
    expect(built.objects.some((o) => o.id === lm.id), "landmark survives").toBe(true);
    expect(planCoverageErrors(built, parsePlanEntries(out), {}).length, "footprint intact").toBe(0);
    expect(verifyBlockIntegrity(out).ok).toBe(true);
  });

  it("deleting a Capital is REFUSED (throws → 422, race integrity)", () => {
    const cap = doc.objects.find((o) => o.type === "capital");
    expect(cap, "Riders has a capital").toBeTruthy();
    expect(() => fromModel([{ kind: "deleteObject", id: cap!.id }])).toThrow(/Capital/);
  });

  it("talisman placed → the charge row is present in the output (even with no base charges block)", () => {
    const baseCharges = (d: MapDocument): number => chargeCount(d);
    const before = baseCharges(parseScenario(fromModel([])));
    const out = fromModel(placeChestOps(doc, 49, 49, 0, [talismanId]));
    expect(chargeCount(parseScenario(out)), "one new charge row").toBe(before + 1);
  });
});

/**
 * Popup SOUND/MUSIC extension strip (the prod crash: a name like "AbeyRw1.mp3" makes the game
 * look up a non-existent file and NULL-crash on playback). The user's report was identity✓ /
 * semantic✗: the value must be canonicalized IDENTICALLY on both sides — the model
 * (MapEvent.parse in applyOps) and the byte writer (applyBytes stores op.event RAW). Riders'
 * event S143EV0115 carries a real popup sound "cfw_l2"; we re-attach an extension and expect it
 * gone everywhere. `.MP3` (upper-case) also proves the strip is case-insensitive while the
 * NAME's case is preserved.
 */
const AUDIO_EV = "S143EV0115";
function popupAudio(d: MapDocument, evId: string): { sound: string; music: string } {
  const ev = (d.events ?? []).find((e) => e.id === evId)!;
  const pop = ev.effects.find((e) => e.kind === "popup") as { sound?: string; music?: string };
  return { sound: pop.sound ?? "", music: pop.music ?? "" };
}
/** Clone the event with an extension-bearing sound/music — a RAW op.event (NOT MapEvent.parse'd),
 *  matching what the editor emits and what applyBytes serialises verbatim. */
function eventWithExtAudio(): MapEvent {
  const src = (doc.events ?? []).find((e) => e.id === AUDIO_EV)!;
  const ev = structuredClone(src) as MapEvent & { effects: { kind: string; sound?: string; music?: string }[] };
  const pop = ev.effects.find((e) => e.kind === "popup")!;
  pop.sound = "cfw_l2.MP3";
  pop.music = "trevoga.wav";
  return ev as MapEvent;
}

describe("popup SOUND/MUSIC extension is stripped (prod crash-name fix)", () => {
  it("MapEvent.parse canonicalizes the live-doc value (bare name, case preserved)", () => {
    const ev = MapEvent.parse(eventWithExtAudio());
    const pop = ev.effects.find((e) => e.kind === "popup") as { sound: string; music: string };
    expect(pop.sound).toBe("cfw_l2");
    expect(pop.music).toBe("trevoga");
  });

  it("full model-rebuild writes the bare name (schema transform + writer)", () => {
    const out = fromModel([{ kind: "upsertEvent", event: eventWithExtAudio() }]);
    expect(popupAudio(parseScenario(out), AUDIO_EV)).toEqual({ sound: "cfw_l2", music: "trevoga" });
    expect(verifyBlockIntegrity(out).ok).toBe(true);
  });

  it("byte-patch export strips it too, though op.event bypasses MapEvent.parse (applyBytes → writer)", () => {
    const raw = parseScenarioRaw(base).raw;
    const patch = applyEditsToBytes(raw, [{ kind: "upsertEvent", event: eventWithExtAudio() }], opts);
    expect(popupAudio(parseScenario(patch), AUDIO_EV)).toEqual({ sound: "cfw_l2", music: "trevoga" });
    expect(verifyBlockIntegrity(patch).ok).toBe(true);
  });

  it("both export paths AGREE (the identity✓/semantic✗ mismatch is gone)", () => {
    const op: EditOp = { kind: "upsertEvent", event: eventWithExtAudio() };
    const fm = popupAudio(parseScenario(fromModel([op])), AUDIO_EV);
    const patch = popupAudio(parseScenario(applyEditsToBytes(parseScenarioRaw(base).raw, [op], opts)), AUDIO_EV);
    expect(fm).toEqual(patch);
  });

  it("a pristine bare sound is untouched by the round-trip (no-op → byte-exact safe)", () => {
    // S143EV0115.sound is already "cfw_l2" on disk; UNEDITED rebuild must reproduce it verbatim.
    expect(popupAudio(doc, AUDIO_EV).sound).toBe("cfw_l2");
    expect(popupAudio(parseScenario(fromModel([])), AUDIO_EV).sound).toBe("cfw_l2");
  });
});

/**
 * Template BIG (2-cell) unit: an edit must NOT split it into two units. On disk a big unit is
 * ONE slot referenced by both cells of its formation column (POS_i==POS_j); before the fix any
 * edit dropped that layout and re-packed one-slot-per-cell → split, and the semantic gate was
 * BLIND (it strips slots/slotOfCell and compares the [U,U] cell view, identical either way).
 * The reader now flags both cells `big` from the POS structure, the shared packTemplateSlots
 * re-pack keeps it one slot, and `big` in the cell view makes a split visible to the gate.
 */
function bigUnitTemplate(): StackTemplate {
  const t = (doc.templates ?? []).find((x) => {
    const pos = x.slotOfCell ?? []; const seen = new Set<number>();
    for (const s of pos) { if (s >= 0) { if (seen.has(s)) return true; seen.add(s); } }
    return false;
  });
  if (!t) throw new Error("no big-unit template in Riders");
  return t;
}
/** The two cells that share a slot in the on-disk POS (the big unit's column pair). */
function bigPair(t: StackTemplate): [number, number] {
  const pos = t.slotOfCell ?? [];
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) if (pos[i]! >= 0 && pos[i] === pos[j]) return [i, j];
  throw new Error("no shared-slot pair");
}
const tmplOf = (bytes: Uint8Array, id: string): StackTemplate =>
  parseScenario(bytes).templates!.find((t) => t.id === id)!;
const filledSlots = (t: StackTemplate): number => (t.slots ?? []).filter(Boolean).length;

describe("template big-unit is not split by an edit", () => {
  it("editing a big-unit template keeps ONE slot (POS_i==POS_j) on BOTH export paths", () => {
    const t = bigUnitTemplate();
    const [a, b] = bigPair(t);
    // reader flagged both cells of the big pair (the model self-describes the 2-cell unit)
    expect(t.units[a]?.big && t.units[b]?.big, "reader marks both cells big").toBe(true);
    const op: EditOp = { kind: "upsertTemplate", template: { ...structuredClone(t), name: `${t.name} EDIT` } };
    const paths: [string, Uint8Array][] = [
      ["model-rebuild", fromModel([op])],
      ["byte-patch", applyEditsToBytes(parseScenarioRaw(base).raw, [op], opts)],
    ];
    for (const [label, bytes] of paths) {
      const rt = tmplOf(bytes, t.id);
      expect(rt.slotOfCell![a], `${label}: POS_${a} === POS_${b}`).toBe(rt.slotOfCell![b]);
      expect(rt.slotOfCell![a], `${label}: real slot`).toBeGreaterThanOrEqual(0);
      expect(rt.units![a]?.big && rt.units![b]?.big, `${label}: big flag survives`).toBe(true);
      expect(filledSlots(rt), `${label}: no extra slot`).toBe(filledSlots(t));
    }
  });

  it("both export paths AGREE on the edited big-unit template (semantic parity)", () => {
    const t = bigUnitTemplate();
    const op: EditOp = { kind: "upsertTemplate", template: { ...structuredClone(t), name: `${t.name} X` } };
    const fm = tmplOf(fromModel([op]), t.id);
    const patch = tmplOf(applyEditsToBytes(parseScenarioRaw(base).raw, [op], opts), t.id);
    expect(fm.units, "units cell view").toEqual(patch.units);
    expect(fm.slotOfCell, "POS layout").toEqual(patch.slotOfCell);
  });

  it("two IDENTICAL small units in a column stay TWO slots (no false merge)", () => {
    const t = bigUnitTemplate();
    const small = "G000UU0001";
    const edited: StackTemplate = {
      ...structuredClone(t), name: "two small", leader: "", modifiers: [],
      units: [{ unit: small, level: 1 }, { unit: small, level: 1 }, null, null, null, null],
    };
    const rt = tmplOf(fromModel([{ kind: "upsertTemplate", template: edited }]), t.id);
    expect(rt.slotOfCell![0], "distinct slots").not.toBe(rt.slotOfCell![1]);
    expect(filledSlots(rt), "two slots").toBe(2);
    expect(rt.units![0]?.big, "not flagged big").toBeFalsy();
  });

  it("an UNEDITED big-unit template rebuilds byte-identically (no-op)", () => {
    const t = bigUnitTemplate();
    const out = fromModel([]);
    const rt = tmplOf(out, t.id);
    expect(rt.slotOfCell).toEqual(t.slotOfCell); // verbatim slots path, POS unchanged
  });
});

/**
 * GARRISON big-unit must NOT split when the garrison is edited. A big garrison unit is TWO cell
 * objects sharing ONE `key` (POS_i==POS_j). Adding a unit to an empty cell makes a keyless member
 * → garrisonNeedsMint → mintGarrison re-mints the WHOLE garrison; the old object-identity dedup
 * never matched the two distinct cell literals, splitting the big unit into two 1-cell MidUnits
 * (the gate is blind — it strips key/slot). Now deduped by the shared key string.
 */
type GU = { unit: string; level: number; hp: number; key?: string; slot?: number } | null;
function garrisonBigUnit(): { id: string; a: number; b: number; empty: number } {
  for (const o of doc.objects) {
    const g = (o as { garrison?: GU[] }).garrison;
    if (!Array.isArray(g)) continue;
    const byKey = new Map<string, number[]>();
    g.forEach((m, i) => { if (m?.key) { const arr = byKey.get(m.key) ?? []; arr.push(i); byKey.set(m.key, arr); } });
    for (const [, cells] of byKey) {
      if (cells.length === 2) {
        const empty = g.findIndex((m, i) => !m && !cells.includes(i));
        if (empty >= 0) return { id: o.id, a: cells[0]!, b: cells[1]!, empty };
      }
    }
  }
  throw new Error("no garrison big-unit with an empty cell in Riders");
}

describe("garrison big-unit is not split by an edit", () => {
  it("adding a unit to an edited garrison keeps the big unit ONE MidUnit (shared key)", () => {
    const { id, a, b, empty } = garrisonBigUnit();
    const src = doc.objects.find((o) => o.id === id)!;
    const g = ((src as { garrison: GU[] }).garrison).map((m) => (m ? { ...m } : null));
    // sanity: the two cells share a key on disk (the big unit)
    expect(g[a]!.key).toBe(g[b]!.key);
    g[empty] = { unit: "G000UU0001", level: 1, hp: 10 }; // keyless → forces a whole-garrison re-mint
    const out = fromModel([{ kind: "patchObject", id, fields: { garrison: g } }]);
    const built = parseScenario(out);
    const bg = (built.objects.find((o) => o.id === id) as { garrison: GU[] }).garrison;
    expect(bg[a]?.key, "big unit cell a keyed").toBeTruthy();
    expect(bg[a]?.key, "both cells share ONE minted key (not split)").toBe(bg[b]?.key);
    expect(bg[empty]?.key, "added unit is a DISTINCT unit").not.toBe(bg[a]?.key);
    expect(verifyBlockIntegrity(out).ok, "structurally valid").toBe(true);
  });
});
