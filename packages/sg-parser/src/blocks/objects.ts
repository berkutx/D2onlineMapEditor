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

/** Read a fort/stack garrison formation. The .sg stores TWO PARALLEL arrays: UNIT_0..5 =
 *  the units in INSERTION order (slot index, NOT cell), and POS_0..5 where POS_i = the index
 *  into UNIT_ of the unit occupying FORMATION CELL i (-1 = empty cell). So **cell i = UNIT_[POS_i]**.
 *  (Verified verbatim vs D2RSG group.cpp serialize() + D2ModdingToolset unitslotview: even cell =
 *  front line, odd = back; column = cell/2.) Returns a 6-element array indexed by FORMATION CELL ->
 *  instance id (null = empty cell). */
function readGarrison(buf: ByteBuffer, f: number, e: number): (string | null)[] {
  const units: (string | null)[] = [];
  for (let i = 0; i < 6; i++) units.push(refOrUndef(readDefaultString(buf, `UNIT_${i}`, f, e)) ?? null);
  const cells: (string | null)[] = [null, null, null, null, null, null];
  for (let i = 0; i < 6; i++) {
    const pos = readDefaultInt(buf, `POS_${i}`, f, e);
    if (pos !== null && pos >= 0 && pos < 6) cells[i] = units[pos] ?? null;
  }
  return cells;
}

/** A cursor over contiguous site-stock entries. After the literal QTY_* int32, the count
 *  entries are written back-to-back; we walk them by tag. Returns null if the tag mismatches. */
function readStrAt(buf: ByteBuffer, p: number, tag: string): { value: string; next: number } | null {
  if (buf.asciiSlice(p, p + tag.length) !== tag) return null;
  p += tag.length;
  const len = buf.readInt32LE(p);
  p += 4;
  const value = buf.asciiSlice(p, p + Math.max(0, len - 1)); // compound ids are ASCII; drop the NUL
  return { value, next: p + len };
}
function readIntAt(buf: ByteBuffer, p: number, tag: string): { value: number; next: number } | null {
  if (buf.asciiSlice(p, p + tag.length) !== tag) return null;
  return { value: buf.readInt32LE(p + tag.length), next: p + tag.length + 4 };
}
function readBoolAt(buf: ByteBuffer, p: number, tag: string): { value: boolean; next: number } | null {
  if (buf.asciiSlice(p, p + tag.length) !== tag) return null;
  return { value: buf.bytes[p + tag.length] !== 0, next: p + tag.length + 1 };
}

/** Merchant stock: QTY_ITEM count, then [ITEM_ID(global) + ITEM_COUNT] × N. */
function readMerchantItems(buf: ByteBuffer, f: number, e: number): { id: string; count: number }[] {
  const at = buf.indexOf("QTY_ITEM", f);
  if (at < 0 || at >= e) return [];
  let p = at + "QTY_ITEM".length;
  const count = buf.readInt32LE(p);
  p += 4;
  const out: { id: string; count: number }[] = [];
  for (let i = 0; i < count; i++) {
    const id = readStrAt(buf, p, "ITEM_ID");
    if (!id) break;
    const qty = readIntAt(buf, id.next, "ITEM_COUNT");
    if (!qty) break;
    out.push({ id: id.value, count: qty.value });
    p = qty.next;
  }
  return out;
}

/** Mage stock: QTY_SPELL count, then [SPELL_ID(global)] × N. */
function readMageSpells(buf: ByteBuffer, f: number, e: number): string[] {
  const at = buf.indexOf("QTY_SPELL", f);
  if (at < 0 || at >= e) return [];
  let p = at + "QTY_SPELL".length;
  const count = buf.readInt32LE(p);
  p += 4;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const sp = readStrAt(buf, p, "SPELL_ID");
    if (!sp) break;
    out.push(sp.value);
    p = sp.next;
  }
  return out;
}

