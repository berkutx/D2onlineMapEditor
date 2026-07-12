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
import type { MapDocument } from "@d2/map-schema";
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
