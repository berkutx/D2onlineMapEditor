/**
 * An MQDB archive (.ff) of the game, read and written without losing a byte.
 *
 * Layout (every one of the 118 archives in Imgs and Interf of the four mods has it, and so
 * does a campaign package the game's own tools wrote):
 *
 *   file header  'MQDB' + six int32: 0, 9 (the version), 0, 0, 0, offset of the payload of
 *                the directory (record 0)
 *   records      back to back from offset 28 to the end of the file:
 *                'MQRC' + int32 0, id, bytes used, block size, flag (1 live, 0 free), 0,
 *                then the block: `used` bytes of payload and `size - used` unused bytes
 *                (none in the game's .ff files; the game leaves some when it shrinks a record)
 *
 * The game finds records through the directory, never by walking the file:
 *   id 0  the directory: int32 count of live records, their entries {id, used, size, offset
 *         of the 'MQRC'} (the directory lists itself), then int32 count of free blocks and
 *         theirs. What follows is filler and is kept. The game sizes it as
 *         ceil((16 * (live + free) + 24) / 1024) KB, and every archive of the mods obeys that.
 *   id 1  'MFF\0' + int32 5, the format version; the game opens nothing else.
 *   id 2  the name table: int32 count, then exactly that many 260-byte entries, char[256]
 *         name + int32 id. The game upper-cases the name it is asked for and compares
 *         exactly, so a stored name must be upper case; of equal names the first counts.
 * A free block (Nazar's Legacy BatUnits.ff has one, flag 0) is never served and stays. A
 * name may outlive its record (433 in that archive). Two records with one id make the game
 * refuse the archive, so a new id is above every id of a record, a free block or a name.
 *
 * The archive keeps VIEWS of the bytes it was read from — do not change them afterwards.
 * Writing lays the records out again in their file order (new ones at the end), rebuilds the
 * directory and points the header at it. An archive that was not edited writes back to the
 * same bytes, the directory included; replacing a payload with one of the same length in a
 * block with no unused bytes changes only that payload. A replaced payload gets a block of
 * its own length; a deleted record leaves the file.
 */

export const DIRECTORY_ID = 0;
export const VERSION_ID = 1;
export const NAMES_ID = 2;

const FILE_HEADER = 28;
const RECORD_HEADER = 28;
const DIRECTORY_ENTRY = 16;
const DIRECTORY_STEP = 1024;
const NAME_ENTRY = 260;
const NAME_FIELD = 256;
const MAX_ID = 0x7fffffff;
const MQDB = [0x4d, 0x51, 0x44, 0x42];
const MQRC = [0x4d, 0x51, 0x52, 0x43];
const EMPTY = new Uint8Array(0);

export class FfError extends Error {
  override name = "FfError";
}

interface Rec {
  id: number;
  /** The 28 stored header bytes (flag and reserved fields included). */
  head: Uint8Array;
  /** The used bytes of the block. */
  payload: Uint8Array;
  /** The rest of the block, kept as it was. */
  slack: Uint8Array;
  free: boolean;
}

export interface FfRecordInfo {
  id: number;
  /** Payload bytes. */
  size: number;
  /** Block bytes: the payload and the unused bytes after it. */
  allocated: number;
  /** False for a free block. */
  live: boolean;
  /** The flag of its header (1 live, 0 free). */
  flag: number;
}

export interface FfName {
  name: string;
  id: number;
}

/** The size the game gives the directory for this many entries. */
export function directorySize(entries: number): number {
  return Math.ceil((DIRECTORY_ENTRY * entries + 24) / DIRECTORY_STEP) * DIRECTORY_STEP;
}

/** A name as the game looks it up: a-z upper-cased, nothing else changed. */
export function nameKey(name: string): string {
  return name.replace(/[a-z]+/g, (s) => s.toUpperCase());
}

function int32(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(at, true);
}

function startsWith(b: Uint8Array, at: number, sig: readonly number[]): boolean {
  return sig.every((c, i) => b[at + i] === c);
}

/** Latin-1 bytes up to the first NUL. */
function cString(b: Uint8Array): string {
  const end = b.indexOf(0);
  let s = "";
  for (const c of end < 0 ? b : b.subarray(0, end)) s += String.fromCharCode(c);
  return s;
}

function recordHead(id: number, size: number): Uint8Array {
  const head = new Uint8Array(RECORD_HEADER);
  head.set(MQRC, 0);
  const v = new DataView(head.buffer);
  v.setInt32(8, id, true);
  v.setInt32(12, size, true);
  v.setInt32(16, size, true);
  v.setInt32(20, 1, true);
  return head;
}

