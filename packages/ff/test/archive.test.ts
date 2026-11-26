/**
 * The archive codec on archives built here, so the rules hold without a game install.
 */
import { describe, it, expect } from "vitest";
import {
  FfArchive,
  FfError,
  NAMES_ID,
  decodeAnimationBlock,
  decodeImageBlock,
  decodeIndex,
  directorySize,
  encodeAnimationBlock,
  encodeImageBlock,
  encodeIndex,
  insertIndexEntry,
  isIndexSorted,
  PictureTables,
  type IndexEntry,
} from "../src/index";

const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const text = (b: Uint8Array | undefined) => new TextDecoder("latin1").decode(b);
const int32At = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getInt32(at, true);

function sample(): FfArchive {
  const a = FfArchive.create("Sample.ff");
  a.put(275, bytesOf("first payload"));
  a.setName(275, "FIRST.PNG");
  a.put(292, bytesOf("second"));
  a.setName(292, "SECOND.PNG");
  return a;
}

/** The directory of an archive image: its live and free entries {id, used, size, offset}. */
function directoryOf(bytes: Uint8Array) {
  const at = int32At(bytes, 24);
  const entries = (from: number, n: number) => Array.from({ length: n }, (_, k) => [0, 4, 8, 12].map((d) => int32At(bytes, from + 4 + k * 16 + d)));
  const live = int32At(bytes, at);
  const free = int32At(bytes, at + 4 + live * 16);
  return { at, size: int32At(bytes, at - 28 + 16), live: entries(at, live), free: entries(at + 4 + live * 16, free) };
}

/** Where a record's 'MQRC' header is, found through the directory. */
function headerOf(bytes: Uint8Array, id: number): number {
  const d = directoryOf(bytes);
  return [...d.live, ...d.free].find((e) => e[0] === id)![3]!;
}

/** `bytes` with record `id` moved from the live list to the free list and flagged 0. */
function withFreeBlock(bytes: Uint8Array, id: number): Uint8Array {
  const out = bytes.slice();
  const v = new DataView(out.buffer);
  const d = directoryOf(out);
  const entry = d.live.find((e) => e[0] === id)!;
  const live = d.live.filter((e) => e !== entry);
  const free = [...d.free, entry];
  let pos = d.at;
  for (const list of [live, free]) {
    v.setInt32(pos, list.length, true);
    pos += 4;
    for (const e of list) for (const x of e) (v.setInt32(pos, x, true), (pos += 4));
  }
  v.setInt32(entry[3]! + 20, 0, true);
  return out;
}

describe("a new archive", () => {
  it("has the game's layout and reads back", () => {
    const bytes = sample().toBytes();
    expect(text(bytes.subarray(0, 4))).toBe("MQDB");
    expect([1, 2, 3, 4, 5].map((k) => int32At(bytes, 4 * k))).toEqual([0, 9, 0, 0, 0]);
    const d = directoryOf(bytes);
    expect(d.size).toBe(1024);
    expect(d.live.map((e) => e[0])).toEqual([0, 1, 2, 275, 292]);
    expect(d.free).toEqual([]);
    const a = FfArchive.read(bytes, "Sample.ff");
    expect(a.ids()).toEqual([1, 2, 275, 292]);
    expect(text(a.get(275))).toBe("first payload");
    expect(a.nameOf(292)).toBe("SECOND.PNG");
    expect(a.idByName("second.png")).toBe(292);
    expect(a.modified).toBe(false);
    expect(a.toBytes()).toEqual(bytes);
  });
});

