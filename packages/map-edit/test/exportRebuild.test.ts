/**
 * Model-rebuild export ≡ patch export, BYTE-FOR-BYTE. The export path re-serialises every block
 * PAYLOAD from the live model (rebuildBytes over applyOps + completeExportModel) instead of
 * splicing the original bytes (patch). This test proves the two produce IDENTICAL bytes across
 * every edit kind — which means the model-rebuild output inherits the patch path's ScenEdit
 * gold-check (task #122): it is the exact same bytes. A divergence here = the model can't
 * faithfully reproduce some block, which must be fixed (or fall back) before it ships.
 *
 * Content blocks (terrain/roads/objects/plan/footprints) are genuinely model-serialised;
 * instance-bearing blocks (chest items / garrisons) fall back to the skeleton block (instance
 * ids are minted by the serialiser, as in the reference) — either way, byte-identical to patch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseScenario, parseScenarioRaw, rebuildBytes } from "@d2/sg-parser";
import type { MapDocument } from "@d2/map-schema";
import {
  applyOps, foldOps, applyEditsToBytes, completeExportModel,
  placeChestOps, placeVillageOps, placeMountainOps, placeLandmarkOps, placeLocationOps,
  type EditOp,
} from "@d2/map-edit";
import { campaignMap } from "../../../test-helpers/gameDir";

const RIDERS = campaignMap(join("The Power of Eldunari-v1-2 maps", "Riders.sg"));
const base = new Uint8Array(readFileSync(RIDERS));
const doc: MapDocument = parseScenario(base);
const { raw } = parseScenarioRaw(base);

/** Bytes the DEFAULT export ships: re-serialise every payload from the completed live model. */
function rebuildExport(ops: readonly EditOp[]): Uint8Array {
  const skeleton = applyEditsToBytes(raw, ops, {});
  return rebuildBytes(skeleton, completeExportModel(doc, applyOps(doc, ops)));
}

function expectIdentical(ops0: EditOp[]): void {
  const ops = foldOps(ops0);
  const patch = applyEditsToBytes(raw, ops, {});
  const rebuilt = rebuildExport(ops);
  expect(rebuilt.length).toBe(patch.length);
  expect(Buffer.from(rebuilt).equals(Buffer.from(patch))).toBe(true);
}

describe("model-rebuild export ≡ patch (byte-identical)", () => {
  it("no-op edit → identical to the original bytes", () => {
    expectIdentical([]);
    // and identical to the untouched base
    expect(Buffer.from(rebuildExport([])).equals(Buffer.from(base))).toBe(true);
  });
  it("setCell (terrain)", () => expectIdentical([{ kind: "setCell", x: 10, y: 10, value: 5 }]));
  it("patchObject (rename a location)", () => {
    const loc = doc.objects.find((o) => o.type === "location")!;
    expectIdentical([{ kind: "patchObject", id: loc.id, fields: { name: "Ново" } }]);
  });
  it("place landmark", () => expectIdentical(placeLandmarkOps(doc, 40, 40, "G000MG0001")));
  it("place location", () => expectIdentical(placeLocationOps(doc, 41, 41, 1, "Зона")));
  it("place mountains (2×2)", () => expectIdentical(placeMountainOps(doc, 42, 42, 2, 2, 0, 0)));
  it("place village", () => expectIdentical(placeVillageOps(doc, 44, 44, "Град")));
  it("place chest with items (instance fallback)", () =>
    expectIdentical(placeChestOps(doc, 46, 46, 0, ["G000IG0001", "G000IG0002"])));
});