export class FfArchive {
  private readonly byId = new Map<number, Rec>();
  private names: FfName[] | null = null;
  private namesEdited = false;
  private edited = false;

  private constructor(
    /** Labels errors ("BatUnits.ff"). */
    readonly name: string,
    private readonly fileHeader: Uint8Array,
    /** Every record in file order, the directory and the free blocks included. */
    private readonly layout: Rec[],
    /** The live records in directory order (the directory itself among them). */
    private readonly listing: Rec[],
    /** The free blocks in directory order. */
    private readonly freeList: Rec[],
    private readonly directory: Rec,
  ) {
    for (const r of listing) this.byId.set(r.id, r);
  }

  /** Read an archive. The archive keeps views of `bytes`. */
  static read(bytes: Uint8Array, name = "archive"): FfArchive {
    if (bytes.length < FILE_HEADER || !startsWith(bytes, 0, MQDB)) throw new FfError(`${name}: not an MQDB archive`);
    const layout: (Rec & { at: number; listed: boolean })[] = [];
    for (let at = FILE_HEADER; at < bytes.length; ) {
      if (at + RECORD_HEADER > bytes.length || !startsWith(bytes, at, MQRC)) {
        throw new FfError(`${name}: no record at offset ${at} (${bytes.length - at} bytes left)`);
      }
      const id = int32(bytes, at + 8);
      const used = int32(bytes, at + 12);
      const size = int32(bytes, at + 16);
      if (used < 0 || size < used) throw new FfError(`${name}: record ${id} at ${at} uses ${used} bytes of a ${size}-byte block`);
      if (at + RECORD_HEADER + size > bytes.length) throw new FfError(`${name}: record ${id} at ${at} runs past the end`);
      const body = at + RECORD_HEADER;
      layout.push({
        id,
        at,
        listed: false,
        free: false,
        head: bytes.subarray(at, body),
        payload: bytes.subarray(body, body + used),
        slack: bytes.subarray(body + used, body + size),
      });
      at = body + size;
    }
    const dirAt = int32(bytes, 24) - RECORD_HEADER;
    const directory = layout.find((r) => r.at === dirAt);
    if (!directory || directory.id !== DIRECTORY_ID) throw new FfError(`${name}: the header does not point at the directory`);

    const p = directory.payload;
    const byOffset = new Map(layout.map((r) => [r.at, r]));
    const ids = new Set<number>();
    let pos = 0;
    const list = (what: string, free: boolean): Rec[] => {
      const count = pos + 4 <= p.length ? int32(p, pos) : -1;
      if (count < 0 || pos + 4 + count * DIRECTORY_ENTRY > p.length) throw new FfError(`${name}: the directory lists ${count} ${what} in ${p.length - pos} bytes`);
      const out: Rec[] = [];
      for (let k = 0; k < count; k++) {
        const e = pos + 4 + k * DIRECTORY_ENTRY;
        const [id, used, size, at] = [int32(p, e), int32(p, e + 4), int32(p, e + 8), int32(p, e + 12)];
        const rec = byOffset.get(at);
        if (!rec || rec.id !== id || rec.payload.length !== used || rec.payload.length + rec.slack.length !== size || rec.listed) {
          throw new FfError(`${name}: directory entry ${k} of the ${what} (id ${id} at ${at}) does not match the records`);
        }
        if (ids.has(id)) throw new FfError(`${name}: id ${id} is used twice`);
        ids.add(id);
        rec.listed = true;
        rec.free = free;
        out.push(rec);
      }
      pos += 4 + count * DIRECTORY_ENTRY;
      return out;
    };
    const listing = list("live records", false);
    const freeList = list("free blocks", true);
    if (!directory.listed || directory.free) throw new FfError(`${name}: the directory does not list itself`);
    const unlisted = layout.find((r) => !r.listed);
    if (unlisted) throw new FfError(`${name}: record ${unlisted.id} at ${unlisted.at} is not in the directory`);
    return new FfArchive(name, bytes.subarray(0, FILE_HEADER), layout, listing, freeList, directory);
  }