describe("edits", () => {
  it("replacing a payload with one of the same length changes only that payload", () => {
    const bytes = sample().toBytes();
    const a = FfArchive.read(bytes);
    a.put(275, bytesOf("FIRST PAYLOAD"));
    const out = a.toBytes();
    expect(out.length).toBe(bytes.length);
    expect(text(FfArchive.read(out).get(275))).toBe("FIRST PAYLOAD");
    const at = headerOf(out, 275) + 28;
    const diff = [...out.keys()].filter((i) => out[i] !== bytes[i]);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((i) => i >= at && i < at + 13)).toBe(true);
  });

  it("a longer payload moves the records after it, and the directory follows", () => {
    const a = FfArchive.read(sample().toBytes());
    a.put(275, new Uint8Array(5000).fill(7));
    const again = FfArchive.read(a.toBytes());
    expect(again.get(275)!.length).toBe(5000);
    expect(text(again.get(292))).toBe("second");
  });

  it("the directory takes the game's size, with the free count after the live entries", () => {
    const a = FfArchive.create();
    for (let id = 10; id < 10 + 70; id++) a.put(id, Uint8Array.of(id));
    const bytes = a.toBytes();
    const d = directoryOf(bytes);
    expect(d.size).toBe(directorySize(73));
    expect(d.size).toBe(2048);
    expect(d.live.length).toBe(73);
    expect(d.free).toEqual([]);
    const again = FfArchive.read(bytes);
    expect(again.ids().length).toBe(72);
    expect(again.toBytes()).toEqual(bytes);
  });

  it("deleting a record drops its names; new ids skip names that outlived their records", () => {
    const a = FfArchive.read(sample().toBytes());
    a.delete(292);
    expect(a.has(292)).toBe(false);
    expect(a.nameOf(292)).toBeUndefined();
    a.setName(900, "ORPHAN.PNG"); // a name whose record is gone, as the game's archives have
    expect(a.nextId()).toBe(901);
    const again = FfArchive.read(a.toBytes());
    expect(again.ids()).toEqual([1, 2, 275]);
    expect(again.idByName("orphan.png")).toBeUndefined();
    expect(again.nameTable().map((n) => n.name)).toEqual(["FIRST.PNG", "ORPHAN.PNG"]);
  });

  it("a payload is copied, a Node Buffer included", () => {
    const a = sample();
    const buf = Buffer.from([1, 2, 3]);
    a.put(10, buf);
    buf.set([4, 5, 6]);
    expect([...FfArchive.read(a.toBytes()).get(10)!]).toEqual([1, 2, 3]);
  });

  it("a failed delete changes nothing", () => {
    const bytes = sample().toBytes();
    new DataView(bytes.buffer).setInt32(headerOf(bytes, NAMES_ID) + 28, 99, true); // a name table that lies
    const a = FfArchive.read(bytes);
    expect(() => a.delete(275)).toThrow(/name table/);
    expect(a.has(275)).toBe(true);
    expect(a.modified).toBe(false);
    expect(a.toBytes()).toEqual(bytes);
  });

  it("refuses what it cannot do", () => {
    const a = sample();
    expect(() => a.put(0, new Uint8Array(1))).toThrow(FfError);
    expect(() => a.put(2 ** 31, new Uint8Array(1))).toThrow(FfError);
    expect(() => a.delete(NAMES_ID)).toThrow(/cannot be deleted/);
    expect(() => a.delete(12345)).toThrow(/cannot be deleted/);
    expect(() => a.setName(275, "Ж")).toThrow(/Latin-1/);
    expect(() => a.setName(275, "x".repeat(256))).toThrow(/Latin-1/);
    expect(() => a.setName(275, "second.png")).toThrow(/already names record 292/);
  });
});

describe("names", () => {
  it("are stored upper case and found the way the game finds them", () => {
    const a = sample();
    a.put(300, bytesOf("third"));
    a.setName(300, "third.png");
    expect(a.nameOf(300)).toBe("THIRD.PNG");
    expect(a.idByName("Third.PNG")).toBe(300);
    a.setName(275, "First.png"); // the same name in other case: nothing to change
    expect(a.nameTable().map((n) => n.name)).toEqual(["FIRST.PNG", "SECOND.PNG", "THIRD.PNG"]);
  });

  it("of two equal names the first counts, even when its record is gone", () => {
    const a = FfArchive.create();
    a.put(5, bytesOf("five"));
    const table = new Uint8Array(4 + 2 * 260);
    const v = new DataView(table.buffer);
    v.setInt32(0, 2, true);
    table.set(bytesOf("SAME.PNG"), 4);
    v.setInt32(4 + 256, 99, true); // dangling
    table.set(bytesOf("SAME.PNG"), 4 + 260);
    v.setInt32(4 + 260 + 256, 5, true);
    a.put(NAMES_ID, table);
    expect(a.idByName("SAME.PNG")).toBeUndefined();
    expect(a.nextId()).toBe(100);
  });
});

