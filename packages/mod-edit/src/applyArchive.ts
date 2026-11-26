/**
 * Applying archive ops to the parent's archive, in place and in journal order:
 *
 *   ff.putRecord        replaces the payload of the record of that name, or adds a record
 *                       (id nextId(), above every record, free block and name; the name is
 *                       stored upper case);
 *   ff.deleteRecord     removes a record and its names, unless an index entry uses it;
 *   ff.setAnimation     appends a frame list to -ANIMS.OPT and points the name at it: the
 *                       first index entry of that name (the one the game's lookup finds), or
 *                       a new entry in byte order. Old frame lists stay where they are, so no
 *                       other entry's offset moves;
 *   ff.deleteIndexEntry drops the first index entry of that name (its block stays).
 *
 * `was` turns a parent that changed under the edit into a conflict. Payload bytes come from
 * the caller, checked against their sha256 (the pure part of this package has no hash: the
 * caller passes one). When the result has conflicts the archive is half-applied: discard it.
 */
import {
  ANIMS_OPT,
  decodeIndex,
  encodeAnimationBlock,
  encodeIndex,
  IMAGES_OPT,
  INDEX_OPT,
  insertIndexEntry,
  nameKey,
  PictureTables,
  type FfArchive,
  type IndexEntry,
} from "@d2/ff";
import type { FfOp } from "./editFile.js";
import { emptyResult, type ApplyResult, type Conflict } from "./applyTable.js";

export interface ArchiveIo {
  /** The bytes of a payload file by its sha256, or undefined. */
  payload(sha256: string): Uint8Array | undefined;
  /** sha256 of bytes, lower-case hex. */
  sha256(bytes: Uint8Array): string;
}

const RESERVED = new Set([INDEX_OPT, IMAGES_OPT, ANIMS_OPT]);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * A record name as the store build looks it up (fflib/gameresource.py: upper case, ".PNG"
 * dropped). Index names it looks up in lower case. Where two names of the game are one name
 * there, or a name repeats, the build takes the last entry and the game may take another (the
 * first record name; whatever its binary search hits in the index) — so an edit of such a
 * name is refused rather than shown differently in the editor and the game. The four mods
 * repeat 16 ROAD names in IsoTerrn, and SMNS 1170 names in IsoUnit.
 */
const builderName = (name: string) => name.toUpperCase().replaceAll(".PNG", "");

