/**
 * Game-MECHANICS validation (our addition on top of the reference validator — the
 * original MapConverter::validateMap checks only database references, never terrain):
 * solid objects standing on water, roads running under water, and OVERLAPPING object
 * footprints make the map wrong to PLAY even though every byte and reference is fine.
 * Generation and brushes guard against creating these; this check is the safety net that
 * catches them wherever they come from (old projects, inline LLM recipes, future tools).
 *
 * Deliberately WARNINGS, not errors: shipped maps must stay green — anything they
 * legitimately contain (boat stacks on water, coastal landmarks, mountains in water —
 * all verified present in campaign maps) is excluded from the checks. The overlap rule is
 * calibrated SILENT on Riders/Нежить/walltest (zero overlaps among occupied footprints).
 */
import type { MapDocument } from "@d2/map-schema";

/** Land-bound object types and their byte-verified footprints. CALIBRATED against all
 *  52 shipped campaign maps: only CITIES are never on water there. Everything visitable
 *  IS legally placed on water in shipped maps (561 underwater treasures, 38 sunken
 *  ruins, floating merchants/mage towers — reached by boat), stacks sail, landmarks do
 *  coastal decor, mountains are ScenEdit-legal on water — none of those may warn. */
const SOLID_FOOTPRINT: Record<string, [number, number]> = {
  village: [4, 4],
  fort: [4, 4],
  capital: [5, 5],
};

/** Footprints of objects that OCCUPY their cells in the placement plan (a unit cannot stand
 *  on them). Two occupied footprints may NOT overlap — the original editor forbids placing
 *  objects flush/overlapping ("только через щель"; walltest.sg has zero overlaps), and
 *  passability comes from plan occupancy, not terrain. Landmarks use their GLmark footprint
 *  (decorCatalog cx/cy) via the resolver; cities/ruins/sites are byte-verified fixed sizes.
 *  Excluded (non-blocking, may share cells): stacks (stand INSIDE cities), locations,
 *  mountains (terrain-37), chests, crystals. */
const OCCUPY_FIXED: Record<string, [number, number]> = {
  village: [4, 4],
  fort: [4, 4],
  capital: [5, 5],
  ruin: [3, 3],
  merchant: [3, 3],
  mage: [3, 3],
  trainer: [3, 3],
  mercenary: [3, 3],
};

const isWater = (v: number): boolean => ((v >> 3) & 7) === 3;

export interface MechanicsOptions {
  /** baseType (GLmark id) → its `[w, h]` GLmark footprint (decorCatalog cx/cy). Lets the
   *  overlap check know a landmark's true size; without it landmarks are treated as 1×1
   *  (so overlaps between big landmarks may be missed — the resolver is the accurate path). */
  landmarkSize?: (baseType: string) => readonly [number, number] | undefined;
}

/** Occupied-cell footprint of an object, or null if it does not block a cell. */
function occupyFootprint(
  o: MapDocument["objects"][number],
  opts: MechanicsOptions,
): readonly [number, number] | null {
  if (o.type === "landmark") return opts.landmarkSize?.(o.baseType ?? "") ?? [1, 1];
  return OCCUPY_FIXED[o.type] ?? null;
}

/** Mechanics WARNINGS for a document (empty = playable placement-wise). Soft rules: shipped
 *  maps legitimately carry them in edge cases, so they never block an export. */
export function validateMechanics(doc: MapDocument, _opts: MechanicsOptions = {}): string[] {
  const warnings: string[] = [];
  const n = doc.size;
  const cells = doc.terrain.cells;
  if (cells.length !== n * n) return warnings; // structurally broken — tier-3 reports it

  // 1) solid CITY on water
  for (const o of doc.objects) {
    const fp = SOLID_FOOTPRINT[o.type];
    if (!fp) continue;
    const wet: string[] = [];
    for (let dy = 0; dy < fp[1]; dy++)
      for (let dx = 0; dx < fp[0]; dx++) {
        const x = o.pos.x + dx;
        const y = o.pos.y + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        if (isWater(cells[y * n + x]!.value)) wet.push(`${x},${y}`);
      }
    if (wet.length > 0) {
      warnings.push(
        `mechanics: ${o.type} ${o.id} стоит на воде (${wet.length} кл., напр. ${wet[0]})`,
      );
    }
  }

  // 2) road under water
  for (const c of cells) {
    if (c.roadType !== -1 && isWater(c.value)) {
      warnings.push(`mechanics: дорога под водой в (${c.x},${c.y})`);
    }
  }

  return warnings;
}