describe("free blocks", () => {
  it("are kept, listed after the live records, and never served", () => {
    const bytes = withFreeBlock(sample().toBytes(), 292);
    const a = FfArchive.read(bytes);
    expect(a.has(292)).toBe(false);
    expect(a.ids()).toEqual([1, 2, 275]);
    expect(a.records().filter((r) => !r.live).map((r) => [r.id, r.flag])).toEqual([[292, 0]]);
    expect(a.toBytes()).toEqual(bytes);
    expect(a.nextId()).toBe(293);
    expect(() => a.put(292, bytesOf("x"))).toThrow(/free block/);
  });

  it("survive an edit that changes the live list", () => {
    const a = FfArchive.read(withFreeBlock(sample().toBytes(), 292));
    a.put(a.nextId(), bytesOf("added"));
    const out = a.toBytes();
    const d = directoryOf(out);
    expect(d.live.map((e) => e[0])).toEqual([0, 1, 2, 275, 293]);
    expect(d.free.map((e) => [e[0], e[1], e[2]])).toEqual([[292, 6, 6]]);
    const again = FfArchive.read(out);
    expect(again.records().filter((r) => !r.live).map((r) => r.id)).toEqual([292]);
  });
});

describe("a block with unused bytes", () => {
  it("keeps them, and a new payload gets a block of its own length", () => {
    // shrink record 292 to 3 used bytes of its 6-byte block, as the game leaves a shrunk record
    const bytes = sample().toBytes();
    const v = new DataView(bytes.buffer);
    const at = headerOf(bytes, 292);
    v.setInt32(at + 12, 3, true);
    const d = directoryOf(bytes);
    const k = d.live.findIndex((e) => e[0] === 292);
    v.setInt32(d.at + 4 + k * 16 + 4, 3, true);
    const a = FfArchive.read(bytes);
    expect(text(a.get(292))).toBe("sec");
    expect(a.records().find((r) => r.id === 292)).toMatchObject({ size: 3, allocated: 6 });
    expect(a.toBytes()).toEqual(bytes);
    a.put(292, bytesOf("x"));
    const again = FfArchive.read(a.toBytes());
    expect(again.records().find((r) => r.id === 292)).toMatchObject({ size: 1, allocated: 1 });
    expect(text(again.get(275))).toBe("first payload");
  });
});

describe("damaged archives", () => {
  it("are refused with the reason", () => {
    const bytes = sample().toBytes();
    expect(() => FfArchive.read(bytesOf("MQDX" + "\0".repeat(30)))).toThrow(/not an MQDB/);
    expect(() => FfArchive.read(bytes.subarray(0, bytes.length - 3))).toThrow(/runs past the end|no record/);
    const moved = bytes.slice();
    new DataView(moved.buffer).setInt32(24, 28 + 28, true);
    expect(() => FfArchive.read(moved)).toThrow(/does not point at the directory/);
    const lying = bytes.slice();
    const dirAt = int32At(lying, 24);
    new DataView(lying.buffer).setInt32(dirAt + 4 + 3 * 16 + 4, 99, true);
    expect(() => FfArchive.read(lying)).toThrow(/does not match/);
    const overfull = bytes.slice();
    new DataView(overfull.buffer).setInt32(headerOf(overfull, 275) + 12, 9999, true);
    expect(() => FfArchive.read(overfull)).toThrow(/uses 9999 bytes of a 13-byte block/);
    const unlisted = bytes.slice();
    const d = directoryOf(unlisted);
    new DataView(unlisted.buffer).setInt32(d.at, d.live.length - 1, true); // drops the last entry (292)
    new DataView(unlisted.buffer).setInt32(d.at + 4 + (d.live.length - 1) * 16, 0, true); // the free count after it
    expect(() => FfArchive.read(unlisted)).toThrow(/record 292 .* is not in the directory/);
  });
});

