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
  replaceBlock,
  type SgRaw,
  type MountainEntry,
} from "@d2/sg-parser";
import type { MapObject } from "@d2/map-schema";
import type { EditOp } from "./ops.js";

export function applyEditsToBytes(raw: SgRaw, ops: readonly EditOp[]): Uint8Array {
  const w = new SgWriter(raw);

  let nextRA = 0;
  let nextMM = 0;
  for (const o of raw.objects) {
    if (o.typeName === "MidRoad") {
      const m = /RA([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextRA = Math.max(nextRA, parseInt(m[1]!, 16) + 1);
    } else if (o.typeName === "MidLandmark") {
      const m = /MM([0-9a-fA-F]{4})$/.exec(o.id);
      if (m) nextMM = Math.max(nextMM, parseInt(m[1]!, 16) + 1);
    }
  }
  const appends: (Uint8Array | null)[] = []; // null = a removed/superseded pending block
  const pendingRoad = new Map<string, { idx: number; ra: number }>();
  const addedMountains: MountainEntry[] = [];
  /** Re-roll patches for PRE-EXISTING mountains: raw.mountains index -> changed fields. */
  const mountainPatches = new Map<number, Partial<MountainEntry>>();
  /** Objects added this session, keyed by id, holding their FINAL pos (moves folded in).
   *  Emitted after the op loop so place-then-move of the same object exports correctly
   *  (a moveObject can't setObjectPos a block that's only appended at the end). */
  const addedObjects = new Map<string, MapObject>();

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
          // chest/ruin/city numeric property edits — fixed-width int32 splices in place.
          // field name -> .sg tag (the inspector only exposes fields the object actually has).
          const INT_TAG: Record<string, string> = {
            image: "IMAGE", tier: "SIZE", priority: "AIPRIORITY",
            morale: "MORALE", regen: "REGEN_B", growth: "GROWTH_T",
          };
          const handled = new Set<string>();
          for (const [key, tag] of Object.entries(INT_TAG)) {
            if (typeof f[key] === "number") {
              w.setObjectInt(op.id, tag, f[key] as number);
              handled.add(key);
            }
          }
          const left = Object.keys(f).filter((k) => !handled.has(k));
          if (left.length) {
            // variable-length fields (name/desc/reward/item/owner/looter/items) need the
            // growable mid-stream splice (M4) — not yet wired. Fail loud rather than corrupt.
            throw new Error(
              `applyEditsToBytes: patchObject ${op.id} fields [${left}] not byte-writable yet (M4)`,
            );
          }
        }
        break;
      }
      case "deleteObject":
        throw new Error("applyEditsToBytes: deleteObject requires a mid-stream splice (M4)");
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
    } else {
      throw new Error(`applyEditsToBytes: addObject type '${o.type}' not supported yet (M4)`);
    }
  }

  let bytes = w.toBytes();
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
  return bytes;
}
