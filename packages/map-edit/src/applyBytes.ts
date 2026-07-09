/**
 * Translate a journal of EditOps into a `.sg` byte stream.
 *
 * Fixed-width edits (cell value, object move, existing-road retune) splice in place
 * via SgWriter. Growable edits:
 *   - new roads / landmarks  -> append a top-level block frame (appendBlocks), bump count.
 *   - new mountains          -> rebuild the single MidMountains block in place (replaceBlock).
 * Ops that still need a mid-stream splice (deleteObject, patchObject) fail loud.
 */

import {
  SgWriter,
  appendBlocks,
  roadFrame,
  landmarkFrame,
  locationFrame,
  mountainsFrame,
  itemFrame,
  unitFrame,
  stackFrame,
  bagFrame,
  villageFrame,
  ruinFrame,
  siteFrame,
  replaceBlock,
  deleteBlocks,
  stackDeleteCascade,
  villageDeleteCascade,
  bagDeleteCascade,
  ruinDeleteCascade,
  addPlanEntries,
  addTalismanCharges,
  DEFAULT_TALISMAN_CHARGES,
  eventFrame,
  scenVariablesFrame,
  stackTemplateFrame,
  diplomacyFrame,
  splitMultiString,
  encodeCp1251,
  spliceVariableFields,
  type SgRaw,
  type MountainEntry,
  type StringFieldEdit,
  type ItemListEdit,
  type QtyListEdit,
  type PlanEntry,
} from "@d2/sg-parser";
import type { MapObject, MapEvent, ScenarioVariable, StackTemplate, DiplomacyEntry } from "@d2/map-schema";
import type { ScenarioInfoPatch } from "@d2/socket-contract";
import type { EditOp } from "./ops.js";

export interface ApplyBytesOptions {
  /** GItem TEMPLATE ids whose category is talisman (itemCatalog catKey L_TALISMAN). When
   *  present, every MidItem instance minted from one of these gets a MidTalismanCharges
   *  entry (the reference's D2MapEditor::addItem behavior). Omitted = entries not added
   *  (callers without catalog access — the delete-side purge still always runs). */
  talismanTemplates?: ReadonlySet<string>;
  /** baseType (GLmark id) → its `[w, h]` GLmark footprint (decorCatalog cx/cy). A placed
   *  landmark occupies its FULL footprint in the MidgardPlan (byte-verified on the original's
   *  walltest: G000MG8022=1×1, G000MG0047=2×2, G000MG0003=4×4 — passability comes from plan
   *  occupancy, not terrain). Omitted → 1×1 per landmark (a 2×2 wall would then block only
   *  ¼ of itself — the "passable walls" bug). Footprint is a DERIVED render field, never on
   *  the persisted object model, so it can't affect the semantic round-trip. */
  landmarkSize?: (baseType: string) => readonly [number, number] | undefined;
}

