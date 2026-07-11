/**
 * Model-rebuild export ≡ patch export, BYTE-FOR-BYTE. The export path re-serialises every CONTENT
 * block PAYLOAD from the live model (rebuildBytes over applyOps with EXPORT_REBUILD_TYPES) instead
 * of splicing the original bytes (patch); the SERIALIZATION-DERIVED blocks (MidgardPlan / MidRoad /
 * MidTalismanCharges) are excluded from the rebuild set and kept verbatim from the byte-writer
 * skeleton. This test proves the two produce IDENTICAL bytes across every edit kind — so the
 * model-rebuild output inherits the patch path's ScenEdit gold-check (task #122): it is the same
 * bytes. A divergence here = a content block the model can't reproduce, which must be fixed.
 *
 * The road-draw, chest-with-items and talisman cases are the ones an earlier (buggy) model-derived
 * plan/roads/charges approach got WRONG (dropped RA plan entry / talisman charge row) — they are
 * pinned here so the exclude-from-rebuild fix can't regress.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseScenario, parseScenarioRaw, rebuildBytes, EXPORT_REBUILD_TYPES } from "@d2/sg-parser";
import type { MapDocument } from "@d2/map-schema";
import {
  applyOps, foldOps, applyEditsToBytes,
  placeChestOps, placeVillageOps, placeMountainOps, placeLandmarkOps, placeLocationOps,
  type EditOp,
} from "@d2/map-edit";
import { campaignMap } from "../../../test-helpers/gameDir";

const RIDERS = campaignMap(join("The Power of Eldunari-v1-2 maps", "Riders.sg"));
const REPO = join(__dirname, "..", "..", "..");
const base = new Uint8Array(readFileSync(RIDERS));
const doc: MapDocument = parseScenario(base);
const { raw } = parseScenarioRaw(base);

// a talisman GItem template id + the talisman set (so the byte writer mints a MidTalismanCharges row)
const itemCat = JSON.parse(readFileSync(join(REPO, "public/assets/itemCatalog.json"), "utf8")) as { id: string; catKey?: string }[];
const talismanTemplates = new Set(itemCat.filter((i) => i.catKey === "L_TALISMAN").map((i) => i.id));
const talismanId = [...talismanTemplates][0];

/** Bytes the DEFAULT export ships: patch skeleton + re-serialise CONTENT payloads from the model. */
function rebuildExport(ops: readonly EditOp[], opts: { talismanTemplates?: ReadonlySet<string> } = {}): Uint8Array {
  const skeleton = applyEditsToBytes(raw, ops, opts);
  return rebuildBytes(skeleton, applyOps(doc, ops), EXPORT_REBUILD_TYPES);
}

function expectIdentical(ops0: EditOp[], opts: { talismanTemplates?: ReadonlySet<string> } = {}): void {
  const ops = foldOps(ops0);
  const patch = applyEditsToBytes(raw, ops, opts);
  const rebuilt = rebuildExport(ops, opts);
  expect(rebuilt.length).toBe(patch.length);
  expect(Buffer.from(rebuilt).equals(Buffer.from(patch))).toBe(true);
}

/** A non-water land cell that currently has NO road overlay — for the road-draw case. */
function roadFreeLandCell(): { x: number; y: number; value: number } {
  const n = doc.size;
  for (let y = 5; y < n - 5; y++) for (let x = 5; x < n - 5; x++) {
    const c = doc.terrain.cells[y * n + x]!;
    if (c.ground !== 3 && c.roadType < 0) return { x, y, value: c.value };
  }
  throw new Error("no road-free land cell");
}

describe("model-rebuild export ≡ patch (byte-identical)", () => {
  it("no-op edit → identical to the original bytes", () => {
    expectIdentical([]);
    expect(Buffer.from(rebuildExport([])).equals(Buffer.from(base))).toBe(true);
  });
  it("setCell (terrain)", () => expectIdentical([{ kind: "setCell", x: 10, y: 10, value: 5 }]));
  it("patchObject (rename a location)", () => {
    const loc = doc.objects.find((o) => o.type === "location")!;
    expectIdentical([{ kind: "patchObject", id: loc.id, fields: { name: "Ново" } }]);
  });
  it("place landmark (plan footprint)", () => expectIdentical(placeLandmarkOps(doc, 40, 40, "G000MG0001")));
  it("place location", () => expectIdentical(placeLocationOps(doc, 41, 41, 1, "Зона")));
  it("place mountains (2×2)", () => expectIdentical(placeMountainOps(doc, 42, 42, 2, 2, 0, 0)));
  it("place village (4×4 plan footprint)", () => expectIdentical(placeVillageOps(doc, 44, 44, "Град")));
  it("place chest with items (instance fallback)", () =>
    expectIdentical(placeChestOps(doc, 46, 46, 0, ["G000IG0001", "G000IG0002"])));

  // regression pins for the review's CONFIRMED bugs:
  it("DRAW A NEW ROAD → its MidRoad + RA plan entry survive (not dropped)", () => {
    const c = roadFreeLandCell();
    expectIdentical([{ kind: "setCell", x: c.x, y: c.y, value: c.value, roadType: 0, roadVar: 0 }]);
  });
  it("place chest with a TALISMAN item → MidTalismanCharges row survives", () => {
    expect(talismanId).toBeTruthy();
    expectIdentical(placeChestOps(doc, 48, 48, 0, [talismanId!]), { talismanTemplates });
  });
});
