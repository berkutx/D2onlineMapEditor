/**
 * Custom sagas — the `.csg` files the game lists in its «Своя сага» menu.
 *
 * A saga is an MQDB container, like the `.ff` archives:
 *  - a 28-byte file header: "MQDB", the version 9 at +8, the offset of the table of contents'
 *    DATA at +24;
 *  - records, each a 28-byte header ("MQRC", id +8, used +12, size +16, 1 live / 0 free +20)
 *    followed by `size` bytes of which the first `used` are its data;
 *  - record 0, the table of contents: an int32 count and 16-byte {id, used, size, offset of the
 *    record's header} entries, the live records then the free ones, each group in id order;
 *  - record 1, "MFF\0" and the version 5; record 2, the names of the others: an int32 count
 *    and 260-byte entries, the name upper-cased in 256 bytes and the record id at +256.
 *
 * The named records:
 *  - `HEADER.CPN`, 340 bytes: the version (+0: 100 when the missions are `D2EESFISIG`
 *    scenarios, 1 for the older MidFile ones), the name (33 bytes at +4), the description (256
 *    at +37), the author (33 at +293), the saga's race as a global race id `G000RR000N` (+328:
 *    the human seat is the first player of that race), the level the hero starts the saga at
 *    (+332) and a byte at +336 that marks a SAVE PACKAGE — a saga in progress the game wrote
 *    itself, whose first mission is the saved game `D2CC_Current.sg`;
 *  - `ORDER.CPN`, the missions in play order: an int32 count and that many NUL-terminated
 *    names, at most 8 KiB in all (the game reads it into a buffer of that size);
 *  - one record per mission, holding the whole `.sg` file, under the name the order lists.
 *
 * The game finds a mission by its name upper-cased in the process locale: Сёмга's build
 * upper-cases Cyrillic too, the other builds only ASCII. A saga written here names its
 * missions in ASCII, so every build finds them; one read here is looked up both ways.
 */

import { encodeCp1251 } from "./writer/cp1251.js";

const decoder = new TextDecoder("windows-1251");

/** A saga's race, in the order of the global race ids `G000RR0000` … `G000RR0005`. */
export const CAMPAIGN_RACES = ["empire", "clans", "legions", "undead", "neutral", "elves"] as const;
export type CampaignRace = (typeof CAMPAIGN_RACES)[number];

/** What the saga menu shows of a saga, and how it starts. */
export interface CampaignHeader {
  name: string;
  description: string;
  author: string;
  /** null: the stored race id is not one of the six races. */
  race: CampaignRace | null;
  /** The level the saga's hero starts at. */
  heroLevel: number;
}

export type CampaignMissionFormat = "sg" | "midfile" | "missing" | "unknown";

export interface CampaignMission {
  /** The mission's name in the order — its file name inside the saga («Riders.sg»). */
  name: string;
  /**
   * `sg`: a scenario the editor reads; `midfile`: the older format of version-1 sagas, which it
   * does not; `missing`: the order names a record the saga does not hold; `unknown`: other bytes.
   */
  format: CampaignMissionFormat;
  /** The mission file, a view into the saga's bytes (empty when missing). */
  bytes: Uint8Array;
}

export interface CampaignFile {
  /** HEADER.CPN version: 100 (scenario missions) or 1 (MidFile missions). */
  version: number;
  header: CampaignHeader;
  /** The raw race word, for a race outside the six. */
  raceCode: number;
  /** A saga in progress the game saved (its first mission is the saved game). */
  savePackage: boolean;
  missions: CampaignMission[];
}

/** A saga to write: its header and its missions in play order. */
export interface CampaignToWrite {
  header: Omit<CampaignHeader, "race"> & { race: CampaignRace };
  missions: readonly { name: string; bytes: Uint8Array }[];
}

