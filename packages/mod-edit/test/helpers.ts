/** Small tables and archives built here, so the rules hold without a game install. */
import { createHash } from "node:crypto";
import { DbfTable, type DbfFieldSpec, type DbfValue } from "@d2/dbf";
import { ANIMS_OPT, encodeAnimationBlock, encodeImageBlock, encodeIndex, FfArchive, IMAGES_OPT, INDEX_OPT, type IndexEntry } from "@d2/ff";
import type { ArchiveIo } from "../src/index";

export const UNIT_FIELDS: DbfFieldSpec[] = [
  { name: "UNIT_ID", type: "C", length: 10 },
  { name: "NAME_TXT", type: "C", length: 12 },
  { name: "LEVEL", type: "N", length: 3 },
  { name: "WATER_ONLY", type: "L", length: 1 },
];

export type Row = Record<string, DbfValue> & { _deleted?: boolean };

/** A table as read from a file: not modified. */
export function table(name: string, specs: readonly DbfFieldSpec[], rows: readonly Row[]): DbfTable {
  const t = DbfTable.create(name, specs);
  for (const { _deleted, ...values } of rows) {
    const r = t.appendRow(values);
    if (_deleted) t.setDeleted(r, true);
  }
  return DbfTable.read(t.toBytes(), name);
}

export function units(rows: readonly Row[] = UNITS): DbfTable {
  return table("Gunits", UNIT_FIELDS, rows);
}

export const UNITS: Row[] = [
  { UNIT_ID: "g000uu0001", NAME_TXT: "Squire", LEVEL: 1, WATER_ONLY: false },
  { UNIT_ID: "g000uu0002", NAME_TXT: "Gone", LEVEL: 2, WATER_ONLY: false, _deleted: true },
  { UNIT_ID: "g000uu0003", NAME_TXT: "Archer", LEVEL: null, WATER_ONLY: true },
  { UNIT_ID: "g000uu0002", NAME_TXT: "Knight", LEVEL: 3, WATER_ONLY: false },
];

/** Live rows by their first column, upper-cased, as plain objects. */
export function liveRows(t: DbfTable, column = "UNIT_ID"): Record<string, Record<string, DbfValue>> {
  const out: Record<string, Record<string, DbfValue>> = {};
  for (let r = 0; r < t.rowCount; r++) {
    if (t.isDeleted(r)) continue;
    out[String(t.get(r, column)).toUpperCase()] = t.row(r);
  }
  return out;
}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function io(payloads: Uint8Array[] = []): ArchiveIo {
  const byHash = new Map(payloads.map((p) => [sha256(p), p]));
  return { sha256, payload: (h) => byHash.get(h) };
}

const bytes = (...v: number[]) => new Uint8Array(v);

/**
 * An archive with a picture index: one sprite record holding two frames (A_FRAME0, A_FRAME1),
 * an animation A_MOVE of both, and a loose record LOOSE.BIN nothing uses.
 */
export function pictureArchive(name = "IsoUnit.ff"): FfArchive {
  const a = FfArchive.create(name);
  const put = (record: string, payload: Uint8Array) => {
    const id = a.nextId();
    a.put(id, payload);
    a.setName(id, record);
    return id;
  };
  const sprite = put("SPRITE0", bytes(0x89, 0x50, 0x4e, 0x47, 1, 2, 3));
  put("LOOSE.BIN", bytes(9, 9, 9));
  const part = (spriteX: number) => ({ frameX: 0, frameY: 0, spriteX, spriteY: 0, width: 2, height: 2 });
  const images = encodeImageBlock({
    transparentIndex: 0,
    opacity: 255,
    spriteWidth: 4,
    spriteHeight: 2,
    palette: new Uint8Array(1024),
    pictures: [
      { name: "A_FRAME0", width: 2, height: 2, parts: [part(0)] },
      { name: "A_FRAME1", width: 2, height: 2, parts: [part(2)] },
    ],
    rest: new Uint8Array(0),
  });
  const anims = encodeAnimationBlock({ frames: ["A_FRAME0", "A_FRAME1"], rest: new Uint8Array(0) });
  const entries: IndexEntry[] = [
    { uid: sprite, name: "A_FRAME0", offset: 0, size: images.length },
    { uid: sprite, name: "A_FRAME1", offset: 0, size: images.length },
    { uid: -1, name: "A_MOVE", offset: 0, size: anims.length },
  ];
  put(IMAGES_OPT, images);
  put(ANIMS_OPT, anims);
  put(INDEX_OPT, encodeIndex({ entries }));
  return FfArchive.read(a.toBytes(), name);
}