describe("picture tables", () => {
  const block = {
    transparentIndex: 0,
    opacity: 300,
    spriteWidth: 64,
    spriteHeight: 32,
    palette: Uint8Array.from({ length: 1024 }, (_, i) => i & 0xff),
    pictures: [
      { name: "G000UU0001HHITA1A00", width: 10, height: 12, parts: [{ frameX: 0, frameY: 0, spriteX: 1, spriteY: 2, width: 8, height: 9 }] },
      { name: "G000UU0001HHITA1A01", width: 10, height: 12, parts: [] },
    ],
    rest: new Uint8Array(0),
  };

  it("encode back to the bytes they were read from", () => {
    const b = encodeImageBlock(block);
    expect([...b.subarray(0, 11)]).toEqual([0, 0x2c, 0x01, 64, 0, 0, 0, 32, 0, 0, 0]);
    expect(decodeImageBlock(b)).toEqual(block);
    expect(encodeImageBlock(decodeImageBlock(b))).toEqual(b);
    expect(() => encodeImageBlock({ ...block, opacity: 70000 })).toThrow(FfError);
    const anim = { frames: ["G000UU0001HHITA1A00", "G000UU0001HHITA1A01"], rest: Uint8Array.of(9) };
    expect(encodeAnimationBlock(decodeAnimationBlock(encodeAnimationBlock(anim)))).toEqual(encodeAnimationBlock(anim));
    const index = { entries: [{ uid: 275, name: "G000UU0001HHITA1A00", offset: 0, size: b.length }, { uid: -1, name: "G000UU0001HHITA1A", offset: 0, size: 47 }], rest: new Uint8Array(0) };
    expect(decodeIndex(encodeIndex(index))).toEqual(index);
  });

  it("keep the index in byte order", () => {
    const e = (name: string, uid = 1): IndexEntry => ({ uid, name, offset: 0, size: 0 });
    const sorted = [e("A"), e("B", 1), e("B", 2), e("a")]; // upper case sorts before lower case
    expect(isIndexSorted(sorted)).toBe(true);
    expect(isIndexSorted([e("a"), e("B")])).toBe(false);
    expect(insertIndexEntry(sorted, e("AB")).map((x) => x.name)).toEqual(["A", "AB", "B", "B", "a"]);
    expect(insertIndexEntry(sorted, e("B", 3)).map((x) => x.uid)).toEqual([1, 1, 2, 3, 1]);
    expect(insertIndexEntry(sorted, e("B", 3), { first: true }).map((x) => x.uid)).toEqual([1, 3, 1, 2, 1]);
    expect(() => insertIndexEntry([e("b"), e("a")], e("c"))).toThrow(/byte order/);
  });

  it("find a picture and an animation by name, case and all", () => {
    const images = encodeImageBlock(block);
    const anims = encodeAnimationBlock({ frames: ["G000UU0001HHITA1A00", "G000UU0001HHITA1A01"], rest: new Uint8Array(0) });
    const a = FfArchive.create("IsoUnit.ff");
    a.put(275, bytesOf("png"));
    let entries: IndexEntry[] = [];
    for (const entry of [
      { uid: 275, name: "G000UU0001HHITA1A00", offset: 0, size: images.length },
      { uid: 275, name: "G000UU0001HHITA1A01", offset: 0, size: images.length },
      { uid: -1, name: "G000UU0001HHITA1A", offset: 0, size: anims.length },
    ]) entries = insertIndexEntry(entries, entry);
    for (const [id, name, payload] of [
      [3, "-INDEX.OPT", encodeIndex({ entries })],
      [4, "-IMAGES.OPT", images],
      [5, "-ANIMS.OPT", anims],
    ] as const) {
      a.put(id, payload);
      a.setName(id, name);
    }
    const t = PictureTables.of(FfArchive.read(a.toBytes()))!;
    expect(t.sorted).toBe(true);
    expect(t.picture("G000UU0001HHITA1A01")).toEqual({ source: 275, desc: block.pictures[1] });
    expect(t.picture("g000uu0001hhita1a01")).toBeUndefined(); // the game's lookup is case-sensitive
    expect(t.animation("G000UU0001HHITA1A")).toEqual(["G000UU0001HHITA1A00", "G000UU0001HHITA1A01"]);
    expect(t.picture("G000UU0001HHITA1A")).toBeUndefined();
    expect(PictureTables.of(sample())).toBeNull();
  });
});
