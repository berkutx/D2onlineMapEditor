/**
 * MidEvent reader — a SEQUENTIAL cursor parse (unlike the tag-scan readers used for other
 * blocks) because an event repeats the same tags across its conditions/effects (ID_LOC,
 * ID_PLAYER1, …), so only in-order reading resolves each occurrence. Ported 1:1 from toolsqt
 * D2Event.h read(); the per-type field order/tags come from the shared eventCodec table.
 */

import { ByteBuffer, stripTrailingNul } from "../bytebuffer.js";
import type { FramedObject } from "../framing.js";
import type { MapEvent, EventCondition, EventEffect, ScenarioVariable, StackTemplate, TemplateUnit } from "@d2/map-schema";
import { CONDITION_BY_CODE, EFFECT_BY_CODE, normalizeAudioRef } from "@d2/map-schema";
import {
  COND_CODEC,
  EFF_CODEC,
  EMPTY_REF,
  POPUP_SHOW_TO_INT,
  type CodecField,
} from "./eventCodec.js";

/** In-order reader over one event's [from, end) byte range. */
class Cursor {
  p: number;
  constructor(private readonly buf: ByteBuffer, from: number, readonly end: number) {
    this.p = from;
  }
  /** Position after `tag` at/after the cursor (within range), or -1; does not move on miss. */
  private seek(tag: string): number {
    const i = this.buf.indexOf(tag, this.p);
    if (i < 0 || i >= this.end) return -1;
    return i + tag.length;
  }
  int(tag: string): number {
    const at = this.seek(tag);
    if (at < 0 || at + 4 > this.buf.length) return 0;
    this.p = at + 4;
    return this.buf.readInt32LE(at);
  }
  bool(tag: string): boolean {
    const at = this.seek(tag);
    if (at < 0 || at + 1 > this.buf.length) return false;
    this.p = at + 1;
    return this.buf.bytes[at] !== 0;
  }
  str(tag: string): string {
    const at = this.seek(tag);
    if (at < 0 || at + 4 > this.buf.length) return "";
    const len = this.buf.readInt32LE(at);
    const from = at + 4;
    if (len < 0 || from + len > this.buf.length) return "";
    this.p = from + len;
    return stripTrailingNul(this.buf.cp1251Slice(from, from + len));
  }
  /** Raw CP1251 slice of `len` bytes at the cursor (no tag), for script bodies. */
  raw(len: number): string {
    const from = this.p;
    if (len < 0 || from + len > this.buf.length) return "";
    this.p = from + len;
    return stripTrailingNul(this.buf.cp1251Slice(from, from + len));
  }
  skipPast(tag: string): void {
    const at = this.seek(tag);
    if (at >= 0) this.p = at;
  }
}

const refNorm = (s: string): string => (s === EMPTY_REF ? "" : s);

/** Read one codec field into `out`. */
function readField(c: Cursor, fld: CodecField, out: Record<string, unknown>): void {
  switch (fld.io) {
    case "int": out[fld.key] = c.int(fld.tag); break;
    case "bool": out[fld.key] = c.bool(fld.tag); break;
    case "ref": out[fld.key] = refNorm(c.str(fld.tag)); break;
    case "str": out[fld.key] = c.str(fld.tag); break;
    case "audioStr": out[fld.key] = normalizeAudioRef(c.str(fld.tag)); break; // bare SOUND/MUSIC name
    case "existInt": out[fld.key] = c.int(fld.tag) === 0; break; // MISC_INT 0 => mustExist
    case "popupShow": out[fld.key] = POPUP_SHOW_TO_INT[c.str(fld.tag)] ?? 0; break;
  }
}

function readCondition(c: Cursor, code: number): EventCondition | null {
  const spec = CONDITION_BY_CODE[code];
  if (!spec) return null; // unknown/custom condition category — skip (rare)
  const out: Record<string, unknown> = { kind: spec.kind };
  if (spec.kind === "customScript") {
    const codeLen = c.int("CODE_LEN");
    c.skipPast("CODE");
    c.p += 4; // int32 length prefix of the CODE string
    out.code = c.raw(codeLen);
    const descLen = c.int("DESCR_LEN");
    c.skipPast("DESCR");
    c.p += 4;
    out.desc = c.raw(descLen);
  } else {
    for (const fld of COND_CODEC[spec.kind]!.fields) readField(c, fld, out);
  }
  return out as EventCondition;
}

