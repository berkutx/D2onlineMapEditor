/**
 * materializeForExport — turn the edited MODEL into a FULLY self-describing model, so the whole
 * `.sg` can be re-serialised from it with NO byte-patch and NO skeleton fallback.
 *
 * The live model (applyOp/applyOps) deliberately does NOT maintain the serialization-derived state:
 * instance ids (MidItem/MidUnit) are minted at EXPORT (the reference editor mints at save), and the
 * MidgardPlan / MidRoad / MidTalismanCharges blocks are derived indexes. This pass fills all of it
 * in — as a PURE function of the final doc + the ops — so the export path never has to fall back to
 * the original bytes:
 *   - mint IM ids for every keyless item/inventory list; UN ids + slot for every keyless garrison;
 *   - add MidgardPlan footprints for added objects (op-driven), purge entries of deleted elements;
 *   - reconcile MidRoad + its plan RA entry from the terrain cells a setCell touched;
 *   - add MidTalismanCharges rows for minted talisman instances, purge rows of gone instances;
 *   - recompute the canonical template slot layout an edit dropped.
 *
 * It MIRRORS the byte writer (applyEditsToBytes) so the two agree — applyBytes stays as the parity
 * oracle in tests. Op-driven adds + state-based purges guarantee an UNEDITED map is a NO-OP (every
 * derived structure is already verbatim from the parse), preserving the byte-exact pristine rebuild.
 */

import type {
  MapDocument, MapObject, GarrisonUnit, MapPlan, RoadInfo, TalismanChargesInfo, StackTemplate,
} from "@d2/map-schema";
import { packTemplateSlots } from "@d2/sg-parser";
import { applyOps, type EditOp } from "./ops.js";

export interface MaterializeOptions {
  /** GItem TEMPLATE ids whose category is talisman (itemCatalog catKey L_TALISMAN). Each minted
   *  MidItem instance of one gets a MidTalismanCharges row (5 charges). */
  talismanTemplates?: ReadonlySet<string>;
  /** baseType (GLmark id) → its `[w,h]` footprint (decorCatalog cx/cy) for the plan occupancy. */
  landmarkSize?: (baseType: string) => readonly [number, number] | undefined;
}

const NIL = "G000000000";
const DEFAULT_TALISMAN_CHARGES = 5;
const hex4 = (n: number): string => (n >>> 0).toString(16).padStart(4, "0");

// Type-safe accessors for the instance-bearing fields (a discriminated union — `in` conflates
// merchant's {id,count}[] stock with a chest's string[] items, so switch on `type` explicitly).
// Only these carry MINTABLE MidItem/MidUnit instances; sites' stock is global template ids.
const objItems = (o: MapObject): readonly string[] | undefined =>
  o.type === "treasure" || o.type === "village" || o.type === "capital" ? o.items : undefined;
const objItemKeys = (o: MapObject): readonly string[] | undefined =>
  o.type === "treasure" || o.type === "village" || o.type === "capital" ? o.itemKeys : undefined;
const objInventory = (o: MapObject): readonly string[] | undefined =>
  o.type === "stack" ? o.inventory : undefined;
const objInventoryKeys = (o: MapObject): readonly string[] | undefined =>
  o.type === "stack" ? o.inventoryKeys : undefined;
const objGarrison = (o: MapObject): readonly (GarrisonUnit | null)[] | undefined =>
  o.type === "stack" || o.type === "village" || o.type === "capital" || o.type === "ruin" ? o.garrison : undefined;

/** Monotonic per-prefix id allocators, seeded once from the final doc (never reuse a live id). */
interface Counters {
  IM: number; UN: number; RA: number;
  version: string;
}

function seedCounters(doc: MapDocument): Counters {
  let IM = 0, UN = 0, RA = 0;
  const bumpIM = (k: string | undefined): void => {
    const m = k && /IM([0-9a-fA-F]{4})$/.exec(k);
    if (m) IM = Math.max(IM, parseInt(m[1]!, 16) + 1);
  };
  const bumpUN = (k: string | undefined): void => {
    const m = k && /UN([0-9a-fA-F]{4})$/.exec(k);
    if (m) UN = Math.max(UN, parseInt(m[1]!, 16) + 1);
  };
  for (const o of doc.objects) {
    for (const k of objItemKeys(o) ?? []) bumpIM(k);
    for (const k of objInventoryKeys(o) ?? []) bumpIM(k);
    for (const m of objGarrison(o) ?? []) bumpUN(m?.key);
  }
  for (const it of doc.strayInstances?.items ?? []) bumpIM(it.id);
  for (const u of doc.strayInstances?.units ?? []) bumpUN(u.id);
  for (const r of doc.roads ?? []) {
    const m = /RA([0-9a-fA-F]{4})$/.exec(r.id);
    if (m) RA = Math.max(RA, parseInt(m[1]!, 16) + 1);
  }
  return { IM, UN, RA, version: doc.header.version || "S143" };
}

