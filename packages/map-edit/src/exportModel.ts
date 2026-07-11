/**
 * exportModel — completes a MODEL that has had EditOps applied so it is self-sufficient for
 * serialization, without going through the byte writer.
 *
 * The in-memory op applier (`applyOps`) mutates objects/terrain but does NOT derive the
 * MidgardPlan occupancy index — placing a footprint object adds the object but no plan entries.
 * The byte writer (`applyEditsToBytes` → `addPlanEntries`) is what derives them today. For a
 * model-rebuild export (the model is the source of truth), that derivation must live in the
 * model layer. `deriveExportPlan` recomputes the plan from the edited object set, mirroring the
 * byte writer BYTE-FOR-BYTE: pre-existing objects keep their original plan entries (a placement
 * never re-derives them), deleted objects' entries are purged, and each newly-added object
 * contributes its footprint. The plan ELEMENT is the object's own compound id.
 *
 * Footprint sizes are byte-verified on the shipped corpus (see applyBytes.ts): village 4×4,
 * ruin/site 3×3, location/stack/chest 1×1, mountains 0 (passability is the 37-terrain stamp,
 * not a plan entry), landmark = its GLmark w×h (from the injected catalog resolver, 1×1 if
 * absent). Capitals/forts/rods/tombs/crystals are not placeable, so they only ever appear in
 * the base plan (kept verbatim) — no footprint case is needed for them.
 */

import type { MapDocument, MapObject } from "@d2/map-schema";

/** A MidgardPlan occupancy entry (cell + the compound id of the object standing on it). */
export interface ExportPlanEntry {
  x: number;
  y: number;
  element: string;
}

/** Resolve a landmark baseType (GLmark id) to its `[w, h]` footprint; undefined → 1×1. */
export type LandmarkSizeFn = (baseType: string) => readonly [number, number] | undefined;

/** The footprint `[w, h]` a freshly ADDED object claims in the plan. `[0, 0]` = no plan entries
 *  (mountains — passability is the terrain stamp). Only placeable types have a footprint; a
 *  non-placeable type returns `[0, 0]` (it never reaches the add-side derivation). */
function footprintOf(obj: MapObject, landmarkSize?: LandmarkSizeFn): readonly [number, number] {
  switch (obj.type) {
    case "landmark":
      return landmarkSize?.((obj as { baseType?: string }).baseType ?? "") ?? [1, 1];
    case "village":
      return [4, 4]; // byte-verified: 16 plan entries per placed village
    case "ruin":
    case "merchant":
    case "mage":
    case "trainer":
    case "mercenary":
      return [3, 3]; // byte-verified: 9 plan entries
    case "location":
    case "stack":
    case "treasure":
      return [1, 1]; // one anchor cell
    default:
      return [0, 0]; // mountains + non-placeable types: no add-side plan entries
  }
}

/** Plan entries a single ADDED object contributes: one per in-bounds footprint cell, element =
 *  the object's own id. Empty for mountains / non-placeable types. */
export function objectPlanEntries(
  obj: MapObject,
  mapSize: number,
  landmarkSize?: LandmarkSizeFn,
): ExportPlanEntry[] {
  const [w, h] = footprintOf(obj, landmarkSize);
  if (w === 0 || h === 0) return [];
  const out: ExportPlanEntry[] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const x = obj.pos.x + dx;
      const y = obj.pos.y + dy;
      if (x < mapSize && y < mapSize) out.push({ x, y, element: obj.id });
    }
  }
  return out;
}

/**
 * The MidgardPlan entries for the edited model, derived from the base plan + the object diff:
 *  - keep every base entry whose object still exists (drops deleted objects' entries);
 *  - append the footprint of every GENUINELY-added object (id absent from the base).
 * A delete+re-add of a pre-existing id nets out in the object diff (present in both), so its
 * original entries are kept and no duplicate is emitted — matching the byte writer. Pre-existing
 * objects (incl. moved ones) keep their base entries verbatim (the byte writer never re-derives
 * them). Returns the full ordered entry list to assign to `editedDoc.plan.entries`.
 */
export function deriveExportPlan(
  baseDoc: MapDocument,
  editedDoc: MapDocument,
  landmarkSize?: LandmarkSizeFn,
): ExportPlanEntry[] {
  const baseEntries = baseDoc.plan?.entries ?? [];
  const baseObjIds = new Set(baseDoc.objects.map((o) => o.id));
  const editedObjIds = new Set(editedDoc.objects.map((o) => o.id));
  const size = editedDoc.size;

  // Drop ONLY the entries of DELETED objects; keep everything else verbatim — surviving objects,
  // and non-object elements the plan also indexes (roads = one `…RA…` entry per MidRoad cell,
  // 516/516 on Riders). Filtering on object-id membership alone would wrongly purge every road
  // entry (their element is a road id, not an object id).
  const deletedObjIds = new Set([...baseObjIds].filter((id) => !editedObjIds.has(id)));
  const kept: ExportPlanEntry[] = baseEntries
    .filter((e) => !deletedObjIds.has(e.element))
    .map((e) => ({ x: e.x, y: e.y, element: e.element }));

  // append footprints for genuinely-new objects (absent from base → no base entries to keep)
  const added: ExportPlanEntry[] = [];
  for (const o of editedDoc.objects) {
    if (baseObjIds.has(o.id)) continue;
    added.push(...objectPlanEntries(o, size, landmarkSize));
  }
  return [...kept, ...added];
}

/**
 * Reconcile the MidRoad block list (`doc.roads`) with the terrain cells. The cells are the
 * source of truth (applyOp maintains `roadType`/`roadVar` on every setCell); `doc.roads` is
 * only the serialization block-list and is NOT updated by applyOp — so a road washed by water
 * (roadType → −1) or retuned leaves a STALE `doc.roads` entry, and the rebuild would re-emit
 * the old road. Byte-writer parity: a pre-existing road's block is KEPT with its INDEX/VAR set
 * to the cell's current values (a wash sets them to −1), never deleted. Returns a fresh roads
 * array; genuinely-new roads (no matching MidRoad block in the export skeleton) are unaffected —
 * the rebuild uses the skeleton's own block for those.
 */
function reconcileRoads(doc: MapDocument): MapDocument["roads"] {
  const roads = doc.roads;
  if (!roads || roads.length === 0) return roads;
  const n = doc.size;
  return roads.map((r) => {
    const cell = doc.terrain.cells[r.y * n + r.x];
    if (!cell) return r;
    if (cell.roadType === r.index && cell.roadVar === r.variant) return r;
    return { ...r, index: cell.roadType, variant: cell.roadVar };
  });
}

/**
 * Return `editedDoc` with its serialization-only derived structures completed for a model-rebuild
 * export: the MidgardPlan occupancy (from object footprints) and the MidRoad index/var (from the
 * terrain cells). Both are things `applyOp` doesn't maintain but the byte writer derives. The
 * returned doc is a shallow clone with fresh arrays — the base doc is never mutated. A no-op for
 * a map with neither a plan nor roads.
 */
export function completeExportModel(
  baseDoc: MapDocument,
  editedDoc: MapDocument,
  landmarkSize?: LandmarkSizeFn,
): MapDocument {
  const out: MapDocument = { ...editedDoc };
  if (editedDoc.plan) {
    out.plan = { ...editedDoc.plan, entries: deriveExportPlan(baseDoc, editedDoc, landmarkSize) };
  }
  out.roads = reconcileRoads(editedDoc);
  return out;
}
