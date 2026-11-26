/**
 * The picture tables of an indexed archive: most of Imgs (IsoUnit, IsoAnim, BatUnits, Events,
 * IconItem, …) and Interf.ff. Faces, Ground, GrBorder, PalMap, IconBld, MenuAnim and Patches
 * have none: their pictures are whole records found by record name. A picture of an indexed
 * archive is found by its INDEX name, not by a record's name:
 *
 *   -INDEX.OPT   int32 count, then per name: int32 uid, the name (Latin-1, NUL-ended),
 *                int32 offset, int32 size. uid is the sprite record (an 8-bit palette PNG
 *                holding the parts of one or more pictures); uid -1 makes the name an
 *                animation. offset/size point at its block in -IMAGES.OPT (-ANIMS.OPT for an
 *                animation). The game looks names up by a case-sensitive binary search in
 *                byte order, so the table is kept sorted and, of equal names, the first counts.
 *   -IMAGES.OPT  blocks, one per sprite record:
 *                uint8 transparent palette index (0), uint16 opacity (255 plain, 300 added,
 *                400 subtracted, other values blended at half), uint32 width and height of
 *                the sprite PNG, 256 palette colours of 4 bytes (R, G, B, unused; the game
 *                colours the PNG's indices with these, not with its PLTE), int32 count, then
 *                per picture: the name, int32 part count, int32 width, int32 height, and per
 *                part six int32 — where the part goes in the picture (x, y), where it is in
 *                the sprite (x, y), width, height.
 *   -ANIMS.OPT   blocks: int32 count, then the frame names (each a picture of the index).
 *
 * Each decoder keeps the bytes after the last item, so the matching encoder gives back the
 * bytes it was given.
 */
import { FfArchive, FfError } from "./archive.js";

export const INDEX_OPT = "-INDEX.OPT";
export const IMAGES_OPT = "-IMAGES.OPT";
export const ANIMS_OPT = "-ANIMS.OPT";

export interface IndexEntry {
  /** The sprite record; -1 for an animation. */
  uid: number;
  name: string;
  /** Offset and size of the entry's block in -IMAGES.OPT (or -ANIMS.OPT for an animation). */
  offset: number;
  size: number;
}

/** One rectangle of a picture: frame[frameX.., frameY..] = sprite[spriteX.., spriteY..]. */
export interface PicturePart {
  frameX: number;
  frameY: number;
  spriteX: number;
  spriteY: number;
  width: number;
  height: number;
}

export interface PictureDesc {
  name: string;
  width: number;
  height: number;
  parts: PicturePart[];
}

export interface ImageBlock {
  /** The palette index drawn as transparent (0 in every archive of the mods). */
  transparentIndex: number;
  /** 255 plain, 300 added, 400 subtracted; another value blends at half (128 occurs). */
  opacity: number;
  /** Size of the sprite PNG. */
  spriteWidth: number;
  spriteHeight: number;
  /** 256 colours, 4 bytes each. */
  palette: Uint8Array;
  pictures: PictureDesc[];
  /** Bytes after the last picture. */
  rest: Uint8Array;
}

export interface AnimationBlock {
  frames: string[];
  rest: Uint8Array;
}

class Reader {
  private at = 0;
  private readonly view: DataView;
  constructor(
    private readonly b: Uint8Array,
    private readonly what: string,
  ) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  private need(n: number): number {
    if (this.at + n > this.b.length) throw new FfError(`${this.what}: ends inside a ${n}-byte field at ${this.at}`);
    const at = this.at;
    this.at += n;
    return at;
  }
  u8(): number {
    return this.view.getUint8(this.need(1));
  }
  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }
  int(): number {
    return this.view.getInt32(this.need(4), true);
  }
  bytes(n: number): Uint8Array {
    if (n < 0) throw new FfError(`${this.what}: a field of ${n} bytes at ${this.at}`);
    const at = this.need(n);
    return this.b.subarray(at, at + n);
  }
  name(): string {
    const end = this.b.indexOf(0, this.at);
    if (end < 0) throw new FfError(`${this.what}: a name at ${this.at} has no end`);
    let s = "";
    for (let i = this.at; i < end; i++) s += String.fromCharCode(this.b[i]!);
    this.at = end + 1;
    return s;
  }
  rest(): Uint8Array {
    const v = this.b.subarray(this.at);
    this.at = this.b.length;
    return v;
  }
}