function readEffect(c: Cursor, code: number, eventId: string): EventEffect | null {
  const spec = EFFECT_BY_CODE[code];
  if (!spec) return null;
  const num = c.int("NUM");
  const out: Record<string, unknown> = { kind: spec.kind, num };
  if (spec.kind === "changeFog") {
    out.locId = refNorm(c.str("ID_LOC"));
    const count = c.int(eventId); // count tag == the event's own compound id
    const entries: { eventId: string; player: string }[] = [];
    for (let i = 0; i < count; i++) {
      entries.push({ eventId: refNorm(c.str("EVENT_ID")), player: refNorm(c.str("PLAYER")) });
    }
    out.entries = entries;
    out.enable = c.bool("ENABLE");
    out.value = c.int("NUMVALUE");
  } else {
    for (const fld of EFF_CODEC[spec.kind]!.fields) readField(c, fld, out);
  }
  return out as EventEffect;
}

/**
 * Parse the singleton MidScenVariables block: the count (tag == the block's own compound id)
 * then N × (ID:int32, NAME:len-string, VALUE:int32). Byte-verified on Riders (count tag =
 * "S143SV0000"; entries like {1,"QUEST",0}). There is NO inner "ID" ref field before the count.
 */
export function readScenVariables(buf: ByteBuffer, obj: FramedObject): ScenarioVariable[] {
  const c = new Cursor(buf, obj.fieldsFrom, obj.fieldsEnd);
  const count = c.int(obj.id);
  const out: ScenarioVariable[] = [];
  for (let i = 0; i < count; i++) {
    const id = c.int("ID");
    const name = c.str("NAME");
    const value = c.int("VALUE");
    out.push({ id, name, value });
  }
  return out;
}

/**
 * Parse one MidStackTemplate block. Byte-verified on Riders (D2StackTemplate.h): inner ID,
 * OWNER, LEADER(Gunit), LEADER_LVL, NAME_TXT, ORDER_TARG, SUBRACE, ORDER, interleaved
 * UNIT_i(Gunit)/UNIT_i_LVL ×6, POS_i ×6, USE_FACING(bool), FACING(int), modifier list
 * (count tag == the block's own id; per mod UNIT_POS:int + MODIF_ID:Gmodif ref), AIPRIORITY.
 * Units are resolved from the UNIT_/POS_ packing into the 6 FORMATION CELLS (cell i = slot POS_i).
 */