// ---- layout constants (see the file comment) --------------------------------------------
const FILE_HEADER = 28;
const RECORD_HEADER = 28;
const NAME_ENTRY = 260;
const NAME_BYTES = 256;
const TOC_ROUND = 1024;
const MFF_VERSION = 5;
const MQDB_VERSION = 9;
export const CAMPAIGN_HEADER_BYTES = 340;
/** The order is read into a buffer of this size. */
export const CAMPAIGN_ORDER_MAX_BYTES = 0x2000;
const HEADER_RECORD = "HEADER.CPN";
const ORDER_RECORD = "ORDER.CPN";
/** HEADER.CPN fields. */
const H_VERSION = 0;
const H_NAME = 4;
const H_DESCRIPTION = 37;
const H_AUTHOR = 293;
const H_RACE = 328;
const H_LEVEL = 332;
const H_SAVE = 336;
/** Text slots (bytes, NUL included). */
export const CAMPAIGN_NAME_MAX = 32;
export const CAMPAIGN_DESCRIPTION_MAX = 255;
export const CAMPAIGN_AUTHOR_MAX = 32;
/** A global id's type field for races (`G000RR….`). */
const RACE_ID_TYPE = 0x0003_0000;
const SG_MAGIC = "D2EESFISIG";
const MIDFILE_MAGIC = "MidFile";

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

/** True when the bytes are an MQDB container (a saga, or an archive of the same kind). */
export function isMqdb(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, "MQDB") && bytes.length >= FILE_HEADER;
}

function cString(bytes: Uint8Array, at: number, max: number): string {
  let end = at;
  while (end < at + max && end < bytes.length && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(at, end));
}

/** Upper-case the way the game's lookup does: ASCII always, Cyrillic only under Сёмга. */
function upperAscii(name: string): string {
  return name.replace(/[a-z]+/g, (s) => s.toUpperCase());
}

function missionFormat(bytes: Uint8Array): CampaignMissionFormat {
  if (ascii(bytes, 0, SG_MAGIC)) return "sg";
  if (ascii(bytes, 0, MIDFILE_MAGIC)) return "midfile";
  return "unknown";
}

/** The global race id of a race: `G000RR0003` for the undead. */
export function campaignRaceId(race: CampaignRace): string {
  return `G000RR${String(CAMPAIGN_RACES.indexOf(race)).padStart(4, "0")}`;
}

/**
 * Read a saga. Throws on bytes that are not one (no MQDB, no table of contents, no
 * HEADER.CPN); a mission the order names but the saga lacks reads as `missing`.
 */
export function readCampaign(bytes: Uint8Array): CampaignFile {
  if (!isMqdb(bytes)) throw new Error("csg: not an MQDB container");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const i32 = (at: number): number => {
    if (at < 0 || at + 4 > bytes.length) throw new Error(`csg: read past the end at ${at}`);
    return dv.getInt32(at, true);
  };

  // table of contents: id -> the record's data
  const tocData = i32(24);
  const count = i32(tocData);
  if (count < 0 || count > 100_000) throw new Error(`csg: implausible record count ${count}`);
  const records = new Map<number, Uint8Array>();
  for (let k = 0; k < count; k++) {
    const e = tocData + 4 + 16 * k;
    const id = i32(e);
    const used = i32(e + 4);
    const at = i32(e + 12);
    if (!ascii(bytes, at, "MQRC")) throw new Error(`csg: record ${id} has no MQRC header at ${at}`);
    if (i32(at + 20) !== 1) continue; // a free block: stale data
    const start = at + RECORD_HEADER;
    if (used < 0 || start + used > bytes.length) throw new Error(`csg: record ${id} runs past the end`);
    records.set(id, bytes.subarray(start, start + used));
  }

  // names: upper-cased name -> record
  const table = records.get(2);
  if (!table) throw new Error("csg: no name table (record 2)");
  const tdv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const names = table.length >= 4 ? tdv.getInt32(0, true) : 0;
  const byName = new Map<string, Uint8Array>();
  for (let k = 0; k < names; k++) {
    const e = 4 + NAME_ENTRY * k;
    if (e + NAME_ENTRY > table.length) break;
    const name = cString(table, e, NAME_BYTES);
    const rec = records.get(tdv.getInt32(e + NAME_BYTES, true));
    if (rec && !byName.has(name)) byName.set(name, rec);
  }
  const find = (name: string): Uint8Array | undefined =>
    byName.get(name.toUpperCase()) ?? byName.get(upperAscii(name));

  const head = find(HEADER_RECORD);
  if (!head || head.length < H_SAVE) throw new Error("csg: no HEADER.CPN");
  const hdv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const raceCode = hdv.getInt32(H_RACE, true);
  const raceIndex = raceCode & 0xffff;
  const race =
    (raceCode & 0xffff_0000) === RACE_ID_TYPE && raceIndex < CAMPAIGN_RACES.length
      ? CAMPAIGN_RACES[raceIndex]!
      : null;

  const missions: CampaignMission[] = [];
  const order = find(ORDER_RECORD);
  if (order && order.length >= 4) {
    const n = new DataView(order.buffer, order.byteOffset, order.byteLength).getInt32(0, true);
    let p = 4;
    for (let k = 0; k < n && p < order.length; k++) {
      let end = p;
      while (end < order.length && order[end] !== 0) end++;
      const name = decoder.decode(order.subarray(p, end));
      p = end + 1;
      const body = find(name);
      missions.push(
        body
          ? { name, format: missionFormat(body), bytes: body }
          : { name, format: "missing", bytes: new Uint8Array(0) },
      );
    }
  }

  return {
    version: hdv.getInt32(H_VERSION, true),
    header: {
      name: cString(head, H_NAME, H_DESCRIPTION - H_NAME),
      description: cString(head, H_DESCRIPTION, H_AUTHOR - H_DESCRIPTION),
      author: cString(head, H_AUTHOR, H_RACE - H_AUTHOR),
      race,
      heroLevel: hdv.getInt32(H_LEVEL, true),
    },
    raceCode,
    savePackage: head.length > H_SAVE && head[H_SAVE] === 1,
    missions,
  };
}

