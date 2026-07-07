import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseScenario, parsePlanEntries } from "@d2/sg-parser";
import { planCoverageErrors } from "../src/mechanics.js";
import { campaignMap } from "../../../test-helpers/gameDir";

// Real decorCatalog resolver (same construction as the server's loadCatalogSets): id.toUpperCase → [cx,cy].
const CATALOG = fileURLToPath(new URL("../../../public/assets/decorCatalog.json", import.meta.url));
const sizes: Record<string, readonly [number, number]> = {};
{
  const cat = JSON.parse(readFileSync(CATALOG, "utf-8")) as unknown;
  const entries = Array.isArray(cat)
    ? (cat as { id: string; cx?: number; cy?: number }[])
    : Object.values(cat as Record<string, { id: string; cx?: number; cy?: number }>);
  for (const e of entries) sizes[String(e.id).toUpperCase()] = [e.cx ?? 1, e.cy ?? 1];
}
const landmarkSize = (b: string): readonly [number, number] | undefined => sizes[(b ?? "").toUpperCase()];

// CALIBRATION: a shipped map is game-valid (it loads+saves in the real editor), so its landmark
// footprints are fully+correctly registered in the MidgardPlan. planCoverageErrors mirrors the
// game's isValid, so it MUST be silent on shipped maps — any hit is a false positive (a resolver
// footprint bigger than what the game uses). Guards the gate from over-blocking real content.
const SHIPPED = [
  ["Riders", campaignMap(join("The Power of Eldunari-v1-2 maps", "Riders.sg"))],
  ["Dragon's teeth", campaignMap(join("The Power of Eldunari-v1-2 maps", "Dragon_s teeth.sg"))],
] as const;

describe("planCoverageErrors — calibration (silent on shipped maps)", () => {
  for (const [name, path] of SHIPPED) {
    it(`${name}: zero plan-footprint errors`, () => {
      const bytes = new Uint8Array(readFileSync(path));
      const doc = parseScenario(bytes);
      const errs = planCoverageErrors(doc, parsePlanEntries(bytes), { landmarkSize });
      expect(errs).toEqual([]);
    });
  }

  it("parsePlanEntries reads a real plan (Riders has entries)", () => {
    const bytes = new Uint8Array(readFileSync(SHIPPED[0][1]));
    const plan = parsePlanEntries(bytes);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0]).toHaveProperty("element");
  });
});