export function applyArchiveEdits(a: FfArchive, ops: readonly FfOp[], io: ArchiveIo): ApplyResult {
  const res = emptyResult();
  const file = a.name;
  const conflict = (c: Omit<Conflict, "file">) => res.conflicts.push({ file, ...c });
  const indexClash = (entries: readonly IndexEntry[], name: string): boolean => {
    const alike = entries.find((e) => e.name !== name && e.name.toLowerCase() === name.toLowerCase());
    if (alike) {
      conflict({ reason: "name-case", name, detail: `${file} has the index name ${alike.name}, which differs from ${name} only in case` });
      return true;
    }
    if (entries.filter((e) => e.name === name).length > 1) {
      conflict({ reason: "duplicate-name", name, detail: `${file} has more than one index entry ${name}: the store build takes the last, the game's lookup may find another` });
      return true;
    }
    return false;
  };

  for (const op of ops) {
    switch (op.op) {
      case "ff.putRecord": {
        if (RESERVED.has(op.name.toUpperCase())) {
          conflict({ reason: "reserved-record", name: op.name, detail: `${op.name} is the archive's own table` });
          break;
        }
        let bytes: Uint8Array | undefined;
        if ("copyOf" in op.payload) {
          const from = a.idByName(op.payload.copyOf);
          bytes = from === undefined ? undefined : a.get(from);
          if (!bytes) {
            conflict({ reason: "no-record", name: op.payload.copyOf, detail: `${file} has no record ${op.payload.copyOf} to copy` });
            break;
          }
        } else {
          bytes = io.payload(op.payload.sha256);
          if (!bytes) {
            conflict({ reason: "payload-missing", name: op.name, detail: `no payload file ${op.payload.sha256}` });
            break;
          }
          if (bytes.length !== op.payload.size || io.sha256(bytes) !== op.payload.sha256) {
            conflict({ reason: "payload-mismatch", name: op.name, detail: `the payload file ${op.payload.sha256} does not have that hash and size` });
            break;
          }
        }
        const id = a.idByName(op.name);
        const key = nameKey(op.name);
        const live = a.nameTable().filter((n) => a.has(n.id));
        if (live.filter((n) => n.name === key).length > 1) {
          conflict({ reason: "duplicate-name", name: op.name, detail: `${file} names more than one record ${key}: the game takes the first, the store build the last` });
          break;
        }
        const alike = live.find((n) => n.name !== key && builderName(n.name) === builderName(key));
        if (alike) {
          conflict({ reason: "name-case", name: op.name, detail: `${file} has ${alike.name}, which the store build reads as the same name as ${key}` });
          break;
        }
        if (op.was !== undefined) {
          const now = id === undefined ? null : io.sha256(a.get(id)!);
          if (now !== op.was) {
            conflict({ reason: "parent-changed", name: op.name, detail: `${op.name} in ${file} is ${now ?? "absent"}, the edit replaced ${op.was ?? "nothing"}` });
            break;
          }
        }
        if (id !== undefined) {
          a.put(id, bytes);
        } else {
          const stale = a.nameTable().find((n) => n.name === nameKey(op.name));
          if (stale) {
            conflict({ reason: "name-taken", name: op.name, detail: `${op.name} in ${file} names record ${stale.id}, which is gone` });
            break;
          }
          const added = a.nextId();
          a.put(added, bytes);
          a.setName(added, op.name);
        }
        res.counts.set++;
        break;
      }
      case "ff.deleteRecord": {
        if (RESERVED.has(op.name.toUpperCase())) {
          conflict({ reason: "reserved-record", name: op.name, detail: `${op.name} is the archive's own table` });
          break;
        }
        const id = a.idByName(op.name);
        if (id === undefined) {
          res.counts.unchanged++;
          break;
        }
        const tables = PictureTables.of(a);
        const user = tables?.entries.find((e) => e.uid === id);
        if (user) {
          conflict({ reason: "record-in-use", name: op.name, detail: `the index entry ${user.name} uses ${op.name}` });
          break;
        }
        a.delete(id);
        res.counts.deleted++;
        break;
      }
      case "ff.setAnimation": {
        const indexId = a.idByName(INDEX_OPT);
        const animsId = a.idByName(ANIMS_OPT);
        const tables = PictureTables.of(a);
        if (indexId === undefined || animsId === undefined || !tables) {
          conflict({ reason: "no-index", name: op.name, detail: `${file} has no ${INDEX_OPT} with ${ANIMS_OPT}` });
          break;
        }
        const unknown = op.frames.filter((f) => {
          const e = tables.entry(f);
          return !e || e.uid === -1;
        });
        if (unknown.length) {
          conflict({ reason: "unknown-frame", name: op.name, detail: `${file} has no picture ${unknown.slice(0, 3).join(", ")}` });
          break;
        }
        const index = decodeIndex(a.get(indexId)!);
        if (indexClash(index.entries, op.name)) break;
        const current = tables.entry(op.name);
        if (current && current.uid !== -1) {
          conflict({ reason: "name-is-picture", name: op.name, detail: `${op.name} is a picture of ${file}, not an animation` });
          break;
        }
        if (op.was !== undefined) {
          const now = current ? tables.animation(op.name) ?? null : null;
          if (JSON.stringify(now) !== JSON.stringify(op.was)) {
            conflict({ reason: "parent-changed", name: op.name, detail: `${op.name} in ${file} has other frames than the edit replaced` });
            break;
          }
        }
        const anims = a.get(animsId)!;
        const block = encodeAnimationBlock({ frames: op.frames, rest: new Uint8Array(0) });
        const placed: IndexEntry = { uid: -1, name: op.name, offset: anims.length, size: block.length };
        const at = index.entries.findIndex((e) => e.name === op.name);
        const entries = at >= 0 ? index.entries.map((e, i) => (i === at ? placed : e)) : insertIndexEntry(index.entries, placed);
        a.put(animsId, concat(anims, block));
        a.put(indexId, encodeIndex({ entries, rest: index.rest }));
        res.counts.set++;
        break;
      }
      case "ff.deleteIndexEntry": {
        const indexId = a.idByName(INDEX_OPT);
        if (indexId === undefined) {
          conflict({ reason: "no-index", name: op.name, detail: `${file} has no ${INDEX_OPT}` });
          break;
        }
        const index = decodeIndex(a.get(indexId)!);
        if (indexClash(index.entries, op.name)) break;
        const at = index.entries.findIndex((e) => e.name === op.name);
        if (at < 0) {
          res.counts.unchanged++;
          break;
        }
        const gone = index.entries[at]!;
        const last = !index.entries.some((e, i) => i !== at && e.name === op.name);
        if (gone.uid !== -1 && last) {
          // a picture an animation still shows: the game would miss a frame
          const tables = PictureTables.of(a)!;
          const user = tables.entries.find((e) => e.uid === -1 && tables.entry(e.name) === e && tables.animation(e.name)!.includes(op.name));
          if (user) {
            conflict({ reason: "picture-in-use", name: op.name, detail: `the animation ${user.name} of ${file} shows ${op.name}` });
            break;
          }
        }
        a.put(indexId, encodeIndex({ entries: index.entries.filter((_, i) => i !== at), rest: index.rest }));
        res.counts.deleted++;
        break;
      }
    }
  }
  res.changed = a.modified;
  return res;
}