/** Why a mission name cannot go into a saga, or null when it can. */
export function campaignMissionNameProblem(name: string): string | null {
  if (!/^[\x20-\x7e]+$/.test(name)) return "only ASCII letters, digits and punctuation";
  if (name.length > NAME_BYTES - 1) return `at most ${NAME_BYTES - 1} characters`;
  if (name.toUpperCase() === "D2CC_CURRENT.SG") return "the name of the game's own saved mission";
  if ([HEADER_RECORD, ORDER_RECORD].includes(name.toUpperCase())) return "the name of a saga record";
  return null;
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  і: "i", ї: "yi", є: "ye", ґ: "g",
};

/**
 * An ASCII file name for a mission («Империя 1» -> `Imperiya_1.sg`), not one of `taken`
 * (compared case-insensitively; the chosen name is added to it).
 */
export function campaignMissionFileName(title: string, taken: Set<string>): string {
  let base = "";
  for (const ch of title.trim()) {
    const lower = ch.toLowerCase();
    const t = TRANSLIT[lower];
    const out = t !== undefined ? (ch === lower ? t : t.charAt(0).toUpperCase() + t.slice(1)) : ch;
    base += /^[A-Za-z0-9_-]*$/.test(out) ? out : "_";
  }
  base = base.replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "mission";
  const upper = new Set([...taken].map((t) => t.toUpperCase()));
  let name = `${base}.sg`;
  for (let k = 2; upper.has(name.toUpperCase()) || campaignMissionNameProblem(name); k++) {
    name = `${base}_${k}.sg`;
  }
  taken.add(name);
  return name;
}

function textInto(out: Uint8Array, at: number, text: string, max: number, what: string): void {
  const b = encodeCp1251(text);
  if (b.length > max) throw new Error(`csg: the ${what} is longer than ${max} characters`);
  out.set(b, at);
}

/**
 * Write a saga the game opens: the same layout its own saga editor leaves, without the free
 * blocks — the file header, MFF (record 1), the table of contents (record 0), HEADER.CPN,
 * ORDER.CPN, the missions, and the name table (record 2) last.
 */