  /** A new empty archive in the game's form: the version record, an empty name table, a 1 KB directory. */
  static create(name = "archive"): FfArchive {
    const header = new Uint8Array(FILE_HEADER);
    header.set(MQDB, 0);
    new DataView(header.buffer).setInt32(8, 9, true);
    const version = Uint8Array.of(0x4d, 0x46, 0x46, 0, 5, 0, 0, 0);
    const dirSize = directorySize(3);
    const rec = (id: number, payload: Uint8Array): Rec => ({ id, head: recordHead(id, payload.length), payload, slack: EMPTY, free: false });
    const [dir, ver, names] = [rec(DIRECTORY_ID, new Uint8Array(dirSize)), rec(VERSION_ID, version), rec(NAMES_ID, new Uint8Array(4))];
    const archive = new FfArchive(name, header, [ver, names, dir], [dir, ver, names], [], dir);
    archive.edited = true;
    return archive;
  }

  /** True once a record or a name was changed. */
  get modified(): boolean {
    return this.edited || this.namesEdited;
  }

  /** Ids of the live records in directory order, without the directory itself. */
  ids(): number[] {
    return this.listing.filter((r) => r !== this.directory).map((r) => r.id);
  }

  has(id: number): boolean {
    return id !== DIRECTORY_ID && this.byId.has(id);
  }

  /** A live record's payload (a view: do not write into it), or undefined. */
  get(id: number): Uint8Array | undefined {
    if (id === DIRECTORY_ID) return undefined;
    return this.byId.get(id)?.payload;
  }

  /** Every record in file order, the free blocks included. */
  records(): FfRecordInfo[] {
    return this.layout.map((r) => ({ id: r.id, size: r.payload.length, allocated: r.payload.length + r.slack.length, live: !r.free, flag: int32(r.head, 20) }));
  }

  /**
   * Replace a live record's payload, or add a record with a new id at the end. The payload is
   * copied. A replaced payload gets a block of its own length.
   */
  put(id: number, payload: Uint8Array): void {
    if (!Number.isInteger(id) || id <= DIRECTORY_ID || id > MAX_ID) throw new FfError(`${this.name}: record id ${id} cannot be written`);
    if (this.freeList.some((r) => r.id === id)) throw new FfError(`${this.name}: id ${id} belongs to a free block`);
    // the constructor copies; slice() would not for a Node Buffer
    const data = new Uint8Array(payload);
    const rec = this.byId.get(id);
    if (rec) {
      rec.payload = data;
      rec.slack = EMPTY;
    } else {
      const added: Rec = { id, head: recordHead(id, data.length), payload: data, slack: EMPTY, free: false };
      this.layout.push(added);
      this.listing.push(added);
      this.byId.set(id, added);
    }
    if (id === NAMES_ID) {
      this.names = null;
      this.namesEdited = false;
    }
    this.edited = true;
  }

  /** Remove a live record and its names. The record leaves the file. */
  delete(id: number): void {
    const rec = this.byId.get(id);
    if (!rec || id === DIRECTORY_ID || id === NAMES_ID || id === VERSION_ID) throw new FfError(`${this.name}: record ${id} cannot be deleted`);
    const names = this.nameList(); // may throw: nothing is changed before it
    this.layout.splice(this.layout.indexOf(rec), 1);
    this.listing.splice(this.listing.indexOf(rec), 1);
    this.byId.delete(id);
    if (names.some((n) => n.id === id)) {
      this.names = names.filter((n) => n.id !== id);
      this.namesEdited = true;
    }
    this.edited = true;
  }

  /** An id no record, free block or name uses yet. */
  nextId(): number {
    let max = DIRECTORY_ID;
    for (const r of this.layout) max = Math.max(max, r.id);
    for (const n of this.nameList()) max = Math.max(max, n.id);
    return max + 1;
  }

  // ---- the name table (record 2) ----

  /** The name table in its order. */
  nameTable(): FfName[] {
    return this.nameList().map((n) => ({ ...n }));
  }

  /** The first name the table gives a record. */
  nameOf(id: number): string | undefined {
    return this.nameList().find((n) => n.id === id)?.name;
  }

  /**
   * The id of a live record by its name, as the game finds it: the name is upper-cased (a-z)
   * and compared exactly, and the first entry of that name counts, even when its record is gone.
   */
  idByName(name: string): number | undefined {
    const key = nameKey(name);
    const entry = this.nameList().find((n) => n.name === key);
    return entry && this.byId.has(entry.id) ? entry.id : undefined;
  }