/** Mercenary stock: QTY_UNIT count, then [UNIT_ID(global) + UNIT_LEVEL + UNIT_UNIQ] × N. */
function readMercUnits(buf: ByteBuffer, f: number, e: number): { id: string; level: number; unique: boolean }[] {
  const at = buf.indexOf("QTY_UNIT", f);
  if (at < 0 || at >= e) return [];
  let p = at + "QTY_UNIT".length;
  const count = buf.readInt32LE(p);
  p += 4;
  const out: { id: string; level: number; unique: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const id = readStrAt(buf, p, "UNIT_ID");
    if (!id) break;
    const lvl = readIntAt(buf, id.next, "UNIT_LEVEL");
    if (!lvl) break;
    const uniq = readBoolAt(buf, lvl.next, "UNIT_UNIQ");
    if (!uniq) break;
    out.push({ id: id.value, level: lvl.value, unique: uniq.value });
    p = uniq.next;
  }
  return out;
}

/** MidStack: a moving army (D2Stack). Formation = UNIT_0..5 + POS_0..5 (cell-indexed, like a
 *  garrison). LEADER_ID names which UNIT_ instance is the hero — we resolve it to a leaderCell
 *  (0..5) in the post-pass so the leader survives formation edits (instance ids aren't stable).
 *  Leader equipment (TOME/BATTLE/ARTIFACT/BOOTS) + the carried ITEM_ID inventory are read too. */