class Writer {
  private chunks: Uint8Array[] = [];
  private size = 0;
  constructor(private readonly what: string) {}
  private number(n: number, set: (v: DataView) => void): void {
    const b = new Uint8Array(n);
    set(new DataView(b.buffer));
    this.push(b);
  }
  u8(v: number): void {
    this.checked(v, 0xff);
    this.number(1, (d) => d.setUint8(0, v));
  }
  u16(v: number): void {
    this.checked(v, 0xffff);
    this.number(2, (d) => d.setUint16(0, v, true));
  }
  u32(v: number): void {
    this.checked(v, 0xffffffff);
    this.number(4, (d) => d.setUint32(0, v, true));
  }
  int(v: number): void {
    if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) throw new FfError(`${this.what}: ${v} is not an int32`);
    this.number(4, (d) => d.setInt32(0, v, true));
  }
  name(s: string): void {
    const b = new Uint8Array(s.length + 1);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0 || c > 0xff) throw new FfError(`${this.what}: ${JSON.stringify(s)} is not a Latin-1 name`);
      b[i] = c;
    }
    this.push(b);
  }
  push(b: Uint8Array): void {
    this.chunks.push(b);
    this.size += b.length;
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
  private checked(v: number, max: number): void {
    if (!Number.isInteger(v) || v < 0 || v > max) throw new FfError(`${this.what}: ${v} does not fit 0..${max}`);
  }
}

export function decodeIndex(payload: Uint8Array): { entries: IndexEntry[]; rest: Uint8Array } {
  const r = new Reader(payload, INDEX_OPT);
  const count = r.int();
  const entries: IndexEntry[] = [];
  for (let k = 0; k < count; k++) {
    const uid = r.int();
    const name = r.name();
    entries.push({ uid, name, offset: r.int(), size: r.int() });
  }
  return { entries, rest: r.rest() };
}

export function encodeIndex(index: { entries: readonly IndexEntry[]; rest?: Uint8Array }): Uint8Array {
  const w = new Writer(INDEX_OPT);
  w.int(index.entries.length);
  for (const e of index.entries) {
    w.int(e.uid);
    w.name(e.name);
    w.int(e.offset);
    w.int(e.size);
  }
  if (index.rest) w.push(index.rest);
  return w.done();
}

/** Byte order of two Latin-1 names, as the game's lookup compares them. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when the entries are in byte order of their names (every index of the mods is). */
export function isIndexSorted(entries: readonly IndexEntry[]): boolean {
  for (let k = 1; k < entries.length; k++) if (compareNames(entries[k - 1]!.name, entries[k]!.name) > 0) return false;
  return true;
}

/**
 * The entries with one more, in byte order: after the entries of an equal name, or before
 * them with `first` (then it is the one the game finds). The entries must be sorted.
 */
export function insertIndexEntry(entries: readonly IndexEntry[], entry: IndexEntry, opts: { first?: boolean } = {}): IndexEntry[] {
  if (!isIndexSorted(entries)) throw new FfError(`${INDEX_OPT}: the entries are not in byte order`);
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const c = compareNames(entries[mid]!.name, entry.name);
    if (c < 0 || (c === 0 && !opts.first)) lo = mid + 1;
    else hi = mid;
  }
  return [...entries.slice(0, lo), entry, ...entries.slice(lo)];
}

export function decodeImageBlock(block: Uint8Array): ImageBlock {
  const r = new Reader(block, IMAGES_OPT);
  const transparentIndex = r.u8();
  const opacity = r.u16();
  const spriteWidth = r.u32();
  const spriteHeight = r.u32();
  const palette = r.bytes(1024);
  const count = r.int();
  const pictures: PictureDesc[] = [];
  for (let k = 0; k < count; k++) {
    const name = r.name();
    const partCount = r.int();
    const width = r.int();
    const height = r.int();
    const parts: PicturePart[] = [];
    for (let p = 0; p < partCount; p++) {
      parts.push({ frameX: r.int(), frameY: r.int(), spriteX: r.int(), spriteY: r.int(), width: r.int(), height: r.int() });
    }
    pictures.push({ name, width, height, parts });
  }
  return { transparentIndex, opacity, spriteWidth, spriteHeight, palette, pictures, rest: r.rest() };
}

