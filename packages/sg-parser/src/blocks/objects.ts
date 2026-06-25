/**
 * Placed-object block readers. Each returns a MapObject (Contract A) or null.
 *
 * Positions are CARTESIAN (POS_X = col, POS_Y = row); iso lives in the renderer.
 * Field names below were read from real bytes (see spikes); fields marked GUESS
 * in comments were inferred from toolsqt naming and degrade gracefully (they are
 * optional in the schema).
 */

import {
  ByteBuffer,
  readDefaultInt,
  readDefaultString,
  readDefaultBool,
} from "../bytebuffer.js";
import type { FramedObject } from "../framing.js";
import { parseCompoundId } from "../framing.js";
import type { MapObject } from "@d2/map-schema";

const NULL_ID = "G000000000"; // sentinel "no reference" compound id

function pos(buf: ByteBuffer, obj: FramedObject): { x: number; y: number } {
  const x = readDefaultInt(buf, "POS_X", obj.fieldsFrom, obj.fieldsEnd) ?? 0;
  const y = readDefaultInt(buf, "POS_Y", obj.fieldsFrom, obj.fieldsEnd) ?? 0;
  return { x, y };
}

function refOrUndef(s: string | null): string | undefined {
  if (!s || s === NULL_ID) return undefined;
  return s;
}

/** MidStack: a moving army. Verified fields: UNIT_0..5, LEADER_ID, OWNER, FACING, BANNER, POS_X/Y. */
export function readStack(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const units: string[] = [];
  for (let i = 0; i < 6; i++) {
    const u = refOrUndef(readDefaultString(buf, `UNIT_${i}`, f, e));
    if (u) units.push(u);
  }
  const owner = refOrUndef(readDefaultString(buf, "OWNER", f, e));
  const leaderUnitId = refOrUndef(readDefaultString(buf, "LEADER_ID", f, e));
  const banner = refOrUndef(readDefaultString(buf, "BANNER", f, e));
  const facing = readDefaultInt(buf, "FACING", f, e);
  return {
    type: "stack",
    id: obj.id,
    pos: pos(buf, obj),
    ...(owner ? { owner } : {}),
    ...(leaderUnitId ? { leaderUnitId } : {}),
    ...(banner ? { banner } : {}),
    ...(facing !== null ? { facing } : {}),
    units,
  };
}

/** MidVillage: a town/fort (uid prefix FT, disambiguated by TypeName). SIZE = tier. */
export function readVillage(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const owner = refOrUndef(readDefaultString(buf, "OWNER", f, e));
  const subrace = readDefaultString(buf, "SUBRACE", f, e);
  const parsedRace = subrace ? parseCompoundId(subrace) : null;
  const name = readDefaultString(buf, "NAME_TXT", f, e) ?? "";
  const tier = readDefaultInt(buf, "SIZE", f, e) ?? 1;
  return {
    type: "village",
    id: obj.id,
    pos: pos(buf, obj),
    ...(owner ? { owner } : {}),
    ...(parsedRace ? { race: parsedRace.index } : {}),
    name,
    tier,
  };
}

/** Capital: a player capital city (uid prefix FT, TypeName "Capital"). */
export function readCapital(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const owner = refOrUndef(readDefaultString(buf, "OWNER", f, e));
  const subrace = readDefaultString(buf, "SUBRACE", f, e);
  const parsedRace = subrace ? parseCompoundId(subrace) : null;
  const name = readDefaultString(buf, "NAME_TXT", f, e) ?? "";
  return {
    type: "capital",
    id: obj.id,
    pos: pos(buf, obj),
    ...(owner ? { owner } : {}),
    ...(parsedRace ? { race: parsedRace.index } : {}),
    name,
  };
}

/** MidRuin: a lootable ruin. NAME_TXT, IMAGE (GUESS), looted flag (GUESS). */
export function readRuin(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const name = readDefaultString(buf, "NAME_TXT", f, e) ?? "";
  const image = readDefaultInt(buf, "IMAGE", f, e); // GUESS: image index tag
  const looted = readDefaultBool(buf, "LOOTED", f, e); // GUESS
  return {
    type: "ruin",
    id: obj.id,
    pos: pos(buf, obj),
    name,
    ...(image !== null ? { image } : {}),
    looted,
  };
}