/** The plan footprint of an object type: [w,h] to stamp its own id across, or null for none.
 *  Byte-verified against applyBytes: landmark = its GLmark w×h; village 4×4; ruin/site 3×3;
 *  location/stack/chest 1×1; capital 5×5; mountains/crystal/rod/tomb/unit = NONE. */
function footprintOf(o: MapObject, opts: MaterializeOptions): readonly [number, number] | null {
  switch (o.type) {
    case "landmark": return opts.landmarkSize?.(o.baseType ?? "") ?? [1, 1];
    case "location": case "stack": case "treasure": return [1, 1];
    case "village": return [4, 4];
    case "ruin": case "merchant": case "mage": case "trainer": case "mercenary": case "resourceMarket":
      return [3, 3];
    case "capital": return [5, 5];
    default: return null; // mountains, crystal, rod, tomb, unit, fort, generic → no plan entry
  }
}

/** Mint IM instance ids for a template list that has no on-disk keys yet (in list order). Records
 *  a talisman-charge row for every minted instance whose template is a talisman. */
function mintItemKeys(
  templates: readonly string[],
  c: Counters,
  opts: MaterializeOptions,
  newCharges: { talisman: string; charges: number }[],
): string[] {
  return templates.map((template) => {
    const id = `${c.version}IM${hex4(c.IM++)}`;
    if (opts.talismanTemplates?.has(String(template))) {
      newCharges.push({ talisman: id, charges: DEFAULT_TALISMAN_CHARGES });
    }
    return id;
  });
}

/** Pack a garrison that has no on-disk identity yet: mint a UN key per filled cell (ascending) and
 *  assign its packed-low slot. A BIG (2-cell) unit is TWO distinct cell objects that SHARE one
 *  on-disk `key` (POS_i==POS_j) — dedup by that key STRING (not object identity, which never
 *  matches for the two literals the parser builds) so the whole big unit keeps ONE key+slot and is
 *  not split into two overlapping 1-cell instances. Mirrors applyBytes packFormation. */
function mintGarrison(
  garrison: readonly (GarrisonUnit | null)[],
  c: Counters,
): (GarrisonUnit | null)[] {
  const seenByKey = new Map<string, GarrisonUnit>(); // original shared key → the ONE minted member
  let slot = 0;
  return garrison.map((m) => {
    if (!m || !m.unit) return m ?? null;
    if (m.key != null) {
      const already = seenByKey.get(m.key);
      if (already) return already; // second cell of a big unit → reuse the first cell's key+slot
    }
    const minted: GarrisonUnit = { ...m, key: `${c.version}UN${hex4(c.UN++)}`, slot: slot++ };
    if (m.key != null) seenByKey.set(m.key, minted);
    return minted;
  });
}

/** True once any filled garrison member lacks its on-disk identity (a placed/edited garrison). */
function garrisonNeedsMint(garrison: readonly (GarrisonUnit | null)[] | undefined): boolean {
  for (const m of garrison ?? []) if (m && m.unit && (m.key == null || m.slot == null)) return true;
  return false;
}

