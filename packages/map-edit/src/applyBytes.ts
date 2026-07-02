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
  mountainsFrame,
  itemFrame,
  unitFrame,
  stackFrame,
  replaceBlock,
  deleteBlocks,
  eventFrame,
  spliceVariableFields,
  type SgRaw,
  type MountainEntry,
  type StringFieldEdit,
  type ItemListEdit,
  type QtyListEdit,
} from "@d2/sg-parser";
import type { MapObject, MapEvent } from "@d2/map-schema";
import type { EditOp } from "./ops.js";

export function applyEditsToBytes(raw: SgRaw, ops: readonly EditOp[]): Uint8Array {
  const w = new SgWriter(raw);

  let nextRA = 0;
  let nextMM = 0;
  let nextIM = 0;
  let nextUN = 0;
  let nextKC = 0;
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
    } else if (o.typeName === "MidItem") {
      const m = /IM([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextIM = Math.max(nextIM, parseInt(m[1]!, 16) + 1);
    } else if (o.typeName === "MidUnit") {
      const m = /UN([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextUN = Math.max(nextUN, parseInt(m[1]!, 16) + 1);
    }
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
  /** Event ops, resolved to the FINAL state per event id (last write wins): a MapEvent to
   *  upsert, or null to delete. Applied at the very end as append/replace/delete of a frame. */
  const eventOps = new Map<string, MapEvent | null>();
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
        // v1 scope: MidLandmark only (decor — the eraser's use case; its inverse addObject
        // is fully reconstructible via landmarkFrame, so collab undo round-trips). Other
        // types stay fail-loud: stacks need dependent MidUnit/MidItem cascade + a garrison
        // re-add path for undo; mountains live N-per-block (deleting renumbers ids).
        const rec = raw.objectById.get(op.id);
        if (!rec) {
          // a delete of a CLIENT-added object should have been folded out (foldOps)
          throw new Error(`applyEditsToBytes: deleteObject of unknown object ${op.id}`);
        }
        if (rec.typeName !== "MidLandmark") {
          throw new Error(
            `applyEditsToBytes: deleteObject for ${rec.typeName} not supported yet (only MidLandmark)`,
          );
        }
        deletedIds.push(op.id);
        break;
      }

      case "upsertEvent":
        eventOps.set(op.event.id, op.event);
        break;
      case "deleteEvent":
        eventOps.set(op.id, null);
        break;
    }
  }

  // Resolve each edited chest's FINAL item list (last write won): the list holds global
  // GItem template ids, so instantiate a fresh MidItem block per entry and point the bag's
  // ITEM_ID list at the new instances. The chest's original instances are left in place
  // (orphaned) — harmless (each still references a valid template); GC of unreferenced
  // MidItems is a later refinement. Object count bumps by the number of new MidItems.
  for (const [objId, templates] of chestItemOps) {
    const o = raw.objectById.get(objId);
    if (!o) throw new Error(`applyEditsToBytes: chest items edit for unknown object ${objId}`);
    const instanceIds = templates.map((template) => {
      const second = nextIM++;
      appends.push(itemFrame(raw.version, second, template));
      return `${raw.version}IM${hex4(second)}`;
    });
    listEdits.push({ fieldsFrom: o.fieldsFrom, fieldsEnd: o.fieldsEnd, objId, instanceIds });
  }

  // Stack inventory: same MidItem-instance re-creation as a chest, but the list is mid-block so it
  // gets the dedicated stackItemListSplice (precise count-tag locator + span-walk) on export.
  const stackListEdits: ItemListEdit[] = [];
  for (const [objId, templates] of stackItemOps) {
    const o = raw.objectById.get(objId);
    if (!o) throw new Error(`applyEditsToBytes: stack inventory edit for unknown object ${objId}`);
    const instanceIds = templates.map((template) => {
      const second = nextIM++;
      appends.push(itemFrame(raw.version, second, template));
      return `${raw.version}IM${hex4(second)}`;
    });
    stackListEdits.push({ fieldsFrom: o.fieldsFrom, fieldsEnd: o.fieldsEnd, objId, instanceIds });
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

  // Emit added objects at their FINAL position (place + later moves coalesced).
  for (const o of addedObjects.values()) {
    if (o.type === "landmark") {
      const m = /MM([0-9a-fA-F]{4})$/.exec(o.id);
      const second = m ? parseInt(m[1]!, 16) : nextMM++;
      appends.push(landmarkFrame(raw.version, second, o.pos.x, o.pos.y, o.baseType ?? "G000000000"));
    } else if (o.type === "mountains") {
      addedMountains.push({
        x: o.pos.x, y: o.pos.y, w: o.w ?? 1, h: o.h ?? 1,
        image: o.image ?? 0, race: o.race ?? 0,
      });
    } else if (o.type === "stack") {
      // A visiting hero stack added to a city (empty formation; INSIDE → the city). The
      // city.STACK link is a separate patchObject (stackRef → STACK). Subsequent unit/equip/
      // inventory edits target this id via the normal ops.
      const m = /KC([0-9a-fA-F]{4})$/.exec(o.id);
      const second = m ? parseInt(m[1]!, 16) : nextKC++;
      appends.push(stackFrame(raw.version, second, {
        owner: o.owner ?? "G000000000",
        inside: o.inside ?? "G000000000",
        posX: o.pos.x,
        posY: o.pos.y,
      }));
    } else {
      throw new Error(`applyEditsToBytes: addObject type '${o.type}' not supported yet (M4)`);
    }
  }

  let bytes = w.toBytes();
  // M4: resize variable-length string fields + ITEM_ID lists in place (object count
  // unchanged by the splice itself; new MidItem blocks are appended below). Done before the
  // append/replace passes; those re-scan markers + the header count (all preserved). Both
  // splice kinds share one highest-offset-first pass so cross-object offsets stay valid.
  if (stringEdits.length || listEdits.length || qtyListEdits.length || stackListEdits.length) {
    bytes = spliceVariableFields(bytes, stringEdits, listEdits, qtyListEdits, stackListEdits);
  }
  const frames = appends.filter((f): f is Uint8Array => f !== null);
  if (frames.length) bytes = appendBlocks(bytes, frames);
  if (addedMountains.length || mountainPatches.size) {
    const base = raw.mountains.map((m, i) =>
      mountainPatches.has(i) ? { ...m, ...mountainPatches.get(i) } : m,
    );
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
    for (const [id, ev] of eventOps) {
      if (ev === null) {
        if (existing.has(id)) deletedIds.push(id);
        continue; // deleting a never-appended event is a no-op
      }
      // an event id the client minted (e.g. "NEW*") gets a real EV id at export time
      const finalId = existing.has(id) ? id : `${raw.version}EV${hex4(nextEV++)}`;
      const frame = eventFrame(raw.version, { ...ev, id: finalId });
      if (existing.has(id)) bytes = replaceBlock(bytes, id, frame);
      else newFrames.push(frame);
    }
    if (newFrames.length) bytes = appendBlocks(bytes, newFrames);
  }

  // M4 mid-stream deletes — LAST, on the final buffer (deleteBlocks re-locates frames by
  // OBJ_ID, so earlier resizes/appends are safe; it also runs the referential guard and
  // decrements the OB0000 count).
  if (deletedIds.length) {
    bytes = deleteBlocks(bytes, deletedIds);
  }
  return bytes;
}