export function encodeImageBlock(block: ImageBlock): Uint8Array {
  if (block.palette.length !== 1024) throw new FfError(`${IMAGES_OPT}: a block needs a 1024-byte palette`);
  const w = new Writer(IMAGES_OPT);
  w.u8(block.transparentIndex);
  w.u16(block.opacity);
  w.u32(block.spriteWidth);
  w.u32(block.spriteHeight);
  w.push(block.palette);
  w.int(block.pictures.length);
  for (const p of block.pictures) {
    w.name(p.name);
    w.int(p.parts.length);
    w.int(p.width);
    w.int(p.height);
    for (const part of p.parts) for (const v of [part.frameX, part.frameY, part.spriteX, part.spriteY, part.width, part.height]) w.int(v);
  }
  w.push(block.rest);
  return w.done();
}

export function decodeAnimationBlock(block: Uint8Array): AnimationBlock {
  const r = new Reader(block, ANIMS_OPT);
  const count = r.int();
  const frames: string[] = [];
  for (let k = 0; k < count; k++) frames.push(r.name());
  return { frames, rest: r.rest() };
}

export function encodeAnimationBlock(block: AnimationBlock): Uint8Array {
  const w = new Writer(ANIMS_OPT);
  w.int(block.frames.length);
  for (const f of block.frames) w.name(f);
  w.push(block.rest);
  return w.done();
}

/**
 * The picture tables of one archive. `null` for an archive without -INDEX.OPT (its pictures
 * are whole records found by their record name, e.g. the terrain archives).
 */
export class PictureTables {
  private constructor(
    private readonly archive: FfArchive,
    readonly entries: readonly IndexEntry[],
    private readonly byName: ReadonlyMap<string, IndexEntry>,
    private readonly images: Uint8Array | undefined,
    private readonly anims: Uint8Array | undefined,
  ) {}

  static of(archive: FfArchive): PictureTables | null {
    const indexId = archive.idByName(INDEX_OPT);
    if (indexId === undefined) return null;
    const { entries } = decodeIndex(archive.get(indexId)!);
    const imagesId = archive.idByName(IMAGES_OPT);
    const animsId = archive.idByName(ANIMS_OPT);
    const byName = new Map<string, IndexEntry>();
    for (const e of entries) if (!byName.has(e.name)) byName.set(e.name, e);
    return new PictureTables(archive, entries, byName, imagesId === undefined ? undefined : archive.get(imagesId), animsId === undefined ? undefined : archive.get(animsId));
  }

  /** True when the index is in the byte order the game's lookup needs. */
  get sorted(): boolean {
    return isIndexSorted(this.entries);
  }

  /** The entry the game finds for a name: exact case, the first of equal names. */
  entry(name: string): IndexEntry | undefined {
    return this.byName.get(name);
  }

  /** The raw block an entry points at (in -IMAGES.OPT, or -ANIMS.OPT for an animation). */
  blockBytes(e: IndexEntry): Uint8Array {
    const table = e.uid === -1 ? this.anims : this.images;
    if (!table) throw new FfError(`${this.archive.name}: no ${e.uid === -1 ? ANIMS_OPT : IMAGES_OPT} for ${e.name}`);
    if (e.offset < 0 || e.size < 0 || e.offset + e.size > table.length) throw new FfError(`${this.archive.name}: ${e.name} points past its table`);
    return table.subarray(e.offset, e.offset + e.size);
  }

  /** The cut-out description of a picture (not an animation) and its sprite record. */
  picture(name: string): { source: number; desc: PictureDesc } | undefined {
    const e = this.entry(name);
    if (!e || e.uid === -1) return undefined;
    const desc = decodeImageBlock(this.blockBytes(e)).pictures.find((p) => p.name === e.name);
    return desc ? { source: e.uid, desc } : undefined;
  }

  /** The frame names of an animation. */
  animation(name: string): string[] | undefined {
    const e = this.entry(name);
    if (!e || e.uid !== -1) return undefined;
    return decodeAnimationBlock(this.blockBytes(e)).frames;
  }
}