export function readStack(buf: ByteBuffer, obj: FramedObject): MapObject {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const owner = refOrUndef(readDefaultString(buf, "OWNER", f, e));
  const leaderUnitId = refOrUndef(readDefaultString(buf, "LEADER_ID", f, e)); // temp → leaderCell
  const banner = refOrUndef(readDefaultString(buf, "BANNER", f, e));
  const facing = readDefaultInt(buf, "FACING", f, e); // 8 iso directions 0..7
  const subRace = refOrUndef(readDefaultString(buf, "SUBRACE", f, e));
  const inside = refOrUndef(readDefaultString(buf, "INSIDE", f, e));
  const order = readDefaultInt(buf, "ORDER", f, e); // D2Stack::Order 1=Normal,2=Stand,3=Guard,…
  const morale = readDefaultInt(buf, "MORALE", f, e);
  const move = readDefaultInt(buf, "MOVE", f, e);
  const priority = readDefaultInt(buf, "AIPRIORITY", f, e);
  const creatLvl = readDefaultInt(buf, "CREAT_LVL", f, e);
  // Leader equipment slots — each a global item ref; empty = the "000000"/"G000000000"
  // sentinel. TOME = spellbook, BATTLE1/2 = battle items, ARTIFACT1/2 = artifacts, BOOTS = boots.
  // Only FILLED slots are kept (empty omitted) so the object survives JSON transport (which drops
  // undefined) and an equip edit round-trips key-for-key.
  const equip: Record<string, string> = {};
  for (const [k, tag] of [
    ["tome", "TOME"], ["battle1", "BATTLE1"], ["battle2", "BATTLE2"],
    ["artifact1", "ARTIFACT1"], ["artifact2", "ARTIFACT2"], ["boots", "BOOTS"],
  ] as const) {
    const s = readDefaultString(buf, tag, f, e);
    if (s && s !== NULL_ID && s !== "000000") equip[k] = s;
  }
  return {
    type: "stack",
    id: obj.id,
    pos: pos(buf, obj),
    ...(owner ? { owner } : {}),
    ...(leaderUnitId ? { leaderUnitId } : {}),
    ...(banner ? { banner } : {}),
    ...(subRace ? { subRace } : {}),
    ...(inside ? { garrisoned: true, inside } : {}),
    ...(facing !== null ? { facing } : {}),
    ...(order !== null ? { order } : {}),
    ...(morale !== null ? { morale } : {}),
    ...(move !== null ? { move } : {}),
    ...(priority !== null ? { priority } : {}),
    ...(creatLvl !== null ? { creatLvl } : {}),
    equip,
    // Carried inventory: an ITEM_ID list (MidItem instances → resolved to templates in the
    // post-pass, like a chest). All shipped Riders stacks carry 0, but the structure is real.
    inventory: readAllStrings(buf, "ITEM_ID", f, e).filter((s) => s && s !== NULL_ID && s !== "000000"),
    garrisonRaw: readGarrison(buf, f, e), // by-cell instance ids; resolved to garrison in post-pass
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
  const stackRef = refOrUndef(readDefaultString(buf, "STACK", f, e));
  return {
    type: "village",
    id: obj.id,
    pos: pos(buf, obj),
    ...(owner ? { owner } : {}),
    ...(subRace ? { subRace } : {}),
    name,
    ...(desc !== null ? { desc } : {}), // present-but-empty -> editable; absent -> omit
    tier,
    ...(priority !== null ? { priority } : {}),
    ...(morale !== null ? { morale } : {}),
    ...(regen !== null ? { regen } : {}),
    ...(growth !== null ? { growth } : {}),
    garrisonRaw: readGarrison(buf, f, e), // embedded instance ids; resolved in assemble post-pass
    ...(stackRef ? { stackRef } : {}),
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
  const desc = readDefaultString(buf, "DESC_TXT", f, e);
  const priority = readDefaultInt(buf, "AIPRIORITY", f, e);
  const stackRef = refOrUndef(readDefaultString(buf, "STACK", f, e));
  return {
    type: "capital",
    id: obj.id,
    pos: pos(buf, obj),
    ...(owner ? { owner } : {}),
    ...(subRace ? { subRace } : {}),
    name,
    ...(desc !== null ? { desc } : {}), // present-but-empty -> editable; absent -> omit
    ...(priority !== null ? { priority } : {}),
    garrisonRaw: readGarrison(buf, f, e), // city's OWN defense; resolved in assemble post-pass
    ...(stackRef ? { stackRef } : {}),
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
    // the ruin's guardians (GROUP_ID + UNIT_0..5/POS_0..5 — same embedded-group layout as
    // a fort's defense); resolved instance→impl in the assemble post-pass
    garrisonRaw: readGarrison(buf, f, e),
  };
}

type SiteType = "merchant" | "mage" | "trainer" | "mercenary";

/** MidSite*: shared layout. TXT_TITLE = name, IMG_ISO = image. */
export function readSite(type: SiteType) {
  return (buf: ByteBuffer, obj: FramedObject): MapObject => {
    const { fieldsFrom: f, fieldsEnd: e } = obj;
    const name = readDefaultString(buf, "TXT_TITLE", f, e) ?? "";
    const image = readDefaultInt(buf, "IMG_ISO", f, e);
    // stock list (global template ids) — merchant items, mage spells, mercenary units.
    const stock =
      type === "merchant" ? { items: readMerchantItems(buf, f, e) } :
      type === "mage" ? { spells: readMageSpells(buf, f, e) } :
      type === "mercenary" ? { units: readMercUnits(buf, f, e) } :
      {};
    return {
      type,
      id: obj.id,
      pos: pos(buf, obj),
      name,
      ...(image !== null ? { image } : {}),
      ...stock,
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
  // LEVEL precedes DYNLEVEL in the body so the first "LEVEL" match is the real one; HP is the
  // current hit points (== max for a freshly placed unit).
  const level = readDefaultInt(buf, "LEVEL", f, e);
  const hp = readDefaultInt(buf, "HP", f, e);
  return {
    type: "unit",
    id: obj.id,
    pos: { x: 0, y: 0 }, // units carry no map position; placed via their stack/city
    ...(implId ? { implId } : {}),
    ...(level !== null ? { level } : {}),
    ...(hp !== null ? { hp } : {}),
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
