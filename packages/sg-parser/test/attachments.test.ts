/**
 * ATTACHMENTS: frames some tool appended after the scenario's objects, without an OBJ_ID.
 *
 * The case that exists in the wild is the map picture a mod's random-scenario generator
 * writes at the end of the file: `WHAT … .?AVCMapImage\0 BEGOBJECT\0 BASE64 <png> ENDOBJECT\0`.
 * The header's OB0000 count does NOT include it, so the game reads its objects and stops.
 * A writer that counts it makes the game read the picture as an object and refuse the map
 * («'OBJ_ID' StreamFile: Invalid field id» — found with the native editor of SMNS 3.0).
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  ByteBuffer,
  appendBlocks,
  createBlankMap,
  iterateObjects,
  objectStreamEnd,
  parseScenario,
  rebuildBytes,
  rebuildScenario,
  roadFrame,
  serializeMapFromModelBytes,
  splitScenario,
  verifyBlockIntegrity,
} from "../src/index";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const int32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const concat = (...parts: (Uint8Array | number[])[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** The generator's frame, byte for byte in its framing (the picture itself is a stand-in). */
function mapImageFrame(): Uint8Array {
  const decl = ".?AVCMapImage\0";
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAJAAAACQ" + "A".repeat(200) + "JRU5ErkJggg==\0";
  return concat(
    ascii("WHAT"), int32(decl.length), ascii(decl),
    ascii("BEGOBJECT\0"),
    ascii("BASE64"), int32(base64.length), ascii(base64),
    ascii("ENDOBJECT\0"),
  );
}

const declared = (bytes: Uint8Array): number => {
  const buf = new ByteBuffer(bytes);
  const ob = buf.lastIndexOf("OB0000", buf.indexOf("WHAT"));
  return buf.readInt32LE(ob + 6);
};

const plain = createBlankMap({ size: 48, name: "Attachment test" });
const image = mapImageFrame();
/** A map as the generator leaves it: the objects, then the picture — the count untouched. */
const withImage = concat(plain, image);
const objects = declared(plain);

describe("a frame without an OBJ_ID", () => {
  it("gets no id of its own — it does not borrow its neighbour's", () => {
    const frames = [...iterateObjects(new ByteBuffer(withImage))];
    expect(frames).toHaveLength(objects + 1);
    const last = frames.at(-1)!;
    expect(last.id).toBe("");
    expect(last.typeName).toBe("MapImage"); // the decl has no "@@": the name runs to its NUL
    expect(frames.at(-2)!.id).not.toBe("");
    expect(frames.slice(0, -1).every((f) => f.id !== "")).toBe(true);
  });

  it("is not a map object", () => {
    const doc = parseScenario(withImage);
    expect(doc.objects).toEqual(parseScenario(plain).objects);
  });
});

describe("a map with an attachment after its objects", () => {
  it("splits into the counted objects and a trailer that holds the attachment", () => {
    const s = splitScenario(withImage);
    expect(s.blocks).toHaveLength(objects);
    expect(s.blocks.every((b) => b.id !== "")).toBe(true);
    expect(s.trailer).toEqual(image);
    expect(objectStreamEnd(withImage)).toBe(plain.length);
    expect(objectStreamEnd(plain)).toBe(plain.length);
  });

  it("is rebuilt byte for byte: the count stays what the game expects", () => {
    expect(rebuildScenario(splitScenario(withImage))).toEqual(withImage);
    const doc = parseScenario(withImage);
    for (const out of [rebuildBytes(withImage, doc), serializeMapFromModelBytes(withImage, doc)]) {
      expect(declared(out)).toBe(objects);
      expect(out.slice(out.length - image.length)).toEqual(image);
      expect(verifyBlockIntegrity(out).errors).toEqual([]);
    }
  });

  it("passes the integrity check as the generator wrote it, and fails once the picture is counted", () => {
    expect(verifyBlockIntegrity(withImage).errors).toEqual([]);
    const counted = withImage.slice();
    const buf = new ByteBuffer(counted);
    const ob = buf.lastIndexOf("OB0000", buf.indexOf("WHAT"));
    new DataView(counted.buffer).setInt32(ob + 6, objects + 1, true);
    expect(verifyBlockIntegrity(counted).errors.join(" ")).toMatch(/declares \d+ blocks but \d+ are present/);
  });

  it("takes new blocks BEFORE the attachment, and counts them", () => {
    const road = roadFrame("S143", 0x7000, 3, 4, 0, 0);
    const out = appendBlocks(withImage, [road]);
    expect(declared(out)).toBe(objects + 1);
    expect(out.slice(out.length - image.length)).toEqual(image); // the picture is still last
    expect(out.slice(plain.length, plain.length + road.length)).toEqual(road);
    expect(verifyBlockIntegrity(out).errors).toEqual([]);
    const frames = [...iterateObjects(new ByteBuffer(out))];
    expect(frames.at(-1)!.id).toBe("");
    expect(frames.at(-2)!.typeName).toBe("MidRoad");
    // an ordinary map still simply grows at its end
    const grown = appendBlocks(plain, [road]);
    expect(grown.slice(plain.length)).toEqual(road);
    expect(declared(grown)).toBe(objects + 1);
  });

  it("is refused when an id-less frame sits BETWEEN the objects (the game cannot read past it)", () => {
    const road = roadFrame("S143", 0x7001, 5, 6, 0, 0);
    const buried = concat(plain, image, road); // …picture, then one more object
    const bumped = buried.slice();
    const buf = new ByteBuffer(bumped);
    const ob = buf.lastIndexOf("OB0000", buf.indexOf("WHAT"));
    new DataView(bumped.buffer).setInt32(ob + 6, objects + 1, true);
    expect(verifyBlockIntegrity(bumped).errors.join(" ")).toMatch(/without an OBJ_ID sit between/);
    // such a frame is not an attachment: it stays among the blocks
    expect(splitScenario(bumped).blocks).toHaveLength(objects + 2);
  });
});

// The real thing, when the SMNS 3.0 install is on this machine.
const RANDOM = "C:/GOG Games/SMNS3/Slasher_MNS_v3.0/Exports/Random scenario.sg";
describe.skipIf(!existsSync(RANDOM))("the random scenario shipped with SMNS 3.0", () => {
  it("keeps its object count and its map picture through a model rebuild", () => {
    const bytes = new Uint8Array(readFileSync(RANDOM));
    const s = splitScenario(bytes);
    expect(s.blocks).toHaveLength(declared(bytes));
    expect(new TextDecoder("latin1").decode(s.trailer.slice(0, 32))).toContain(".?AVCMapImage");
    expect(verifyBlockIntegrity(bytes).errors).toEqual([]);
    const out = serializeMapFromModelBytes(bytes, parseScenario(bytes));
    expect(declared(out)).toBe(declared(bytes));
    expect(out.slice(out.length - s.trailer.length)).toEqual(s.trailer);
    expect(verifyBlockIntegrity(out).errors).toEqual([]);
  });
});