type SiteType = "merchant" | "mage" | "trainer" | "mercenary";

/** MidSite*: shared layout. TXT_TITLE = name, IMG_ISO = image. */
export function readSite(type: SiteType) {
  return (buf: ByteBuffer, obj: FramedObject): MapObject => {
    const { fieldsFrom: f, fieldsEnd: e } = obj;
    const name = readDefaultString(buf, "TXT_TITLE", f, e) ?? "";
    const image = readDefaultInt(buf, "IMG_ISO", f, e);
    return {
      type,
      id: obj.id,
      pos: pos(buf, obj),
      name,
      ...(image !== null ? { image } : {}),
    };
  };
}

/** MidCrystal: a mana crystal node. RESOURCE packs mana type+amount. */
export function readCrystal(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const resource = readDefaultInt(buf, "RESOURCE", f, e);
  return {
    type: "crystal",
    id: obj.id,
    pos: pos(buf, obj),
    ...(resource !== null ? { resource } : {}),
  };
}

/** MidLocation: a named circular region. RADIUS, NAME_TXT, POS_X/Y. */
export function readLocation(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const name = readDefaultString(buf, "NAME_TXT", f, e) ?? "";
  const radius = readDefaultInt(buf, "RADIUS", f, e) ?? 0;
  return {
    type: "location",
    id: obj.id,
    pos: pos(buf, obj),
    name,
    radius,
  };
}

/** MidLandmark: decorative scenery. TYPE = compound baseType (e.g. G000MG8057). */
export function readLandmark(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const baseType = refOrUndef(readDefaultString(buf, "TYPE", f, e));
  return {
    type: "landmark",
    id: obj.id,
    pos: pos(buf, obj),
    ...(baseType ? { baseType } : {}),
  };
}

/** MidUnit: a unit definition (referenced by stacks/cities). TYPE = impl id. */
export function readUnit(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const implId = refOrUndef(readDefaultString(buf, "TYPE", f, e));
  return {
    type: "unit",
    id: obj.id,
    pos: { x: 0, y: 0 }, // units carry no map position; placed via their stack/city
    ...(implId ? { implId } : {}),
  };
}

/**
 * MidMountains: a SINGLE object that contains N repeated mountain entries, each
 * being ID_MOUNT, SIZE_X, SIZE_Y, POS_X, POS_Y, IMAGE, RACE. We walk every POS_X
 * occurrence in the object body and emit one `mountains` object per entry.
 */
export function readMountains(buf: ByteBuffer, obj: FramedObject): MapObject[] {
  const out: MapObject[] = [];
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  // Each entry is delimited by ID_MOUNT and carries SIZE_X, SIZE_Y, POS_X, POS_Y,
  // IMAGE, RACE (in that order). Iterating by ID_MOUNT keeps SIZE_X/Y (which precede
  // POS_X) inside the entry so the editor's "MOMNE"+w+image key can be built.
  let i = f;
  let n = 0;
  for (;;) {
    const idm = buf.indexOf("ID_MOUNT", i);
    if (idm < 0 || idm >= e) break;
    const next = buf.indexOf("ID_MOUNT", idm + 1);
    const entryEnd = next >= 0 && next < e ? next : e;

    const w = readDefaultInt(buf, "SIZE_X", idm, entryEnd);
    const h = readDefaultInt(buf, "SIZE_Y", idm, entryEnd);
    const px = buf.indexOf("POS_X", idm);
    const x = px >= 0 && px < entryEnd ? buf.readInt32LE(px + "POS_X".length) : 0;
    const py = buf.indexOf("POS_Y", idm);
    const y = py >= 0 && py < entryEnd ? buf.readInt32LE(py + "POS_Y".length) : 0;
    const image = readDefaultInt(buf, "IMAGE", idm, entryEnd);
    const race = readDefaultInt(buf, "RACE", idm, entryEnd);

    out.push({
      type: "mountains",
      id: `${obj.id}#${n}`,
      pos: { x, y },
      ...(w !== null ? { w } : {}),
      ...(h !== null ? { h } : {}),
      ...(image !== null ? { image } : {}),
      ...(race !== null ? { race } : {}),
    });
    n++;
    i = entryEnd;
  }
  return out;
}