export function readStackTemplate(buf: ByteBuffer, obj: FramedObject): StackTemplate {
  const c = new Cursor(buf, obj.fieldsFrom, obj.fieldsEnd);
  const owner = refNorm(c.str("OWNER"));
  const leader = refNorm(c.str("LEADER"));
  const leaderLevel = c.int("LEADER_LVL");
  const name = c.str("NAME_TXT");
  const orderTarget = refNorm(c.str("ORDER_TARG"));
  const subRace = refNorm(c.str("SUBRACE"));
  const order = c.int("ORDER");
  const slotUnits: string[] = [];
  const slotLevels: number[] = [];
  for (let i = 0; i < 6; i++) {
    slotUnits.push(refNorm(c.str(`UNIT_${i}`)));
    slotLevels.push(c.int(`UNIT_${i}_LVL`));
  }
  const pos: number[] = [];
  for (let i = 0; i < 6; i++) pos.push(c.int(`POS_${i}`));
  const useFacing = c.bool("USE_FACING");
  const facing = c.int("FACING");
  const modCount = c.int(obj.id); // count tag == the block's own compound id
  const modifiers: { unitPos: number; modifId: string }[] = [];
  for (let i = 0; i < modCount; i++) {
    modifiers.push({ unitPos: c.int("UNIT_POS"), modifId: refNorm(c.str("MODIF_ID")) });
  }
  const aiPriority = c.int("AIPRIORITY");

  // The SLOTS are the template's persisted layout (the reference's D2StackTemplate stores
  // exactly unit[6]+pos[6]); `units` is the DERIVED cell view the UI edits (cell i = slot
  // POS_i's unit). MEASURED: 919/2656 shipped templates carry ORPHAN slots (filled UNIT_s no
  // POS_i points at — editing leftovers), so the cells alone cannot reproduce the layout.
  const slots: (TemplateUnit | null)[] = slotUnits.map((u, s) =>
    u ? { unit: u, level: slotLevels[s] ?? 0 } : null,
  );
  const units: (TemplateUnit | null)[] = [null, null, null, null, null, null];
  for (let cell = 0; cell < 6; cell++) {
    const slot = pos[cell]!;
    if (slot >= 0 && slot < 6 && slotUnits[slot]) {
      units[cell] = { unit: slotUnits[slot]!, level: slotLevels[slot] ?? 1 };
    }
  }
  // PROVISIONAL big flag: a shared slot (POS_i == POS_(i^1)) means the two column cells hold ONE
  // slot entry. That is a genuine 2-cell big unit when the unit is LARGE — but the reference ALSO
  // dedups two IDENTICAL SMALL units into one slot, so slot-sharing alone over-includes those.
  // We flag both cells `big` here (no unit-size DB at parse time); the re-pack keeps a shared slot
  // one slot either way (lossless — both cells read the same level), and the UI refines big by
  // unit SIZE so identical smalls show as two cells. Pairs = (0,1)/(2,3)/(4,5), like the garrison.
  for (let cell = 0; cell < 6; cell++) {
    const partner = cell ^ 1;
    if (units[cell] && units[partner] && pos[cell]! >= 0 && pos[cell] === pos[partner]) {
      units[cell]!.big = true;
    }
  }
  return {
    id: obj.id, name, owner, leader, leaderLevel, orderTarget, subRace, order, units,
    useFacing, facing, aiPriority, modifiers,
    slots, slotOfCell: pos,
  };
}

/** Parse a single MidEvent block into a MapEvent. `isEES` gates the elf-expansion race flags. */
export function readEvent(buf: ByteBuffer, obj: FramedObject, isEES: boolean): MapEvent {
  const c = new Cursor(buf, obj.fieldsFrom, obj.fieldsEnd);
  const name = c.str("NAME_TXT");
  const appliesTo = {
    human: c.bool("HUMAN"), dwarf: c.bool("DWARF"), undead: c.bool("UNDEAD"),
    heretic: c.bool("HERETIC"), neutral: c.bool("NEUTRAL"), elf: isEES ? c.bool("ELF") : false,
  };
  const canTrigger = {
    human: c.bool("VERHUMAN"), dwarf: c.bool("VERDWARF"), undead: c.bool("VERUNDEAD"),
    heretic: c.bool("VERHERETIC"), neutral: c.bool("VERNEUTRAL"), elf: isEES ? c.bool("VERELF") : false,
  };
  const enabled = c.bool("ENABLED");
  const occurOnce = c.bool("OCCUR_ONCE");
  const chance = c.int("CHANCE");
  const order = c.int("ORDER");

  const conditions: EventCondition[] = [];
  const condQty = c.int("COND_QTY");
  for (let i = 0; i < condQty; i++) {
    const cat = c.int("CATEGORY");
    const cond = readCondition(c, cat);
    if (cond) conditions.push(cond);
  }
  const effects: EventEffect[] = [];
  const effQty = c.int("EFFECT_QTY");
  for (let i = 0; i < effQty; i++) {
    const cat = c.int("CATEGORY");
    const eff = readEffect(c, cat, obj.id);
    if (eff) effects.push(eff);
  }

  return { id: obj.id, name, enabled, occurOnce, chance, order, appliesTo, canTrigger, conditions, effects };
}
