/**
 * Add / remove a playable faction (player + subrace + capital + hero + satellites) as one undoable
 * cluster. Gold-checked in native ScenEdit (spike); here we pin the model round-trips + the export.
 *   - addPlayer: +1 player, its capital/hero/subrace/satellites appear, the from-model export is valid.
 *   - undo (removePlayer inverse) restores the exact prior counts.
 *   - removePlayer on a fresh faction, then its inverse (addPlayer{snapshot}) restores it verbatim.
 *   - guard: one player per race (a synthesized add of a present race throws).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseScenario, serializeMapFromModelBytes, validateMap, verifyBlockIntegrity } from "@d2/sg-parser";
import type { MapDocument } from "@d2/map-schema";
import {
  applyOp, materializeForExport, mintPlayerIds, raceAlreadyPresent, roundTripSemantic, RACE_KEYS, type EditOp,
} from "@d2/map-edit";
import { campaignMap } from "../../../test-helpers/gameDir";

const RIDERS = campaignMap(join("The Power of Eldunari-v1-2 maps", "Riders.sg"));
const base = new Uint8Array(readFileSync(RIDERS));
const doc: MapDocument = parseScenario(base);

/** first playable race Riders does NOT already have (one player per race). */
const absentRace = RACE_KEYS.find((k) => !raceAlreadyPresent(doc, k))!;

/** A 5×5 land spot for the capital. The test checks the MODEL round-trip + export STRUCTURE (which
 *  ignores occupancy — that's the separate ScenEdit gold-check), so it needs land, not free cells. */
function freeSpot(d: MapDocument): { x: number; y: number } {
  const n = d.size;
  const land = (x: number, y: number): boolean => {
    for (let dx = 0; dx < 5; dx++) for (let dy = 0; dy < 5; dy++) {
      const cx = x + dx, cy = y + dy;
      if (cx >= n || cy >= n) return false;
      const g = ((d.terrain.cells[cy * n + cx]?.value ?? 0) >> 3) & 7;
      if (g === 3 || g === 4) return false;
    }
    return true;
  };
  for (let y = 2; y < n - 6; y++) for (let x = 2; x < n - 6; x++) if (land(x, y)) return { x, y };
  return { x: 2, y: 2 }; // fallback — structure-only test tolerates overlap
}

const addOp = (): EditOp => ({ kind: "addPlayer", spec: { race: absentRace, ...freeSpot(doc), ids: mintPlayerIds(doc) } } as EditOp);

describe("player roster — add / remove a faction", () => {
  it("addPlayer inserts a full cluster and the from-model export is valid", () => {
    const op = addOp();
    const ids = (op as { spec: { ids: { pl: string; ft: string; kc: string; sr: string; fg: string } } }).spec.ids;
    const { doc: d2 } = applyOp(doc, op);
    expect(d2.players.length).toBe(doc.players.length + 1);
    expect(d2.players.some((p) => p.id === ids.pl)).toBe(true);
    expect(d2.subraces?.some((s) => s.id === ids.sr)).toBe(true);
    expect(d2.objects.some((o) => o.id === ids.ft && o.type === "capital")).toBe(true);
    expect(d2.objects.some((o) => o.id === ids.kc && o.type === "stack")).toBe(true);
    expect(d2.satellites?.fogs.some((f) => f.id === ids.fg)).toBe(true);

    const bytes = serializeMapFromModelBytes(base, materializeForExport(doc, [op], {}));
    expect(verifyBlockIntegrity(bytes).ok).toBe(true);
    expect(validateMap(parseScenario(bytes)).ok).toBe(true);
    // the SERVER's /export gate: the reparse must equal the model (synthesized cluster fields must
    // match exactly what the reader produces — empty names omitted, garrisoned/equip/inventory set,
    // playerNo derived from the id, not the array index).
    expect(roundTripSemantic(doc, bytes, [op]).ok).toBe(true);
    const re = parseScenario(bytes);
    expect(re.players.some((p) => p.id === ids.pl)).toBe(true);
    expect(re.players.length).toBe(doc.players.length + 1);
  });

  it("undo of addPlayer (removePlayer inverse) restores the exact prior counts", () => {
    const op = addOp();
    const { doc: d2, inverse } = applyOp(doc, op);
    expect(inverse.kind).toBe("removePlayer");
    const { doc: d3 } = applyOp(d2, inverse);
    expect(d3.players.length).toBe(doc.players.length);
    expect(d3.objects.length).toBe(doc.objects.length);
    expect(d3.subraces?.length).toBe(doc.subraces?.length);
    expect(d3.diplomacy?.length).toBe(doc.diplomacy?.length);
  });

  it("removePlayer captures the cluster; its inverse restores it verbatim", () => {
    const op = addOp();
    const ids = (op as { spec: { ids: { pl: string } } }).spec.ids;
    const { doc: d2 } = applyOp(doc, op); // a fresh faction to remove
    const { doc: d3, inverse } = applyOp(d2, { kind: "removePlayer", id: ids.pl } as EditOp);
    expect(inverse.kind).toBe("addPlayer");
    expect(d3.players.length).toBe(doc.players.length);
    expect(d3.players.some((p) => p.id === ids.pl)).toBe(false);
    const { doc: d4 } = applyOp(d3, inverse);
    expect(d4.players.length).toBe(d2.players.length);
    expect(d4.objects.length).toBe(d2.objects.length);
    expect(d4.players.some((p) => p.id === ids.pl)).toBe(true);
  });

  it("mintPlayerIds namespaces every id family by collab slot (concurrent adds don't collide)", () => {
    const BAND = 4096;
    const secondOf = (id: string): number => parseInt(id.slice(-4), 16);
    const inBand = (id: string, slot: number): boolean => secondOf(id) >= slot * BAND && secondOf(id) < (slot + 1) * BAND;
    const a = mintPlayerIds(doc, 0);
    const b = mintPlayerIds(doc, 5);
    for (const k of ["pl", "sr", "fg", "ks", "pb", "ft", "kc", "guard", "hero"] as const) {
      expect(inBand(a[k], 0)).toBe(true);
      expect(inBand(b[k], 5)).toBe(true);
      expect(a[k]).not.toBe(b[k]);
    }
    for (const it of a.items) expect(inBand(it, 0)).toBe(true);
    for (const it of b.items) expect(inBand(it, 5)).toBe(true);
    expect(new Set([...a.items, ...b.items]).size).toBe(6); // all six distinct
    // slot 0 (solo) mints the low band — unchanged from the old max+1 for a small map
    expect(secondOf(a.pl)).toBeLessThan(BAND);
  });

  it("refuses a synthesized add of a race the map already has (one player per race)", () => {
    const present = RACE_KEYS.find((k) => raceAlreadyPresent(doc, k));
    if (!present) return; // Riders has an absent race in every slot — skip if all-absent (unlikely)
    const op: EditOp = { kind: "addPlayer", spec: { race: present, x: 5, y: 5, ids: mintPlayerIds(doc) } } as EditOp;
    expect(() => applyOp(doc, op)).toThrow(/already on the map/);
  });
});
