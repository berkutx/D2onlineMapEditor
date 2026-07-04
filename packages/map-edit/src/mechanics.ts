/**
 * Game-MECHANICS validation (our addition on top of the reference validator — the
 * original MapConverter::validateMap checks only database references, never terrain):
 * solid objects standing on water and roads running under water make the map wrong to
 * PLAY even though every byte and reference is fine. Generation and brushes guard
 * against creating these; this check is the safety net that catches them wherever they
 * come from (old projects, inline LLM recipes, future tools).
 *
 * Deliberately WARNINGS, not errors: shipped maps must stay green — anything they
 * legitimately contain (boat stacks on water, coastal landmarks, mountains in water —
 * all verified present in campaign maps) is excluded from the checks.
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

const isWater = (v: number): boolean => ((v >> 3) & 7) === 3;

/** Mechanics warnings for a document (empty = playable placement-wise). */
export function validateMechanics(doc: MapDocument): string[] {
  const warnings: string[] = [];
  const n = doc.size;
  const cells = doc.terrain.cells;
  if (cells.length !== n * n) return warnings; // structurally broken — tier-3 reports it

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

  for (const c of cells) {
    if (c.roadType !== -1 && isWater(c.value)) {
      warnings.push(`mechanics: дорога под водой в (${c.x},${c.y})`);
    }
  }
  return warnings;
}