export function materializeForExport(
  baseDoc: MapDocument,
  ops: readonly EditOp[],
  opts: MaterializeOptions = {},
): MapDocument {
  // content mutations (objects / terrain / events / templates / …) — the live reducer, unchanged.
  const applied = applyOps(baseDoc, ops);
  const c = seedCounters(applied);

  const addedIds = new Set<string>();
  const deletedIds = new Set<string>();
  const templateEdited = new Set<string>();
  const roadCells: { x: number; y: number }[] = [];
  for (const op of ops) {
    if (op.kind === "addObject") addedIds.add(op.object.id);
    else if (op.kind === "deleteObject") deletedIds.add(op.id);
    else if (op.kind === "upsertTemplate") templateEdited.add(op.template.id);
    else if (op.kind === "setCell" && op.roadType !== undefined) roadCells.push({ x: op.x, y: op.y });
  }

  // SURVIVORS — a delete + re-add of the SAME id in one journal (a collab undo of a delete; foldOps
  // only folds add-BEFORE-delete, so both survive). The object stays live: keep its ORIGINAL plan
  // entries and do NOT add fresh ones (mirrors the byte writer's reAdded survivor-skip). Without
  // this the purge below strips both the fresh AND the original footprint → an object with no plan.
  const survivors = new Set([...addedIds].filter((id) => deletedIds.has(id)));

  // DELETION REFUSALS — port the byte writer's guards so the export REFUSES (→ 422) rather than
  // silently shipping a race-broken / dangling map: a Capital delete (every race must keep one, the
  // live game crashes on hire otherwise), or deleting a city's visiting-hero stack / a city hosting
  // one (would dangle the STACK/INSIDE link). Enforced here because the from-model path replaced
  // applyEditsToBytes, which used to throw these.
  for (const id of deletedIds) {
    if (survivors.has(id)) continue; // a re-add cancels the delete
    const o = baseDoc.objects.find((x) => x.id === id);
    if (!o) continue;
    if (o.type === "capital")
      throw new Error(`materializeForExport: deleteObject refused for Capital ${id} (race integrity)`);
    if (o.type === "stack" && o.inside && o.inside !== NIL)
      throw new Error(`materializeForExport: ${id} is a city's visiting hero — remove it via the city, not a map delete`);
    if (o.type === "village" && o.stackRef && o.stackRef !== NIL)
      throw new Error(`materializeForExport: ${id} hosts a visiting hero — remove the visitor first`);
  }

  const newCharges: { talisman: string; charges: number }[] = [];

  // 1) INSTANCES — mint keys for every keyless list/garrison (state-based: only placed/edited
  //    objects lack keys; originals keep theirs). Rebuild the object array with minted entities.
  const objects: MapObject[] = applied.objects.map((o) => {
    const patch: Record<string, unknown> = {};
    const items = objItems(o);
    if (items && items.length > 0 && (objItemKeys(o)?.length ?? 0) === 0) {
      patch.itemKeys = mintItemKeys(items, c, opts, newCharges);
    }
    const inv = objInventory(o);
    if (inv && inv.length > 0 && (objInventoryKeys(o)?.length ?? 0) === 0) {
      patch.inventoryKeys = mintItemKeys(inv, c, opts, newCharges);
    }
    const garr = objGarrison(o);
    if (garr && garrisonNeedsMint(garr)) patch.garrison = mintGarrison(garr, c);
    return Object.keys(patch).length ? ({ ...o, ...patch } as MapObject) : o;
  });
  const objById = new Map(objects.map((o) => [o.id, o]));

  // 2) PLAN — add footprints for ADDED objects (op-driven; never touches originals), then purge
  //    entries whose element is no longer a live object/road (deletes + washed roads).
  let plan: MapPlan | undefined = applied.plan
    ? { ...applied.plan, entries: [...applied.plan.entries] }
    : undefined;
  const size = applied.size;
  if (plan) {
    for (const id of addedIds) {
      if (survivors.has(id)) continue; // re-added object keeps its ORIGINAL plan entries
      const o = objById.get(id);
      if (!o) continue;
      const fp = footprintOf(o, opts);
      if (!fp) continue;
      const [w, h] = fp;
      // ONLY the landmark footprint is edge-clipped (matches the byte writer: village/ruin/site push
      // unconditionally); a footprint-bearing object never sits past the edge in practice.
      const clip = o.type === "landmark";
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++) {
          const px = o.pos.x + dx, py = o.pos.y + dy;
          if (!clip || (px < size && py < size)) plan.entries.push({ x: px, y: py, element: id });
        }
    }
  }

  // 3) ROADS — reconcile from the terrain cells a setCell touched. A drawn road with no block gets a
  //    fresh MidRoad + its single plan RA entry; an existing one retunes; a washed road drops both.
  let roads: RoadInfo[] = [...(applied.roads ?? [])];
  const roadByCell = new Map<string, number>(); // "x,y" -> index in roads
  roads.forEach((r, i) => roadByCell.set(`${r.x},${r.y}`, i));
  const cellAt = (x: number, y: number) => applied.terrain.cells[y * size + x];
  const newRoadPlan: { x: number; y: number; element: string }[] = [];
  for (const { x, y } of roadCells) {
    const cell = cellAt(x, y);
    if (!cell) continue;
    const key = `${x},${y}`;
    const idx = roadByCell.get(key);
    if (cell.roadType >= 0) {
      if (idx === undefined) {
        const id = `${c.version}RA${hex4(c.RA++)}`;
        roadByCell.set(key, roads.length);
        roads.push({ id, x, y, index: cell.roadType, variant: cell.roadVar < 0 ? 0 : cell.roadVar });
        if (plan) newRoadPlan.push({ x, y, element: id });
      } else {
        roads[idx] = { ...roads[idx]!, index: cell.roadType, variant: cell.roadVar < 0 ? 0 : cell.roadVar };
      }
    }
  }
  if (plan && newRoadPlan.length) plan.entries.push(...newRoadPlan);
  // washed roads (a setCell set roadType<0): drop the block and its plan entry.
  const liveRoadIds = new Set<string>();
  roads = roads.filter((r) => {
    const cell = cellAt(r.x, r.y);
    const keep = !!cell && cell.roadType >= 0;
    if (keep) liveRoadIds.add(r.id);
    return keep;
  });

  // Purge plan entries whose element is a deleted object or a washed road. A SURVIVOR (deleted then
  // re-added in the same journal) is NOT purged — its original entries stay (see above).
  if (plan) {
    plan.entries = plan.entries.filter((e) => {
      if (deletedIds.has(e.element) && !survivors.has(e.element)) return false;
      if (/RA[0-9a-fA-F]{4}$/.test(e.element) && !liveRoadIds.has(e.element)) return false;
      return true;
    });
  }

  // 4) TALISMAN CHARGES — keep only rows whose instance is still a live item key, plus new mints.
  const liveItemKeys = new Set<string>();
  for (const o of objects) {
    for (const k of objItemKeys(o) ?? []) if (k) liveItemKeys.add(k);
    for (const k of objInventoryKeys(o) ?? []) if (k) liveItemKeys.add(k);
  }
  for (const it of applied.strayInstances?.items ?? []) liveItemKeys.add(it.id);
  let satellites = applied.satellites;
  if (satellites || newCharges.length) {
    const existing = satellites?.talismanCharges ?? [];
    const kept: TalismanChargesInfo[] = existing.map((tc) => ({
      ...tc,
      entries: tc.entries.filter((e) => liveItemKeys.has(e.talisman)),
    }));
    if (newCharges.length) {
      // append to the first charges block (there is one per map), or create one keyed like the plan.
      if (kept.length) kept[0] = { ...kept[0]!, entries: [...kept[0]!.entries, ...newCharges] };
      else kept.push({ id: `${c.version}TC0000`, entries: newCharges });
    }
    satellites = { ...emptySatellites(), ...satellites, talismanCharges: kept };
  }

  // 5) TEMPLATE SLOTS — an edit dropped slots/slotOfCell; recompute the canonical layout so the
  //    serializer emits from a populated model (LEADER = duplicated cell; slots packed ascending).
  let templates = applied.templates;
  if (templateEdited.size) {
    templates = applied.templates.map((t) =>
      templateEdited.has(t.id) && !t.slots ? withCanonicalSlots(t) : t,
    );
  }

  return { ...applied, objects, plan, roads, satellites, templates };
}

function emptySatellites(): NonNullable<MapDocument["satellites"]> {
  return {
    fogs: [], playerSpells: [], playerBuildings: [], talismanCharges: [], stackDestroyed: [],
    questLogs: [], spellCasts: [], spellEffects: [], turnSummaries: [],
  };
}

/** Canonical template slot layout via the SHARED re-pack (packTemplateSlots): one slot per
 *  distinct unit, and a BIG (2-cell) unit — both column cells share `big` + the same id — is
 *  ONE slot referenced by both cells (POS_i==POS_j). Same helper the byte writer's else-branch
 *  runs, so the prod (model-rebuild) and parity (applyBytes) paths produce identical slots and
 *  an edit never splits a big unit. (The old reference-identity dedup was dead for disk-loaded
 *  templates — each cell is a distinct object — so it split every big unit.) */
function withCanonicalSlots(t: StackTemplate): StackTemplate {
  const { slots, slotOfCell } = packTemplateSlots(t.units);
  return { ...t, slots, slotOfCell };
}