/**
 * Occupancy ERRORS — two objects may NOT share a footprint cell. This is a HARD rule of the
 * game editor: you cannot place a building/decoration/mountain over another object (passability
 * is plan occupancy, so an overlap is an unplayable map, not a cosmetic issue). Verified ZERO
 * overlaps across 59 shipped campaign maps + the original's walltest, so an overlap only comes
 * from a placement/generation bug — hence errors (they block the export), not warnings.
 * One error per offending PAIR (a 4×4 over a 4×4 would otherwise spam 16 lines). Stacks stand
 * INSIDE cities and locations are zones — both excluded (they legally share cells).
 */
export function occupancyErrors(doc: MapDocument, opts: MechanicsOptions = {}): string[] {
  const errors: string[] = [];
  const n = doc.size;
  if (doc.terrain.cells.length !== n * n) return errors; // structurally broken — tier-3 reports it

  const occ = new Map<string, { type: string; id: string }>();
  const reported = new Set<string>();
  for (const o of doc.objects) {
    const fp = occupyFootprint(o, opts);
    if (!fp) continue;
    for (let dy = 0; dy < fp[1]; dy++)
      for (let dx = 0; dx < fp[0]; dx++) {
        const x = o.pos.x + dx;
        const y = o.pos.y + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const key = `${x},${y}`;
        const prev = occ.get(key);
        if (prev) {
          const pairKey = prev.id < o.id ? `${prev.id}|${o.id}` : `${o.id}|${prev.id}`;
          if (!reported.has(pairKey)) {
            reported.add(pairKey);
            errors.push(
              `mechanics: ${o.type} ${o.id} перекрывает ${prev.type} ${prev.id} в (${x},${y}) — объекты нельзя ставить внахлёст`,
            );
          }
        } else {
          occ.set(key, { type: o.type, id: o.id });
        }
      }
  }
  return errors;
}

/** One parsed MidgardPlan occupancy record: cell + the owning object's compound id. */
export interface PlanCell {
  x: number;
  y: number;
  element: string;
}

/**
 * Plan↔footprint gate — the check the GAME editor runs and ours did not, so a stale/partial
 * MidgardPlan slipped through us but was rejected on save. Reversed from ScenEdit:
 * CMidLandmark::isValid(objectMap) (vtable idx 2, sub_4F30CB) iterates EVERY cell of the
 * landmark's footprint and, via the map's CMidgardPlan, requires a plan entry at that cell
 * OWNED BY this landmark (`entry && *ownerId == *thisId`). A single uncovered cell → the game
 * flags the object invalid and REFUSES to save the scenario ("Scenario object <id> is invalid",
 * only the id logged). That is why a 2×2 wall written into the plan as a lone 1×1 cell (the
 * pre-`landmarkSize` writer bug) bricks the whole map.
 *
 * HARD errors (block export/snapshot). Owner-matched on purpose: a cell may legally carry
 * several owners' entries (the game finds ITS own), so we require only that the landmark's own
 * id is present at each of its footprint cells — no false positives on shipped maps or walltest,
 * whose landmarks are all fully+correctly registered. One error per object (no per-cell spam).
 * Off-map plan entries are reported once each (the game never writes them).
 */
export function planCoverageErrors(
  doc: MapDocument,
  plan: readonly PlanCell[],
  opts: MechanicsOptions = {},
): string[] {
  const errors: string[] = [];
  const n = doc.size;
  const ownedCells = new Map<string, Set<string>>(); // element id → its plan cells "x,y"
  for (const e of plan) {
    let s = ownedCells.get(e.element);
    if (!s) ownedCells.set(e.element, (s = new Set()));
    s.add(`${e.x},${e.y}`);
    if (e.x < 0 || e.y < 0 || e.x >= n || e.y >= n) {
      errors.push(`plan: entry for ${e.element} at (${e.x},${e.y}) is outside the ${n}×${n} map`);
    }
  }
  for (const o of doc.objects) {
    if (o.type !== "landmark") continue; // the byte-verified case that matches the game's isValid
    const [w, h] = opts.landmarkSize?.(o.baseType ?? "") ?? [1, 1];
    const mine = ownedCells.get(o.id);
    const missing: string[] = [];
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) {
        const x = o.pos.x + dx;
        const y = o.pos.y + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue; // out-of-map footprint cell isn't planned
        if (!mine?.has(`${x},${y}`)) missing.push(`${x},${y}`);
      }
    if (missing.length > 0) {
      const total = w * h;
      errors.push(
        `plan: landmark ${o.id} (${o.baseType ?? "?"}, ${w}×${h}) at (${o.pos.x},${o.pos.y}) — ` +
          `MidgardPlan covers ${total - missing.length}/${total} footprint cells, missing ${missing.slice(0, 4).join(" ")}` +
          (missing.length > 4 ? " …" : "") +
          " — the game's isValid rejects this object (map won't save)",
      );
    }
  }
  return errors;
}
