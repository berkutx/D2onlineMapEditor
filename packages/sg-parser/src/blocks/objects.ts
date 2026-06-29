/**
 * Placed-object block readers. Each returns a MapObject (Contract A) or null.
 *
 * Positions are CARTESIAN (POS_X = col, POS_Y = row); iso lives in the renderer.
 * Field tags are taken from the toolsqt D2* block readers (the editor's own read()
 * methods) — no guessed tags. A block whose TypeName has no reader degrades to
 * GenericObject (kept renderable/round-trippable, never drawn with a fabricated key).
 */

import {
  ByteBuffer,
  readDefaultInt,
  readDefaultString,
  readAllStrings,
} from "../bytebuffer.js";
import type { FramedObject } from "../framing.js";
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
  // SUBRACE -> MidSubRace (faction/banner); INSIDE -> the fort this stack garrisons.
  // A garrisoned stack draws NOTHING (the editor's StackObjectAccessor returns early).
  const subRace = refOrUndef(readDefaultString(buf, "SUBRACE", f, e));
  const inside = refOrUndef(readDefaultString(buf, "INSIDE", f, e));
  const order = readDefaultInt(buf, "ORDER", f, e); // 1=Normal..3=Guard (D2Stack::Order)
  return {
    type: "stack",
    id: obj.id,
    pos: pos(buf, obj),
    ...(owner ? { owner } : {}),
    ...(leaderUnitId ? { leaderUnitId } : {}),
    ...(banner ? { banner } : {}),
    ...(subRace ? { subRace } : {}),
    ...(inside ? { garrisoned: true } : {}),
    ...(facing !== null ? { facing } : {}),
    ...(order !== null ? { order } : {}),
    units,
  };
}

/** MidVillage: a town/fort (uid prefix FT, disambiguated by TypeName). SIZE = tier.
 *  `race` is NOT set here: the editor's sprite race is the OWNER player's race
 *  (Grace), resolved in assemble.ts's post-pass — SUBRACE is the banner/faction. */
export function readVillage(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const owner = refOrUndef(readDefaultString(buf, "OWNER", f, e));
  const subRace = refOrUndef(readDefaultString(buf, "SUBRACE", f, e));
  const name = readDefaultString(buf, "NAME_TXT", f, e) ?? "";
  const desc = readDefaultString(buf, "DESC_TXT", f, e);
  const tier = readDefaultInt(buf, "SIZE", f, e) ?? 1;
  const priority = readDefaultInt(buf, "AIPRIORITY", f, e);
  const morale = readDefaultInt(buf, "MORALE", f, e);
  const regen = readDefaultInt(buf, "REGEN_B", f, e);
  const growth = readDefaultInt(buf, "GROWTH_T", f, e);
  return {
    type: "village",
    id: obj.id,
    pos: pos(buf, obj),
    ...(owner ? { owner } : {}),
    ...(subRace ? { subRace } : {}),
    name,
    ...(desc ? { desc } : {}),
    tier,
    ...(priority !== null ? { priority } : {}),
    ...(morale !== null ? { morale } : {}),
    ...(regen !== null ? { regen } : {}),
    ...(growth !== null ? { growth } : {}),
  };
}

/** Capital: a player capital city (uid prefix FT, TypeName "Capital").
 *  Like villages, `race` comes from the OWNER player's race (Grace), not SUBRACE
 *  — the editor sets FortObject.raceId = player.raceId (MapConverter.cpp). Resolved
 *  in assemble.ts's post-pass. */
export function readCapital(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const owner = refOrUndef(readDefaultString(buf, "OWNER", f, e));
  const subRace = refOrUndef(readDefaultString(buf, "SUBRACE", f, e));
  const name = readDefaultString(buf, "NAME_TXT", f, e) ?? "";
  return {
    type: "capital",
    id: obj.id,
    pos: pos(buf, obj),
    ...(owner ? { owner } : {}),
    ...(subRace ? { subRace } : {}),
    name,
  };
}

/** MidRuin: a lootable ruin (D2Ruin). TITLE=name, IMAGE=index, LOOTER=looter id
 *  ("000000" until taken). A looted ruin shows the destroyed sprite at image+100
 *  (documented in ObjectAccessors.cpp as "+100 to destructed"). */
export function readRuin(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const name = readDefaultString(buf, "TITLE", f, e) ?? "";
  const desc = readDefaultString(buf, "DESC", f, e);
  const image = readDefaultInt(buf, "IMAGE", f, e);
  const looter = readDefaultString(buf, "LOOTER", f, e);
  const looted = !!looter && looter !== "000000" && looter !== NULL_ID;
  const reward = readDefaultString(buf, "CASH", f, e); // "G####:R####:Y####:E####:W####:B####"
  const item = refOrUndef(readDefaultString(buf, "ITEM", f, e)); // single artifact ("000000" = none)
  const priority = readDefaultInt(buf, "AIPRIORITY", f, e);
  return {
    type: "ruin",
    id: obj.id,
    pos: pos(buf, obj),
    name,
    ...(desc ? { desc } : {}),
    ...(image !== null ? { image } : {}),
    looted,
    ...(looter ? { looter } : {}),
    ...(reward ? { reward } : {}),
    ...(item ? { item } : {}),
    ...(priority !== null ? { priority } : {}),
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

/** MidBag (D2Bag): a treasure bag/chest. POS_X/Y + IMAGE; the editor's key is
 *  "G000BG0000" + (isWater ? 0 : 1) + image(2) (TreasureObjectAccessor). */
export function readTreasure(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const image = readDefaultInt(buf, "IMAGE", f, e);
  const priority = readDefaultInt(buf, "AIPRIORITY", f, e);
  const items = readAllStrings(buf, "ITEM_ID", f, e).filter((s) => s && s !== NULL_ID && s !== "000000");
  return {
    type: "treasure",
    id: obj.id,
    pos: pos(buf, obj),
    ...(image !== null ? { image } : {}),
    ...(priority !== null ? { priority } : {}),
    items, // always present (possibly empty) so add/clear round-trips have a stable shape
  };
}

/** MidRod (D2Rod): a mana-rod marker. OWNER -> player; the editor keys the sprite
 *  off the OWNER player's race (G000RR<rodRaceID>RROD8), resolved in the post-pass. */
export function readRod(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const owner = refOrUndef(readDefaultString(buf, "OWNER", f, e));
  return {
    type: "rod",
    id: obj.id,
    pos: pos(buf, obj),
    ...(owner ? { owner } : {}),
  };
}

/** MidTomb (D2Tomb): a graveyard marker. Constant sprite G000TB0000G (no race). */
export function readTomb(buf: ByteBuffer, obj: FramedObject): MapObject {
  return {
    type: "tomb",
    id: obj.id,
    pos: pos(buf, obj),
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