export function writeCampaign(c: CampaignToWrite): Uint8Array {
  const { header, missions } = c;
  if (missions.length === 0) throw new Error("csg: a saga needs at least one mission");
  if (!CAMPAIGN_RACES.includes(header.race)) throw new Error(`csg: unknown race ${header.race}`);
  if (!Number.isInteger(header.heroLevel) || header.heroLevel < 1 || header.heroLevel > 99) {
    throw new Error("csg: the hero's level must be 1..99");
  }
  const seen = new Set<string>();
  for (const m of missions) {
    const problem = campaignMissionNameProblem(m.name);
    if (problem) throw new Error(`csg: mission name ${JSON.stringify(m.name)}: ${problem}`);
    if (seen.has(m.name.toUpperCase())) throw new Error(`csg: two missions named ${m.name}`);
    seen.add(m.name.toUpperCase());
    if (missionFormat(m.bytes) !== "sg") throw new Error(`csg: ${m.name} is not a D2EESFISIG scenario`);
  }

  // HEADER.CPN
  const head = new Uint8Array(CAMPAIGN_HEADER_BYTES);
  const hdv = new DataView(head.buffer);
  hdv.setInt32(H_VERSION, 100, true);
  textInto(head, H_NAME, header.name, CAMPAIGN_NAME_MAX, "name");
  textInto(head, H_DESCRIPTION, header.description, CAMPAIGN_DESCRIPTION_MAX, "description");
  textInto(head, H_AUTHOR, header.author, CAMPAIGN_AUTHOR_MAX, "author");
  hdv.setInt32(H_RACE, RACE_ID_TYPE | CAMPAIGN_RACES.indexOf(header.race), true);
  hdv.setInt32(H_LEVEL, header.heroLevel, true);

  // ORDER.CPN
  const orderLen = 4 + missions.reduce((n, m) => n + m.name.length + 1, 0);
  if (orderLen > CAMPAIGN_ORDER_MAX_BYTES) throw new Error("csg: too many missions for the order list");
  const order = new Uint8Array(orderLen);
  new DataView(order.buffer).setInt32(0, missions.length, true);
  let p = 4;
  for (const m of missions) {
    order.set(encodeCp1251(m.name), p);
    p += m.name.length + 1;
  }

  // the named records and their ids: the header, the order, then the missions
  const named = [
    { name: HEADER_RECORD, data: head },
    { name: ORDER_RECORD, data: order },
    ...missions.map((m) => ({ name: m.name, data: m.bytes })),
  ].map((r, k) => ({ ...r, id: 3 + k }));

  // name table (record 2)
  const table = new Uint8Array(4 + NAME_ENTRY * named.length);
  const tdv = new DataView(table.buffer);
  tdv.setInt32(0, named.length, true);
  named.forEach((r, k) => {
    table.set(encodeCp1251(r.name.toUpperCase()), 4 + NAME_ENTRY * k);
    tdv.setInt32(4 + NAME_ENTRY * k + NAME_BYTES, r.id, true);
  });

  const mff = new Uint8Array(8);
  mff.set([0x4d, 0x46, 0x46, 0]);
  new DataView(mff.buffer).setInt32(4, MFF_VERSION, true);

  // the table of contents lists itself too; its size depends only on the record count
  const all = [{ id: 1, data: mff }, { id: 0, data: new Uint8Array(0) }, ...named, { id: 2, data: table }];
  const tocSize = Math.ceil((16 * all.length + 24) / TOC_ROUND) * TOC_ROUND;
  const sizeOf = (r: { id: number; data: Uint8Array }): number => (r.id === 0 ? tocSize : r.data.length);

  // place the records one after the other
  const offsets = new Map<number, number>();
  let end = FILE_HEADER;
  for (const r of all) {
    offsets.set(r.id, end);
    end += RECORD_HEADER + sizeOf(r);
  }

  const out = new Uint8Array(end);
  const dv = new DataView(out.buffer);
  out.set([0x4d, 0x51, 0x44, 0x42]); // MQDB
  dv.setInt32(8, MQDB_VERSION, true);
  dv.setInt32(24, offsets.get(0)! + RECORD_HEADER, true);

  // the table of contents: every record is live, listed in id order
  const toc = new Uint8Array(tocSize);
  const cdv = new DataView(toc.buffer);
  const byId = [...all].sort((a, b) => a.id - b.id);
  cdv.setInt32(0, byId.length, true);
  byId.forEach((r, k) => {
    const e = 4 + 16 * k;
    cdv.setInt32(e, r.id, true);
    cdv.setInt32(e + 4, sizeOf(r), true);
    cdv.setInt32(e + 8, sizeOf(r), true);
    cdv.setInt32(e + 12, offsets.get(r.id)!, true);
  });

  for (const r of all) {
    const at = offsets.get(r.id)!;
    out.set([0x4d, 0x51, 0x52, 0x43], at); // MQRC
    dv.setInt32(at + 8, r.id, true);
    dv.setInt32(at + 12, sizeOf(r), true);
    dv.setInt32(at + 16, sizeOf(r), true);
    dv.setInt32(at + 20, 1, true);
    out.set(r.id === 0 ? toc : r.data, at + RECORD_HEADER);
  }
  return out;
}
