/** Archive ops on an archive with a picture index. */
import { describe, it, expect } from "vitest";
import { ANIMS_OPT, decodeIndex, encodeIndex, FfArchive, INDEX_OPT, PictureTables } from "@d2/ff";
import { applyArchiveEdits, type FfOp } from "../src/index";
import { io, pictureArchive, sha256 } from "./helpers";

const A = "IsoUnit.ff";
const reread = (a: FfArchive) => FfArchive.read(a.toBytes(), a.name);
const reasons = (ops: FfOp[], payloads: Uint8Array[] = []) => applyArchiveEdits(pictureArchive(), ops, io(payloads)).conflicts.map((c) => c.reason);

describe("archive ops", () => {
  it("add a record by name, upper case, above every id", () => {
    const a = pictureArchive();
    const payload = new Uint8Array([1, 2, 3, 4]);
    const before = Math.max(...a.ids());
    const res = applyArchiveEdits(a, [{ op: "ff.putRecord", archive: A, name: "new.bin", payload: { sha256: sha256(payload), size: 4 }, was: null }], io([payload]));
    expect(res.conflicts).toEqual([]);
    const b = reread(a);
    const id = b.idByName("NEW.BIN")!;
    expect(id).toBeGreaterThan(before);
    expect(b.nameOf(id)).toBe("NEW.BIN");
    expect(b.get(id)).toEqual(payload);
  });

  it("replace a record's bytes, from a payload or from another record", () => {
    const a = pictureArchive();
    const old = a.get(a.idByName("LOOSE.BIN")!)!;
    const res = applyArchiveEdits(a, [{ op: "ff.putRecord", archive: A, name: "loose.bin", payload: { copyOf: "SPRITE0" }, was: sha256(old) }], io());
    expect(res.counts.set).toBe(1);
    const b = reread(a);
    expect(b.get(b.idByName("LOOSE.BIN")!)).toEqual(b.get(b.idByName("SPRITE0")!));
    expect(b.ids()).toEqual(pictureArchive().ids());
  });

  it("refuse what does not fit", () => {
    const p = new Uint8Array([7]);
    expect(reasons([{ op: "ff.putRecord", archive: A, name: "X", payload: { sha256: sha256(p), size: 1 } }])).toEqual(["payload-missing"]);
    expect(reasons([{ op: "ff.putRecord", archive: A, name: "X", payload: { sha256: sha256(p), size: 2 } }], [p])).toEqual(["payload-mismatch"]);
    expect(reasons([{ op: "ff.putRecord", archive: A, name: "X", payload: { copyOf: "NOPE" } }])).toEqual(["no-record"]);
    expect(reasons([{ op: "ff.putRecord", archive: A, name: "LOOSE.BIN", payload: { copyOf: "SPRITE0" }, was: null }])).toEqual(["parent-changed"]);
    expect(reasons([{ op: "ff.putRecord", archive: A, name: "-index.opt", payload: { copyOf: "SPRITE0" } }])).toEqual(["reserved-record"]);
    expect(reasons([{ op: "ff.deleteRecord", archive: A, name: INDEX_OPT }])).toEqual(["reserved-record"]);
    expect(reasons([{ op: "ff.deleteRecord", archive: A, name: "SPRITE0" }])).toEqual(["record-in-use"]);
  });

  it("delete a record nobody uses, and its name", () => {
    const a = pictureArchive();
    const res = applyArchiveEdits(a, [{ op: "ff.deleteRecord", archive: A, name: "LOOSE.BIN" }, { op: "ff.deleteRecord", archive: A, name: "LOOSE.BIN" }], io());
    expect(res.counts).toEqual({ deleted: 1, set: 0, added: 0, unchanged: 1 });
    expect(reread(a).idByName("LOOSE.BIN")).toBeUndefined();
  });

  it("point a new animation at frames, in byte order, moving no other entry", () => {
    const a = pictureArchive();
    const before = decodeIndex(a.get(a.idByName(INDEX_OPT)!)!).entries;
    const res = applyArchiveEdits(a, [{ op: "ff.setAnimation", archive: A, name: "A_ATTACK", frames: ["A_FRAME1", "A_FRAME0", "A_FRAME1"], was: null }], io());
    expect(res.conflicts).toEqual([]);
    const b = reread(a);
    const t = PictureTables.of(b)!;
    expect(t.sorted).toBe(true);
    expect(t.entries.map((e) => e.name)).toEqual(["A_ATTACK", "A_FRAME0", "A_FRAME1", "A_MOVE"]);
    expect(t.animation("A_ATTACK")).toEqual(["A_FRAME1", "A_FRAME0", "A_FRAME1"]);
    expect(t.animation("A_MOVE")).toEqual(["A_FRAME0", "A_FRAME1"]);
    expect(t.entries.slice(1)).toEqual(before);
  });

  it("repoint an animation, checking the frames it had", () => {
    const a = pictureArchive();
    const anims = a.get(a.idByName(ANIMS_OPT)!)!.length;
    expect(applyArchiveEdits(a, [{ op: "ff.setAnimation", archive: A, name: "A_MOVE", frames: ["A_FRAME1"], was: ["A_FRAME0", "A_FRAME1"] }], io()).conflicts).toEqual([]);
    const t = PictureTables.of(reread(a))!;
    expect(t.animation("A_MOVE")).toEqual(["A_FRAME1"]);
    expect(t.entry("A_MOVE")!.offset).toBe(anims); // appended; the old list stays
    expect(t.entries).toHaveLength(3);
    expect(reasons([{ op: "ff.setAnimation", archive: A, name: "A_MOVE", frames: ["A_FRAME1"], was: ["A_FRAME1"] }])).toEqual(["parent-changed"]);
    expect(reasons([{ op: "ff.setAnimation", archive: A, name: "A_MOVE", frames: ["A_FRAME9"] }])).toEqual(["unknown-frame"]);
    expect(reasons([{ op: "ff.setAnimation", archive: A, name: "A_MOVE", frames: ["A_MOVE"] }])).toEqual(["unknown-frame"]);
    expect(reasons([{ op: "ff.setAnimation", archive: A, name: "A_FRAME0", frames: ["A_FRAME1"] }])).toEqual(["name-is-picture"]);
  });

  it("drop an index entry", () => {
    const a = pictureArchive();
    const res = applyArchiveEdits(a, [{ op: "ff.deleteIndexEntry", archive: A, name: "A_MOVE" }, { op: "ff.deleteIndexEntry", archive: A, name: "A_MOVE" }], io());
    expect(res.counts).toEqual({ deleted: 1, set: 0, added: 0, unchanged: 1 });
    expect(PictureTables.of(reread(a))!.entries.map((e) => e.name)).toEqual(["A_FRAME0", "A_FRAME1"]);
  });

  it("keep a picture an animation shows, and refuse names that differ only in case or repeat", () => {
    expect(reasons([{ op: "ff.deleteIndexEntry", archive: A, name: "A_FRAME0" }])).toEqual(["picture-in-use"]);
    expect(reasons([{ op: "ff.setAnimation", archive: A, name: "a_move", frames: ["A_FRAME0"] }])).toEqual(["name-case"]);
    expect(reasons([{ op: "ff.deleteIndexEntry", archive: A, name: "a_frame1" }])).toEqual(["name-case"]);
    const a = pictureArchive();
    const indexId = a.idByName(INDEX_OPT)!;
    const { entries } = decodeIndex(a.get(indexId)!);
    a.put(indexId, encodeIndex({ entries: [...entries, { ...entries[2]! }] }));
    const twice = applyArchiveEdits(a, [{ op: "ff.setAnimation", archive: A, name: "A_MOVE", frames: ["A_FRAME0"] }], io());
    expect(twice.conflicts.map((c) => c.reason)).toEqual(["duplicate-name"]);
    expect(reasons([{ op: "ff.putRecord", archive: A, name: "SPRITE0.PNG", payload: { copyOf: "LOOSE.BIN" } }])).toEqual(["name-case"]);
  });

  it("leave an archive with no ops as it was", () => {
    const a = pictureArchive();
    const bytes = a.toBytes();
    const res = applyArchiveEdits(a, [{ op: "ff.deleteRecord", archive: A, name: "NOPE" }], io());
    expect(res.changed).toBe(false);
    expect(a.toBytes()).toEqual(bytes);
  });
});