  /**
   * Name a record: the first entry for the id is renamed, or an entry is added. The name is
   * stored upper-cased (a-z), the way the game looks names up. A name another record already
   * has is refused: the game would find only one of the two.
   */
  setName(id: number, name: string): void {
    if (!name || name.length >= NAME_FIELD || [...name].some((c) => c.charCodeAt(0) > 0xff || c === "\0")) {
      throw new FfError(`${this.name}: ${JSON.stringify(name)} cannot be a record name (Latin-1, 1-255 characters)`);
    }
    const key = nameKey(name);
    const list = this.nameList();
    const other = list.find((n) => n.name === key && n.id !== id);
    if (other) throw new FfError(`${this.name}: ${key} already names record ${other.id}`);
    const entry = list.find((n) => n.id === id);
    if (entry?.name === key) return;
    if (entry) entry.name = key;
    else list.push({ name: key, id });
    this.namesEdited = true;
  }

  // ---- writing ----

  /** The archive as file bytes. */
  toBytes(): Uint8Array {
    if (this.namesEdited) {
      const list = this.nameList();
      const p = new Uint8Array(4 + list.length * NAME_ENTRY);
      const v = new DataView(p.buffer);
      v.setInt32(0, list.length, true);
      list.forEach((n, k) => {
        const at = 4 + k * NAME_ENTRY;
        for (let i = 0; i < n.name.length; i++) p[at + i] = n.name.charCodeAt(i);
        v.setInt32(at + NAME_FIELD, n.id, true);
      });
      const names = this.byId.get(NAMES_ID);
      if (!names) throw new FfError(`${this.name}: the archive has no name table`);
      names.payload = p;
      names.slack = EMPTY;
      this.namesEdited = false;
      this.edited = true;
    }

    // an unedited directory keeps its block; an edited one gets the game's size, the old
    // bytes as its filler
    const old = this.directory;
    const dirUsed = this.edited ? directorySize(this.listing.length + this.freeList.length) : old.payload.length;
    const dirSlack = this.edited ? EMPTY : old.slack;
    const dir = new Uint8Array(dirUsed);
    dir.set(old.payload.subarray(0, Math.min(old.payload.length, dirUsed)), 0);

    const block = (r: Rec): [Uint8Array, Uint8Array] => (r === old ? [dir, dirSlack] : [r.payload, r.slack]);
    const offsets = new Map<Rec, number>();
    let size = FILE_HEADER;
    for (const r of this.layout) {
      const [payload, slack] = block(r);
      offsets.set(r, size);
      size += RECORD_HEADER + payload.length + slack.length;
    }
    const dv = new DataView(dir.buffer);
    let pos = 0;
    for (const list of [this.listing, this.freeList]) {
      dv.setInt32(pos, list.length, true);
      pos += 4;
      for (const r of list) {
        const [payload, slack] = block(r);
        dv.setInt32(pos, r.id, true);
        dv.setInt32(pos + 4, payload.length, true);
        dv.setInt32(pos + 8, payload.length + slack.length, true);
        dv.setInt32(pos + 12, offsets.get(r)!, true);
        pos += DIRECTORY_ENTRY;
      }
    }

    const out = new Uint8Array(size);
    const ov = new DataView(out.buffer);
    out.set(this.fileHeader, 0);
    ov.setInt32(24, offsets.get(old)! + RECORD_HEADER, true);
    for (const r of this.layout) {
      const at = offsets.get(r)!;
      const [payload, slack] = block(r);
      out.set(r.head, at);
      if (int32(r.head, 12) !== payload.length) ov.setInt32(at + 12, payload.length, true);
      if (int32(r.head, 16) !== payload.length + slack.length) ov.setInt32(at + 16, payload.length + slack.length, true);
      out.set(payload, at + RECORD_HEADER);
      out.set(slack, at + RECORD_HEADER + payload.length);
    }
    return out;
  }

  // ---- internals ----

  private nameList(): FfName[] {
    if (this.names) return this.names;
    const p = this.byId.get(NAMES_ID)?.payload;
    const list: FfName[] = [];
    if (p && p.length >= 4) {
      const count = int32(p, 0);
      if (count < 0 || 4 + count * NAME_ENTRY > p.length) throw new FfError(`${this.name}: the name table holds ${count} names in ${p.length} bytes`);
      for (let k = 0; k < count; k++) {
        const at = 4 + k * NAME_ENTRY;
        list.push({ name: cString(p.subarray(at, at + NAME_FIELD)), id: int32(p, at + NAME_FIELD) });
      }
    }
    this.names = list;
    return list;
  }
}