export function applyEditsToBytes(
  raw: SgRaw,
  ops: readonly EditOp[],
  opts: ApplyBytesOptions = {},
): Uint8Array {
  const w = new SgWriter(raw);

  let nextRA = 0;
  let nextMM = 0;
  let nextLO = 0;
  let nextIM = 0;
  let nextUN = 0;
  let nextKC = 0;
  let nextBG = 0;
  let nextFT = 0;
  let nextRU = 0;
  let nextSI = 0;
  for (const o of raw.objects) {
    if (o.typeName === "MidRoad") {
      const m = /RA([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextRA = Math.max(nextRA, parseInt(m[1]!, 16) + 1);
    } else if (o.typeName === "MidStack") {
      const m = /KC([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextKC = Math.max(nextKC, parseInt(m[1]!, 16) + 1);
    } else if (o.typeName === "MidLandmark") {
      const m = /MM([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextMM = Math.max(nextMM, parseInt(m[1]!, 16) + 1);
    } else if (o.typeName === "MidLocation") {
      const m = /LO([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextLO = Math.max(nextLO, parseInt(m[1]!, 16) + 1);
    } else if (o.typeName === "MidItem") {
      const m = /IM([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextIM = Math.max(nextIM, parseInt(m[1]!, 16) + 1);
    } else if (o.typeName === "MidUnit") {
      const m = /UN([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextUN = Math.max(nextUN, parseInt(m[1]!, 16) + 1);
    } else if (o.typeName === "MidBag") {
      const m = /BG([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextBG = Math.max(nextBG, parseInt(m[1]!, 16) + 1);
    } else if (o.typeName === "MidRuin") {
      const m = /RU([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextRU = Math.max(nextRU, parseInt(m[1]!, 16) + 1);
    } else if (o.typeName.startsWith("MidSite")) {
      const m = /SI([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextSI = Math.max(nextSI, parseInt(m[1]!, 16) + 1);
    }
    // the FT prefix is SHARED by MidVillage/MidFort/Capital — seed from every FT id
    // regardless of TypeName so a fresh village never collides with a capital/fort.
    const mFT = /FT([0-9a-fA-F]{4})$/.exec(o.id);
    if (mFT) nextFT = Math.max(nextFT, parseInt(mFT[1]!, 16) + 1);
  }
  const hex4 = (n: number): string => (n >>> 0).toString(16).padStart(4, "0");
  const appends: (Uint8Array | null)[] = []; // null = a removed/superseded pending block
  const pendingRoad = new Map<string, { idx: number; ra: number }>();
  const addedMountains: MountainEntry[] = [];
  /** Re-roll patches for PRE-EXISTING mountains: raw.mountains index -> changed fields. */
  const mountainPatches = new Map<number, Partial<MountainEntry>>();
  /** Objects added this session, keyed by id, holding their FINAL pos (moves folded in).
   *  Emitted after the op loop so place-then-move of the same object exports correctly
   *  (a moveObject can't setObjectPos a block that's only appended at the end). */
  const addedObjects = new Map<string, MapObject>();
  /** M4 growable edits: variable-length string fields (names/descriptions) to splice. */
  const stringEdits: StringFieldEdit[] = [];
  /** M4 growable edits: count-prefixed ITEM_ID lists (chest contents) to rewrite. */
  const listEdits: ItemListEdit[] = [];
  /** Chest items edits, keyed by objId so the LAST list per chest wins (no stray blocks). */
  const chestItemOps = new Map<string, string[]>();
  /** Stack inventory edits (MidStack ITEM_ID list — mid-block, distinct splice). */
  const stackItemOps = new Map<string, string[]>();
  /** Site stock list edits (merchant/mage/mercs) — literal QTY_ tag, global ids. */
  const qtyListEdits: QtyListEdit[] = [];
  /** Garrison/formation edits, keyed by object id (last wins): the 6 formation cells, plus an
   *  optional leaderCell (stacks only) → which cell's unit becomes LEADER_ID. */
  type GarrCell = { unit: string; hp?: number; level?: number } | null;
  const garrisonOps = new Map<string, { cells: GarrCell[]; leaderCell?: number }>();
  /** M4 mid-stream deletes: PRE-EXISTING blocks to splice out at the very end. */
  const deletedIds: string[] = [];
  /** Cascade-only deletes (a deleted stack's garrison MidUnit + inventory MidItem instance
   *  blocks): removed with their owner but SKIP the referential guard (owner-referenced only). */
  const dependentDeleteIds: string[] = [];
  /** Deleted MidMountains ENTRIES (by raw.mountains index) — mountains live N-per-block, so a
   *  delete filters the entry out of the single-block rebuild rather than splicing a frame. */
  const deletedMountainIndices = new Set<number>();
  /** Event ops, resolved to the FINAL state per event id (last write wins): a MapEvent to
   *  upsert, or null to delete. Applied at the very end as append/replace/delete of a frame. */
  const eventOps = new Map<string, MapEvent | null>();
  /** The FINAL scenario-variables list (last setVariables wins), or null if untouched. */
  let variablesFinal: ScenarioVariable[] | null = null;
  /** Template ops resolved to final state per id (upsert value or null=delete). */
  const templateOps = new Map<string, StackTemplate | null>();
  /** Scenario-settings patch, merged across ops (later keys win). */
  let scenInfoPatch: ScenarioInfoPatch | null = null;
  /** The FINAL diplomacy list (last setDiplomacy wins), or null if untouched. */
  let diplomacyFinal: DiplomacyEntry[] | null = null;
  let nextTM = 0;
  for (const o of raw.objects) {
    const m = /TM([0-9a-fA-F]{4})$/.exec(o.id);
    if (o.typeName === "MidStackTemplate" && m) nextTM = Math.max(nextTM, parseInt(m[1]!, 16) + 1);
  }
  /** Fresh EV-block id counter, seeded from existing MidEvent blocks. */
  let nextEV = 0;
  for (const o of raw.objects) {
    const m = /EV([0-9a-fA-F]{4})$/.exec(o.id);
    if (o.typeName === "MidEvent" && m) nextEV = Math.max(nextEV, parseInt(m[1]!, 16) + 1);
  }

  for (const op of ops) {
    switch (op.kind) {
      case "setCell": {
        w.setCellValue(op.x, op.y, op.value);
        if (op.roadType === undefined) break;
        const key = `${op.x},${op.y}`;
        if (op.roadType >= 0) {
          const vv = op.roadVar ?? 0;
          if (raw.roadByCell.has(key)) {
            w.setRoad(op.x, op.y, op.roadType, vv);
          } else {
            const prev = pendingRoad.get(key);
            const ra = prev ? prev.ra : nextRA++;
            const frame = roadFrame(raw.version, ra, op.x, op.y, op.roadType, vv);
            if (prev) appends[prev.idx] = frame;
            else {
              pendingRoad.set(key, { idx: appends.length, ra });
              appends.push(frame);
            }
          }
        } else {
          // road removal: drop a same-session added road, else retune an existing block to -1
          const prev = pendingRoad.get(key);
          if (prev) {
            appends[prev.idx] = null;
            pendingRoad.delete(key);
          } else if (raw.roadByCell.has(key)) {
            w.setRoad(op.x, op.y, -1, -1);
          }
        }
        break;
      }
      case "moveObject": {
        // a same-session added object isn't in the raw bytes yet — fold the move into
        // its pending entry; only PRE-EXISTING objects get an in-place POS splice.
        const added = addedObjects.get(op.id);
        if (added) addedObjects.set(op.id, { ...added, pos: { x: op.x, y: op.y } });
        else w.setObjectPos(op.id, op.x, op.y);
        break;
      }
      case "addObject":
        // defer emission until after the loop so trailing moves are coalesced in.
        addedObjects.set(op.object.id, op.object);
        break;
      case "patchObject": {
        // re-roll a placed object's look, keeping its footprint.
        const added = addedObjects.get(op.id);
        if (added) {
          addedObjects.set(op.id, { ...added, ...op.fields } as MapObject);
          break;
        }
        const f = op.fields as Record<string, unknown>;
        const hash = op.id.indexOf("#");
        if (hash >= 0 && typeof f.image === "number") {
          // pre-existing mountain (id = <blockId>#<index>) -> rebuild MidMountains with new image
          const idx = parseInt(op.id.slice(hash + 1), 10);
          mountainPatches.set(idx, { ...(mountainPatches.get(idx) ?? {}), image: f.image });
        } else if (typeof f.baseType === "string") {
          // landmark look = its TYPE string (a 10-char GLmark id -> fixed-width splice)
          w.setObjectString(op.id, "TYPE", f.baseType);
        } else {
          // chest/ruin/city property edits. field name -> .sg tag, by storage kind:
          const o = raw.objectById.get(op.id);
          const isRuin = o?.typeName === "MidRuin";
          const isSite = !!o && o.typeName.startsWith("MidSite"); // Merchant/Mage/Trainer/Mercs
          // 1) fixed-width int32 — splice in place. Sites store their image as IMG_ISO (not
          //    IMAGE); crystals store the mana school as RESOURCE.
          const INT_TAG: Record<string, string> = {
            image: isSite ? "IMG_ISO" : "IMAGE", tier: "SIZE", priority: "AIPRIORITY",
            morale: "MORALE", regen: "REGEN_B", growth: "GROWTH_T", resource: "RESOURCE",
            // stack (Отряд) scalar fields:
            order: "ORDER", facing: "FACING", move: "MOVE", creatLvl: "CREAT_LVL",
            radius: "RADIUS", // MidLocation size step (0=1×1, 1=3×3, 2=5×5)
          };
          // 2) string fields — ALL via the growable splice (handles same-length compound
          //    ids / CASH AND variable-length user text uniformly; never length-throws).
          //    name tag differs by type (ruin = TITLE, site = TXT_TITLE, else = NAME_TXT).
          const STR_TAG: Record<string, string> = {
            name: isRuin ? "TITLE" : isSite ? "TXT_TITLE" : "NAME_TXT", desc: isRuin ? "DESC" : "DESC_TXT",
            owner: "OWNER", subRace: "SUBRACE", item: "ITEM", looter: "LOOTER", reward: "CASH",
            banner: "BANNER", // stack banner-item slot (growable ref; "000000" = empty)
            stackRef: "STACK", // city → its visiting hero stack (KC id; "G000000000" = none)
          };
          const handled = new Set<string>();
          for (const [key, tag] of Object.entries(INT_TAG)) {
            if (typeof f[key] === "number") { w.setObjectInt(op.id, tag, f[key] as number); handled.add(key); }
          }
          for (const [key, tag] of Object.entries(STR_TAG)) {
            if (typeof f[key] === "string") {
              if (!o) throw new Error(`applyEditsToBytes: patchObject ${op.id} unknown object`);
              stringEdits.push({ fieldsFrom: o.fieldsFrom, fieldsEnd: o.fieldsEnd, tag, value: f[key] as string });
              handled.add(key);
            }
          }
          // 2c) stack leader equipment — 6 item-ref slots, via the growable string path so an
          //     empty "000000" slot can grow to a 10-char ref (and shrink back). Always write all
          //     6 (empty -> "000000") so the edit round-trips against the cleared (undefined) model.
          if (f.equip && typeof f.equip === "object") {
            if (!o) throw new Error(`applyEditsToBytes: patchObject ${op.id} unknown object`);
            const EQUIP_TAG: Record<string, string> = {
              tome: "TOME", battle1: "BATTLE1", battle2: "BATTLE2",
              artifact1: "ARTIFACT1", artifact2: "ARTIFACT2", boots: "BOOTS",
            };
            const eq = f.equip as Record<string, unknown>;
            for (const [k, tag] of Object.entries(EQUIP_TAG)) {
              const v = eq[k];
              stringEdits.push({
                fieldsFrom: o.fieldsFrom, fieldsEnd: o.fieldsEnd, tag,
                value: typeof v === "string" && v ? v : "000000",
              });
            }
            handled.add("equip");
          }
          // 3) list fields. `items` is a chest ITEM_ID list (MidBag — global templates, MidItem
          //    instances re-created on export, processed after the loop) OR a merchant stock
          //    (MidSiteMerchant — global ids written directly via the QTY_ITEM list).
          if (Array.isArray(f.items)) {
            if (!o) throw new Error(`applyEditsToBytes: patchObject ${op.id} unknown object`);
            if (o.typeName === "MidBag") {
              chestItemOps.set(op.id, (f.items as unknown[]).map(String));
            } else if (o.typeName === "MidSiteMerchant") {
              qtyListEdits.push({
                fieldsFrom: o.fieldsFrom, fieldsEnd: o.fieldsEnd, qtyTag: "QTY_ITEM",
                schema: [{ tag: "ITEM_ID", kind: "str" }, { tag: "ITEM_COUNT", kind: "int" }],
                entries: (f.items as { id: string; count: number }[]).map((it) => [it.id, it.count]),
              });
            } else {
              throw new Error(`applyEditsToBytes: 'items' on unexpected object ${o.typeName}`);
            }
            handled.add("items");
          }
          // stack (Отряд) carried inventory — a MidStack ITEM_ID list (global templates, MidItem
          // instances re-created on export like a chest, but spliced mid-block; see below).
          if (Array.isArray(f.inventory)) {
            if (!o) throw new Error(`applyEditsToBytes: patchObject ${op.id} unknown object`);
            if (o.typeName !== "MidStack") throw new Error(`applyEditsToBytes: 'inventory' on unexpected object ${o.typeName}`);
            stackItemOps.set(op.id, (f.inventory as unknown[]).map(String));
            handled.add("inventory");
          }
          // mage spell stock (QTY_SPELL — global Gspells ids).
          if (Array.isArray(f.spells)) {
            if (!o) throw new Error(`applyEditsToBytes: patchObject ${op.id} unknown object`);
            qtyListEdits.push({
              fieldsFrom: o.fieldsFrom, fieldsEnd: o.fieldsEnd, qtyTag: "QTY_SPELL",
              schema: [{ tag: "SPELL_ID", kind: "str" }],
              entries: (f.spells as string[]).map((s) => [s]),
            });
            handled.add("spells");
          }
          // mercenary stock (QTY_UNIT — global Gunits ids + level + unique).
          if (Array.isArray(f.units) && o?.typeName === "MidSiteMercs") {
            qtyListEdits.push({
              fieldsFrom: o.fieldsFrom, fieldsEnd: o.fieldsEnd, qtyTag: "QTY_UNIT",
              schema: [{ tag: "UNIT_ID", kind: "str" }, { tag: "UNIT_LEVEL", kind: "int" }, { tag: "UNIT_UNIQ", kind: "bool" }],
              entries: (f.units as { id: string; level: number; unique: boolean }[]).map((u) => [u.id, u.level, u.unique]),
            });
            handled.add("units");
          }
          // fort garrison (village/capital) — 6 formation cells; deferred to after the loop
          // (creates MidUnit instances + fixed-width fort slot splices).
          if (Array.isArray(f.garrison)) {
            if (!o) throw new Error(`applyEditsToBytes: patchObject ${op.id} unknown object`);
            garrisonOps.set(op.id, {
              cells: f.garrison as GarrCell[],
              leaderCell: typeof f.leaderCell === "number" ? f.leaderCell : undefined,
            });
            handled.add("garrison");
            if ("leaderCell" in f) handled.add("leaderCell");
          }
          // derived/render-only fields carry no .sg storage (resolved at parse from owner,
          // subrace, etc.) — patched only to refresh the live sprite; skip on export.
          const DERIVED = new Set(["race", "bannerIndex", "imageName", "footprint", "z", "looted", "leaderImage"]);
          const left = Object.keys(f).filter((k) => !handled.has(k) && !DERIVED.has(k));
          if (left.length) {
            // e.g. `items` (ITEM_ID list) — count-prefixed list editing is a later step.
            throw new Error(
              `applyEditsToBytes: patchObject ${op.id} fields [${left}] not byte-writable yet`,
            );
          }
        }
        break;
      }
      case "deleteObject": {
        // M4 mid-stream delete (block-range splice + OB0000 decrement via deleteBlocks).
        // A MOUNTAIN id is "<mountainsBlockId>#<index>" — a synthetic per-entry id NOT in
        // objectById (mountains live N-per-block). Route it to the block rebuild BEFORE the
        // objectById lookup (which would otherwise throw "unknown object").
        const hash = op.id.indexOf("#");
        if (hash >= 0 && raw.mountainsBlockId && op.id.slice(0, hash) === raw.mountainsBlockId) {
          const idx = parseInt(op.id.slice(hash + 1), 10);
          if (!Number.isInteger(idx) || idx < 0 || idx >= raw.mountains.length) {
            // an added-this-session mountain should have been folded out (foldOps); a bad
            // index means a delete with no matching raw entry — fail loud, don't guess.
            throw new Error(`applyEditsToBytes: deleteObject mountain ${op.id} has no raw entry`);
          }
          deletedMountainIndices.add(idx);
          break;
        }
        const rec = raw.objectById.get(op.id);
        if (!rec) {
          // a delete of a CLIENT-added object should have been folded out (foldOps)
          throw new Error(`applyEditsToBytes: deleteObject of unknown object ${op.id}`);
        }
        if (rec.typeName === "MidLandmark") {
          // decor — inverse addObject is fully reconstructible via landmarkFrame.
          deletedIds.push(op.id);
        } else if (rec.typeName === "MidStack") {
          // an army/hero stack: cascade-delete its garrison MidUnit + inventory MidItem
          // instance blocks (referenced ONLY by this stack, so they skip the referential guard).
          // The inverse addObject carries the FULL stack (garrison/leader/inventory from the doc),
          // which the stack add-path re-emits — so collab/undo round-trips semantically.
          const casc = stackDeleteCascade(raw, op.id);
          if (casc.holder) {
            // a city's VISITING hero: the city's STACK ref would dangle. Clearing it on the DOC
            // side can't survive the JSON journal (an omitted-key edit), so the semantic tier
            // would fail — refuse here (sanctioned by the reference) and manage visitors via the
            // city inspector instead. Free-standing stacks delete cleanly.
            throw new Error(
              `applyEditsToBytes: ${op.id} is a city's visiting hero — remove it via the city, not a map delete`,
            );
          }
          deletedIds.push(op.id);
          dependentDeleteIds.push(...casc.dependentIds);
        } else if (rec.typeName === "MidBag") {
          // a chest: cascade its MidItem instances (ITEM_ID list); a talisman's charges
          // entry is purged inside deleteBlocks. Undo re-adds via bagFrame (items are
          // global templates in the doc — fresh instances are minted on re-add).
          deletedIds.push(op.id);
          dependentDeleteIds.push(...bagDeleteCascade(raw, op.id));
        } else if (rec.typeName === "MidVillage") {
          // a village: cascade its garrison MidUnit instances. A village hosting a
          // VISITING hero is refused (same journal/undo constraint as the visitor itself).
          const casc = villageDeleteCascade(raw, op.id);
          if (casc.hasVisitor) {
            throw new Error(
              `applyEditsToBytes: ${op.id} hosts a visiting hero — remove the visitor first`,
            );
          }
          deletedIds.push(op.id);
          dependentDeleteIds.push(...casc.dependentIds);
        } else if (rec.typeName === "MidRuin") {
          // a ruin: cascade its guardian MidUnit instances; the loot ITEM is a global
          // template (no instance). Undo re-adds via ruinFrame (garrison from the doc).
          deletedIds.push(op.id);
          dependentDeleteIds.push(...ruinDeleteCascade(raw, op.id));
        } else if (
          rec.typeName === "MidSiteMerchant" ||
          rec.typeName === "MidSiteMage" ||
          rec.typeName === "MidSiteTrainer" ||
          rec.typeName === "MidSiteMercs"
        ) {
          // a site: stock lists are GLOBAL template ids (no MidItem/MidUnit instances),
          // so no cascade — just the block + its 9 plan entries (3×3, byte-verified).
          // The ref guard in deleteBlocks still refuses if events reference the site.
          deletedIds.push(op.id);
        } else if (rec.typeName === "Capital") {
          // capitals are load-bearing: every race must keep one (the game refuses/crashes
          // without it) — deletion stays refused, not just unimplemented.
          throw new Error(`applyEditsToBytes: deleteObject refused for Capital (race integrity)`);
        } else {
          throw new Error(
            `applyEditsToBytes: deleteObject for ${rec.typeName} not supported yet ` +
              `(MidLandmark, MidStack, MidMountains, MidBag, MidVillage, MidSite*)`,
          );
        }
        break;
      }

      case "upsertEvent":
        eventOps.set(op.event.id, op.event);
        break;
      case "deleteEvent":
        eventOps.set(op.id, null);
        break;
      case "setVariables":
        variablesFinal = op.variables.slice();
        break;
      case "upsertTemplate": {
        // drop the load-only verbatim slot layout: an edited template re-packs canonically
        // (a stale raw replayed into the frame would overwrite the edit)
        const tmpl = { ...op.template };
        delete (tmpl as { raw?: unknown }).raw;
        templateOps.set(tmpl.id, tmpl);
        break;
      }
      case "deleteTemplate":
        templateOps.set(op.id, null);
        break;
      case "setScenarioInfo":
        scenInfoPatch = { ...(scenInfoPatch ?? {}), ...op.fields };
        break;
      case "setDiplomacy":
        diplomacyFinal = op.diplomacy.slice();
        break;
    }
  }

  /** Freshly minted MidItem instances whose template is a TALISMAN — each needs a
   *  MidTalismanCharges entry (the reference's addItem behavior; charges = GVars default). */
  const mintedTalismans: { itemId: string; charges: number }[] = [];

  /** Mint one appended MidItem instance per global GItem template id, returning the new
   *  instance ids (shared by chest lists, stack inventories and added-object frames). */
  const mintItems = (templates: readonly string[] | undefined): string[] =>
    (templates ?? []).map((template) => {
      const second = nextIM++;
      appends.push(itemFrame(raw.version, second, String(template)));
      const id = `${raw.version}IM${hex4(second)}`;
      if (opts.talismanTemplates?.has(String(template))) {
        mintedTalismans.push({ itemId: id, charges: DEFAULT_TALISMAN_CHARGES });
      }
      return id;
    });

  // Resolve each edited chest's FINAL item list (last write won): the list holds global
  // GItem template ids, so instantiate a fresh MidItem block per entry and point the bag's
  // ITEM_ID list at the new instances. The chest's original instances are left in place
  // (orphaned) — harmless (each still references a valid template); GC of unreferenced
  // MidItems is a later refinement. Object count bumps by the number of new MidItems.
  for (const [objId, templates] of chestItemOps) {
    const o = raw.objectById.get(objId);
    if (!o) throw new Error(`applyEditsToBytes: chest items edit for unknown object ${objId}`);
    listEdits.push({ fieldsFrom: o.fieldsFrom, fieldsEnd: o.fieldsEnd, objId, instanceIds: mintItems(templates) });
  }

  // Stack inventory: same MidItem-instance re-creation as a chest, but the list is mid-block so it
  // gets the dedicated stackItemListSplice (precise count-tag locator + span-walk) on export.
  const stackListEdits: ItemListEdit[] = [];
  for (const [objId, templates] of stackItemOps) {
    const o = raw.objectById.get(objId);
    if (!o) throw new Error(`applyEditsToBytes: stack inventory edit for unknown object ${objId}`);
    stackListEdits.push({ fieldsFrom: o.fieldsFrom, fieldsEnd: o.fieldsEnd, objId, instanceIds: mintItems(templates) });
  }

  // Resolve each edited fort's FINAL garrison (last write won): create a fresh MidUnit instance
  // per filled formation cell and write the fort's embedded UNIT_0..5/POS_0..5 (fixed-width
  // refField/int splices). Old MidUnit instances are left orphaned (harmless). The .sg stores
  // two PARALLEL arrays: UNIT_j = units in insertion order (filled cells packed into the low
  // slots), and POS_i = indexed by FORMATION CELL i, holding the UNIT_ slot of cell i's unit
  // (-1 = empty cell). So cell i = UNIT_[POS_i] — verified vs D2RSG group.cpp serialize().
  for (const [fortId, { cells, leaderCell }] of garrisonOps) {
    const fo = raw.objectById.get(fortId);
    if (!fo) throw new Error(`applyEditsToBytes: garrison edit for unknown object ${fortId}`);
    const slotOfCell: number[] = [-1, -1, -1, -1, -1, -1];
    const instOfCell: (string | null)[] = [null, null, null, null, null, null];
    let slot = 0;
    for (let cell = 0; cell < 6; cell++) {
      const gu = cells[cell];
      if (!gu || !gu.unit) continue;
      const second = nextUN++;
      const inst = `${raw.version}UN${hex4(second)}`;
      appends.push(unitFrame(raw.version, second, gu.unit, gu.level ?? 1, gu.hp ?? 0));
      w.setObjectString(fortId, `UNIT_${slot}`, inst);
      slotOfCell[cell] = slot;
      instOfCell[cell] = inst;
      slot++;
    }
    for (let s = slot; s < 6; s++) w.setObjectString(fortId, `UNIT_${s}`, "G000000000");
    for (let cell = 0; cell < 6; cell++) w.setObjectInt(fortId, `POS_${cell}`, slotOfCell[cell] ?? -1);
    // Stacks (Отряд): LEADER_ID names the leader cell's new instance (or none). Via the growable
    // string path so a no-leader stack's short "000000" sentinel can grow to a 10-char ref.
    if (leaderCell !== undefined) {
      const li = leaderCell >= 0 && leaderCell < 6 ? instOfCell[leaderCell] : null;
      stringEdits.push({ fieldsFrom: fo.fieldsFrom, fieldsEnd: fo.fieldsEnd, tag: "LEADER_ID", value: li ?? "G000000000" });
    }
  }

  /** Pack a formation for an ADDED fort/stack: mint one appended MidUnit instance per filled
   *  cell and return the parallel arrays the .sg stores — unitSlots (instances in insertion
   *  order) + posOfCell (cell i -> UNIT_ slot, -1 empty; cell i = UNIT_[POS_i]) — plus the
   *  per-cell instance ids (for LEADER_ID resolution). Same encoding as the garrisonOps
   *  writer above, but into a fresh frame instead of fixed-width splices. */
  const packFormation = (
    cells: readonly ({ unit: string; level?: number; hp?: number } | null)[] | undefined,
  ): { unitSlots: string[]; posOfCell: number[]; instOfCell: (string | null)[] } => {
    const unitSlots: string[] = [];
    const posOfCell = [-1, -1, -1, -1, -1, -1];
    const instOfCell: (string | null)[] = [null, null, null, null, null, null];
    for (let cell = 0; cell < 6; cell++) {
      const gu = cells?.[cell];
      if (!gu || !gu.unit) continue;
      const second = nextUN++;
      const inst = `${raw.version}UN${hex4(second)}`;
      appends.push(unitFrame(raw.version, second, gu.unit, gu.level ?? 1, gu.hp ?? 0));
      posOfCell[cell] = unitSlots.length;
      instOfCell[cell] = inst;
      unitSlots.push(inst);
    }
    return { unitSlots, posOfCell, instOfCell };
  };

  // MidgardPlan entries for ADDED objects: one {POS_X, POS_Y, ELEMENT} per occupied footprint
  // cell, mirroring the purge on delete. Byte-verified membership on the Riders plan:
  //   landmark = its w×h footprint (not available in map-edit -> 1×1, see below);
  //   location = EXACTLY ONE entry (its anchor cell, radius-independent — all 418 Riders
  //              MidLocations have one entry each);
  //   stack    = 1 cell (garrisoned visitors included — all 119 KC ids are in the plan);
  //   chest    = 1 cell; village = 4×4 (16 entries per FT village id; capitals are 5×5);
  //   mountains = NONE (zero ML refs in the plan — passability comes from the 37-stamped
  //               cells); roads = ONE entry per MidRoad block cell (516/516 on Riders) —
  //               added below, after the pendingRoad frames settle.
  const planAdds: PlanEntry[] = [];

  // Emit added objects at their FINAL state (place + later moves/patches coalesced).
  for (const o of addedObjects.values()) {
    if (o.type === "landmark") {
      const m = /MM([0-9a-fA-F]{4})$/.exec(o.id);
      const second = m ? parseInt(m[1]!, 16) : nextMM++;
      const full = `${raw.version}MM${hex4(second)}`;
      // Pass o.desc THROUGH (not `?? ""`): the model's desc presence IS the DESC_TXT presence.
      // Editor-placed landmarks carry desc:"" (placeLandmarkOps) → empty DESC_TXT written (эталон
      // parity); a desc-less op → field omitted, so it reparses identically (no phantom "").
      appends.push(landmarkFrame(raw.version, second, o.pos.x, o.pos.y, o.baseType ?? "G000000000", o.desc));
      // plan = the landmark's FULL GLmark footprint (from the injected resolver; 1×1 if absent).
      // The original editor registers every footprint cell (byte-verified on walltest.sg), and
      // passability is plan occupancy — a 2×2 wall MUST claim all 4 cells or units walk through
      // ¾ of it. In-bounds guarded (a footprint never extends past the map edge).
      const [lw, lh] = opts.landmarkSize?.(o.baseType ?? "") ?? [1, 1];
      for (let dy = 0; dy < lh; dy++)
        for (let dx = 0; dx < lw; dx++) {
          const px = o.pos.x + dx, py = o.pos.y + dy;
          if (px < raw.size && py < raw.size) planAdds.push({ x: px, y: py, element: full });
        }
    } else if (o.type === "location") {
      // A named region (MidLocation). Same-session patchObject of name/radius already
      // folded into `o` via the addedObjects {...added, ...fields} merge above.
      const m = /LO([0-9a-fA-F]{4})$/.exec(o.id);
      const second = m ? parseInt(m[1]!, 16) : nextLO++;
      appends.push(locationFrame(raw.version, second, o.pos.x, o.pos.y, o.name ?? "", o.radius ?? 0));
      planAdds.push({ x: o.pos.x, y: o.pos.y, element: `${raw.version}LO${hex4(second)}` });
    } else if (o.type === "mountains") {
      // no plan entries for mountains (byte-verified: none in Riders)
      addedMountains.push({
        x: o.pos.x, y: o.pos.y, w: o.w ?? 1, h: o.h ?? 1,
        image: o.image ?? 0, race: o.race ?? 0,
      });
    } else if (o.type === "stack") {
      // A hero stack: either a city VISITOR (empty formation; INSIDE → the city, whose
      // STACK link is a separate patchObject stackRef edit) or a REAL army placed on the
      // map (formation cells + leaderCell from the object model — placeStackOps). Same-
      // session formation/equip/inventory/scalar patches on this ADDED stack FOLD into `o`
      // via the addedObjects merge and are consumed here.
      const m = /KC([0-9a-fA-F]{4})$/.exec(o.id);
      const second = m ? parseInt(m[1]!, 16) : nextKC++;
      const g = packFormation(o.garrison);
      appends.push(stackFrame(raw.version, second, {
        owner: o.owner ?? "G000000000",
        inside: o.inside ?? "G000000000",
        subRace: o.subRace,
        posX: o.pos.x,
        posY: o.pos.y,
        unitSlots: g.unitSlots,
        posOfCell: g.posOfCell,
        leaderId: o.leaderCell !== undefined ? g.instOfCell[o.leaderCell] ?? undefined : undefined,
        itemIds: mintItems(o.inventory),
        morale: o.morale, move: o.move, facing: o.facing,
        banner: o.banner, equip: o.equip,
        order: o.order, priority: o.priority, creatLvl: o.creatLvl,
      }));
      planAdds.push({ x: o.pos.x, y: o.pos.y, element: `${raw.version}KC${hex4(second)}` });
    } else if (o.type === "treasure") {
      // A chest (MidBag). `o.items` are global GItem template ids; same-session item edits
      // on this ADDED chest folded into `o` (the addedObjects merge above), NOT into the
      // raw-bytes list splice — the whole final list lands in the fresh frame here.
      const m = /BG([0-9a-fA-F]{4})$/.exec(o.id);
      const second = m ? parseInt(m[1]!, 16) : nextBG++;
      appends.push(bagFrame(raw.version, second, {
        posX: o.pos.x,
        posY: o.pos.y,
        image: o.image ?? 0,
        priority: o.priority ?? 0,
        itemIds: mintItems(o.items),
      }));
      planAdds.push({ x: o.pos.x, y: o.pos.y, element: `${raw.version}BG${hex4(second)}` });
    } else if (o.type === "village") {
      // A village (MidVillage). Same-session garrison/name/etc. patches on this ADDED
      // village FOLD into `o` (addedObjects merge) and are consumed here — never routed
      // to the fixed-width fort-slot splices (which need pre-existing raw ranges).
      const m = /FT([0-9a-fA-F]{4})$/.exec(o.id);
      const second = m ? parseInt(m[1]!, 16) : nextFT++;
      const full = `${raw.version}FT${hex4(second)}`;
      const g = packFormation(o.garrison);
      appends.push(villageFrame(raw.version, second, {
        posX: o.pos.x,
        posY: o.pos.y,
        name: o.name ?? "",
        desc: o.desc ?? "",
        owner: o.owner,
        subRace: o.subRace,
        stackRef: o.stackRef,
        tier: o.tier ?? 1,
        priority: o.priority ?? 0,
        regen: o.regen ?? 0,
        morale: o.morale ?? 0,
        growth: o.growth ?? 0,
        unitSlots: g.unitSlots,
        posOfCell: g.posOfCell,
      }));
      // village footprint = 4×4 (byte-verified: every Riders MidVillage id has 16 plan entries)
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          planAdds.push({ x: o.pos.x + dx, y: o.pos.y + dy, element: full });
        }
      }
    } else if (o.type === "ruin") {
      // A ruin (MidRuin) — realistically only the UNDO re-add of a delete (there is no
      // ruin place tool): guardians re-mint like a fort garrison, ITEM is a global
      // template written verbatim. Mirrors readRuin exactly for the semantic tier.
      const m = /RU([0-9a-fA-F]{4})$/.exec(o.id);
      const second = m ? parseInt(m[1]!, 16) : nextRU++;
      const full = `${raw.version}RU${hex4(second)}`;
      const g = packFormation(o.garrison);
      appends.push(ruinFrame(raw.version, second, {
        posX: o.pos.x,
        posY: o.pos.y,
        name: o.name ?? "",
        desc: o.desc,
        image: o.image ?? 0,
        reward: o.reward,
        item: o.item,
        looter: o.looter,
        priority: o.priority ?? 0,
        unitSlots: g.unitSlots,
        posOfCell: g.posOfCell,
      }));
      // ruin footprint = 3×3 (byte-verified: every Riders MidRuin id has 9 plan entries)
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          planAdds.push({ x: o.pos.x + dx, y: o.pos.y + dy, element: full });
        }
      }
    } else if (
      o.type === "merchant" || o.type === "mage" || o.type === "trainer" || o.type === "mercenary"
    ) {
      // a site (MidSite*) — realistically only the UNDO re-add of a delete (there is no
      // site place tool). Stock lists are global template ids, written verbatim.
      const m = /SI([0-9a-fA-F]{4})$/.exec(o.id);
      const second = m ? parseInt(m[1]!, 16) : nextSI++;
      const full = `${raw.version}SI${hex4(second)}`;
      appends.push(siteFrame(raw.version, second, o.type, {
        posX: o.pos.x,
        posY: o.pos.y,
        name: o.name ?? "",
        desc: (o as { desc?: string }).desc ?? "",
        image: o.image ?? 0,
        items: (o as { items?: { id: string; count: number }[] }).items,
        spells: (o as { spells?: string[] }).spells,
        units: (o as { units?: { id: string; level: number; unique: boolean }[] }).units,
      }));
      // site footprint = 3×3 (byte-verified: every Riders SI id has exactly 9 plan entries)
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          planAdds.push({ x: o.pos.x + dx, y: o.pos.y + dy, element: full });
        }
      }
    } else {
      throw new Error(`applyEditsToBytes: addObject type '${o.type}' not supported yet (M4)`);
    }
  }

  // roads: every SURVIVING same-session road frame gets its plan entry — byte-verified:
  // all 516 Riders MidRoad blocks have exactly one RA plan entry on their cell (a road
  // added-then-erased in one session has a nulled frame and gets none).
  for (const [key, pr] of pendingRoad) {
    if (appends[pr.idx] === null) continue;
    const [rx, ry] = key.split(",").map(Number);
    planAdds.push({ x: rx!, y: ry!, element: `${raw.version}RA${hex4(pr.ra)}` });
  }

  // Scenario settings: ints are fixed-width (SgWriter), texts are growable string splices on
  // the ScenarioInfo block, and name/desc/author ALSO live in the FILE HEADER at fixed,
  // zero-padded offsets (desc @43×256B, author @299×21B, name @321×64B — the D2EESFISIG
  // MapHeaderBlock layout, before every object frame, so later splices never move them).
  const headerPatches: { at: number; size: number; value: string }[] = [];
  if (scenInfoPatch) {
    const info = raw.objects.find((o) => o.typeName === "ScenarioInfo");
    if (!info) throw new Error("applyEditsToBytes: setScenarioInfo — no ScenarioInfo block");
    const p = scenInfoPatch;
    const str = (tag: string, value: string): void => {
      stringEdits.push({ fieldsFrom: info.fieldsFrom, fieldsEnd: info.fieldsEnd, tag, value });
    };
    if (p.name !== undefined) {
      if (encodeCp1251(p.name).length > 64) throw new Error("setScenarioInfo: name > 64 bytes");
      str("NAME", p.name);
      headerPatches.push({ at: 321, size: 64, value: p.name });
    }
    if (p.description !== undefined) {
      if (encodeCp1251(p.description).length > 256) throw new Error("setScenarioInfo: description > 256 bytes");
      str("DESC", p.description);
      headerPatches.push({ at: 43, size: 256, value: p.description });
    }
    if (p.author !== undefined) {
      if (encodeCp1251(p.author).length > 21) throw new Error("setScenarioInfo: author > 21 bytes");
      str("CREATOR", p.author);
      headerPatches.push({ at: 299, size: 21, value: p.author });
    }
    if (p.objective !== undefined) str("BRIEFING", p.objective);
    if (p.loseText !== undefined) str("DEBUNKL", p.loseText);
    if (p.winText !== undefined) {
      const parts = splitMultiString(p.winText, 5);
      ["DEBUNKW", "DEBUNKW2", "DEBUNKW3", "DEBUNKW4", "DEBUNKW5"].forEach((tag, i) => str(tag, parts[i]!));
    }
    if (p.story !== undefined) {
      const parts = splitMultiString(p.story, 5);
      ["BRIEFLONG1", "BRIEFLONG2", "BRIEFLONG3", "BRIEFLONG4", "BRIEFLONG5"].forEach((tag, i) => str(tag, parts[i]!));
    }
    if (p.limits !== undefined) {
      w.setObjectInt(info.id, "MAX_UNIT", p.limits.unit);
      w.setObjectInt(info.id, "MAX_SPELL", p.limits.spell);
      w.setObjectInt(info.id, "MAX_LEADER", p.limits.leader);
      w.setObjectInt(info.id, "MAX_CITY", p.limits.city);
    }
    if (p.difficulty !== undefined) {
      w.setObjectInt(info.id, "DIFFSCEN", p.difficulty.scenario);
      w.setObjectInt(info.id, "DIFFGAME", p.difficulty.game);
    }
    if (p.suggestedLevel !== undefined) w.setObjectInt(info.id, "SUGG_LVL", p.suggestedLevel);
  }

  let bytes = w.toBytes();
  // file-header fixed-offset text patches (CP1251, zero-padded to the field size)
  for (const hp of headerPatches) {
    const enc = encodeCp1251(hp.value);
    bytes.fill(0, hp.at, hp.at + hp.size);
    bytes.set(enc, hp.at);
  }
  // M4: resize variable-length string fields + ITEM_ID lists in place (object count
  // unchanged by the splice itself; new MidItem blocks are appended below). Done before the
  // append/replace passes; those re-scan markers + the header count (all preserved). Both
  // splice kinds share one highest-offset-first pass so cross-object offsets stay valid.
  if (stringEdits.length || listEdits.length || qtyListEdits.length || stackListEdits.length) {
    bytes = spliceVariableFields(bytes, stringEdits, listEdits, qtyListEdits, stackListEdits);
  }
  const frames = appends.filter((f): f is Uint8Array => f !== null);
  if (frames.length) bytes = appendBlocks(bytes, frames);
  // placement plan: one entry per footprint cell of every ADDED object (the add-side
  // counterpart of deleteBlocks' purge; addPlanEntries re-locates the block by marker,
  // so the earlier splices/appends are safe). A delete + same-id re-add in one journal
  // (collab undo of a delete) KEEPS the original plan entries instead — deleteBlocks
  // skips the purge for such survivors, so emitting fresh entries here would duplicate.
  const reAdded = new Set(deletedIds.filter((id) => addedObjects.has(id)));
  const planAddsFinal = reAdded.size ? planAdds.filter((e) => !reAdded.has(e.element)) : planAdds;
  if (planAddsFinal.length) bytes = addPlanEntries(bytes, planAddsFinal);
  // talisman charges: one entry per freshly minted TALISMAN MidItem instance (the
  // reference's addItem cascade; the block is located by marker, so ordering is safe).
  if (mintedTalismans.length) bytes = addTalismanCharges(bytes, mintedTalismans);
  if (addedMountains.length || mountainPatches.size || deletedMountainIndices.size) {
    // rebuild the single MidMountains block: pre-existing entries (re-roll patches applied,
    // deleted entries dropped) followed by this session's additions. Dropping an entry renumbers
    // the survivors' positional ids on reparse — deleteMountainOps pairs the matching doc-side
    // renumber (delete + re-add the tail) so the semantic round-trip stays aligned.
    const base = raw.mountains
      .map((m, i) => (mountainPatches.has(i) ? { ...m, ...mountainPatches.get(i) } : m))
      .filter((_, i) => !deletedMountainIndices.has(i));
    const all = [...base, ...addedMountains];
    const second = raw.mountainsBlockId ? parseInt(raw.mountainsBlockId.slice(6), 16) || 0 : 0;
    const frame = mountainsFrame(raw.version, second, all);
    bytes = raw.mountainsBlockId
      ? replaceBlock(bytes, raw.mountainsBlockId, frame)
      : appendBlocks(bytes, [frame]);
  }

  // Event ops: a MidEvent is a self-contained block, so upsert = replace the frame (existing
  // id) or append a new frame (fresh id), delete = splice the frame out. Resolve ids and
  // collect deletes so they go through the single deleteBlocks pass below.
  if (eventOps.size) {
    const existing = new Set(
      raw.objects.filter((o) => o.typeName === "MidEvent").map((o) => o.id),
    );
    const newFrames: Uint8Array[] = [];
    // a valid on-disk event id for THIS map: <version>EV<hex4> that isn't already taken.
    const evIdRe = new RegExp(`^${raw.version}EV[0-9a-fA-F]{4}$`);
    for (const [id, ev] of eventOps) {
      if (ev === null) {
        if (existing.has(id)) deletedIds.push(id);
        continue; // deleting a never-appended event is a no-op
      }
      if (existing.has(id)) {
        bytes = replaceBlock(bytes, id, eventFrame(raw.version, ev));
        continue;
      }
      // a NEW event: keep the client's id if it is a valid, non-colliding on-disk id (so the
      // model and the export agree); otherwise (a temp "NEW*" id) mint a fresh EV id.
      const finalId = evIdRe.test(id) ? id : `${raw.version}EV${hex4(nextEV++)}`;
      newFrames.push(eventFrame(raw.version, { ...ev, id: finalId }));
    }
    if (newFrames.length) bytes = appendBlocks(bytes, newFrames);
  }

  // Stack templates: upsert = replace an existing frame or append a new one (fresh TM id for a
  // client temp id), delete = splice the frame. Templates are self-contained (units are global
  // Gunit ids), so no dependent-block cascade.
  if (templateOps.size) {
    const existing = new Set(
      raw.objects.filter((o) => o.typeName === "MidStackTemplate").map((o) => o.id),
    );
    const tmIdRe = new RegExp(`^${raw.version}TM[0-9a-fA-F]{4}$`);
    const newFrames: Uint8Array[] = [];
    for (const [id, tmpl] of templateOps) {
      if (tmpl === null) {
        if (existing.has(id)) deletedIds.push(id);
        continue;
      }
      if (existing.has(id)) {
        bytes = replaceBlock(bytes, id, stackTemplateFrame(raw.version, tmpl));
        continue;
      }
      const finalId = tmIdRe.test(id) ? id : `${raw.version}TM${hex4(nextTM++)}`;
      newFrames.push(stackTemplateFrame(raw.version, { ...tmpl, id: finalId }));
    }
    if (newFrames.length) bytes = appendBlocks(bytes, newFrames);
  }

  // Scenario variables: rebuild the singleton MidScenVariables block in place (its count is
  // internal, object count unchanged). If the map lacks the block, append a fresh one.
  if (variablesFinal) {
    const sv = raw.objects.find((o) => o.typeName === "MidScenVariables");
    if (sv) {
      bytes = replaceBlock(bytes, sv.id, scenVariablesFrame(raw.version, sv.id, variablesFinal));
    } else {
      bytes = appendBlocks(bytes, [scenVariablesFrame(raw.version, `${raw.version}SV0000`, variablesFinal)]);
    }
  }

  // Diplomacy: rebuild the singleton MidDiplomacy block in place (append if absent).
  if (diplomacyFinal) {
    const dp = raw.objects.find((o) => o.typeName === "MidDiplomacy");
    if (dp) {
      bytes = replaceBlock(bytes, dp.id, diplomacyFrame(raw.version, dp.id, diplomacyFinal));
    } else {
      bytes = appendBlocks(bytes, [diplomacyFrame(raw.version, `${raw.version}DP0000`, diplomacyFinal)]);
    }
  }

  // M4 mid-stream deletes — LAST, on the final buffer (deleteBlocks re-locates frames by
  // OBJ_ID, so earlier resizes/appends are safe; it also runs the referential guard and
  // decrements the OB0000 count).
  if (deletedIds.length || dependentDeleteIds.length) {
    bytes = deleteBlocks(bytes, deletedIds, dependentDeleteIds);
  }
  return bytes;
}
