/**
 * Satellite-block readers (Stage D of the no-raw-bytes program): per-player state + playthrough
 * logs — MidgardMapFog, PlayerKnownSpells, PlayerBuildings, MidTalismanCharges, MidStackDestroyed,
 * MidQuestLog, MidSpellCast, MidSpellEffects, TurnSummary. Full ports of the reference's D2*.h
 * (field order byte-verified on the pristine corpus).
 *
 * Entry lists are read with STRICT AT-CURSOR tag matches (fields are strictly sequential on
 * disk) — indexOf scanning false-matches when a value's length byte or text forms a tag
 * (the DEBUNKW/SUBRACE_ID lesson).
 */

import { ByteBuffer, stripTrailingNul } from "../bytebuffer.js";
import type { FramedObject } from "../framing.js";
import type {
  FogInfo, PlayerSpellsInfo, PlayerBuildingsInfo, TalismanChargesInfo, StackDestroyedInfo,
  QuestLogInfo, SpellCastInfo, SpellEffectsInfo, TurnSummaryInfo, TurnSummaryEntry,
} from "@d2/map-schema";

/** A strict sequential cursor: every read expects its tag AT the current position. */
class Cursor {
  constructor(private buf: ByteBuffer, public at: number, private end: number) {}
  /** True if `tag` sits exactly at the cursor. */
  peek(tag: string): boolean {
    return this.at + tag.length <= this.end && this.buf.asciiSlice(this.at, this.at + tag.length) === tag;
  }
  int(tag: string): number {
    if (!this.peek(tag)) throw new Error(`satellite reader: expected ${tag} at ${this.at}`);
    const v = this.buf.readInt32LE(this.at + tag.length);
    this.at += tag.length + 4;
    return v;
  }
  /** Length-prefixed CP1251 string (covers both plain strings and 10-char id refs). */
  str(tag: string): string {
    if (!this.peek(tag)) throw new Error(`satellite reader: expected ${tag} at ${this.at}`);
    const len = this.buf.readInt32LE(this.at + tag.length);
    const start = this.at + tag.length + 4;
    const v = stripTrailingNul(this.buf.cp1251Slice(start, start + len));
    this.at = start + len;
    return v;
  }
  bool(tag: string): boolean {
    if (!this.peek(tag)) throw new Error(`satellite reader: expected ${tag} at ${this.at}`);
    const v = this.buf.bytes[this.at + tag.length] !== 0;
    this.at += tag.length + 1;
    return v;
  }
  /** `n` untagged raw bytes (the fog row mask). */
  blob(n: number): number[] {
    const out = Array.from(this.buf.bytes.slice(this.at, this.at + n));
    this.at += n;
    return out;
  }
}

/** Position the cursor right AFTER the block's own-id count tag + int32; returns the count.
 *  The count field's tag is the FULL versioned id (e.g. "S143FG0000") == obj.id. */
function openCountList(buf: ByteBuffer, obj: FramedObject): { count: number; cur: Cursor } {
  const i = buf.indexOf(obj.id, obj.fieldsFrom);
  if (i < 0 || i >= obj.fieldsEnd) return { count: 0, cur: new Cursor(buf, obj.fieldsEnd, obj.fieldsEnd) };
  const count = buf.readInt32LE(i + obj.id.length);
  return { count, cur: new Cursor(buf, i + obj.id.length + 4, obj.fieldsEnd) };
}

/** MidgardMapFog: count + N×{POS_Y(int) · FOG(int=byteCount) · byteCount untagged mask bytes}. */
export function readFog(buf: ByteBuffer, obj: FramedObject): FogInfo {
  const { count, cur } = openCountList(buf, obj);
  const rows: FogInfo["rows"] = [];
  for (let i = 0; i < count; i++) {
    const y = cur.int("POS_Y");
    const n = cur.int("FOG");
    rows.push({ y, mask: cur.blob(n) });
  }
  return { id: obj.id, rows };
}

/** PlayerKnownSpells: count + N×SPELL_ID (length-prefixed global spell ids). */
export function readPlayerSpells(buf: ByteBuffer, obj: FramedObject): PlayerSpellsInfo {
  const { count, cur } = openCountList(buf, obj);
  const spells: string[] = [];
  for (let i = 0; i < count; i++) spells.push(cur.str("SPELL_ID"));
  return { id: obj.id, spells };
}

/** PlayerBuildings: count + N×BUILD_ID (length-prefixed global building ids). */
export function readPlayerBuildings(buf: ByteBuffer, obj: FramedObject): PlayerBuildingsInfo {
  const { count, cur } = openCountList(buf, obj);
  const buildings: string[] = [];
  for (let i = 0; i < count; i++) buildings.push(cur.str("BUILD_ID"));
  return { id: obj.id, buildings };
}

/** MidTalismanCharges: count + N×{ID_TALIS(ref to MidItem instance) · CHARGES(int)}. */
export function readTalismanCharges(buf: ByteBuffer, obj: FramedObject): TalismanChargesInfo {
  const { count, cur } = openCountList(buf, obj);
  const entries: TalismanChargesInfo["entries"] = [];
  for (let i = 0; i < count; i++) {
    const talisman = cur.str("ID_TALIS");
    const charges = cur.int("CHARGES");
    entries.push({ talisman, charges });
  }
  return { id: obj.id, entries };
}

/** MidStackDestroyed: count + N×{ID_STACK · ID_KILLER · SRCTMPL_ID} (refs, verbatim). */
export function readStackDestroyed(buf: ByteBuffer, obj: FramedObject): StackDestroyedInfo {
  const { count, cur } = openCountList(buf, obj);
  const entries: StackDestroyedInfo["entries"] = [];
  for (let i = 0; i < count; i++) {
    const stack = cur.str("ID_STACK");
    const killer = cur.str("ID_KILLER");
    const srcTemplate = cur.str("SRCTMPL_ID");
    entries.push({ stack, killer, srcTemplate });
  }
  return { id: obj.id, entries };
}

/** MidQuestLog: count + N×{ID_PLAYER · SEQ_NUM · CUR_TURN · TYPE · ID_EVENT · EFF_NUM}. */
export function readQuestLog(buf: ByteBuffer, obj: FramedObject): QuestLogInfo {
  const { count, cur } = openCountList(buf, obj);
  const entries: QuestLogInfo["entries"] = [];
  for (let i = 0; i < count; i++) {
    const player = cur.str("ID_PLAYER");
    const seqNum = cur.int("SEQ_NUM");
    const curTurn = cur.int("CUR_TURN");
    const type = cur.int("TYPE");
    const event = cur.str("ID_EVENT");
    const effNum = cur.int("EFF_NUM");
    entries.push({ player, seqNum, curTurn, type, event, effNum });
  }
  return { id: obj.id, entries };
}

/** MidSpellCast: TWO ints, both tagged with the block's own id (semantics unknown, 0 authored). */
export function readSpellCast(buf: ByteBuffer, obj: FramedObject): SpellCastInfo {
  const i1 = buf.indexOf(obj.id, obj.fieldsFrom);
  if (i1 < 0 || i1 >= obj.fieldsEnd) return { id: obj.id, v1: 0, v2: 0 };
  const v1 = buf.readInt32LE(i1 + obj.id.length);
  const at2 = i1 + obj.id.length + 4;
  const cur = new Cursor(buf, at2, obj.fieldsEnd);
  const v2 = cur.peek(obj.id) ? cur.int(obj.id) : 0;
  return { id: obj.id, v1, v2 };
}

/** MidSpellEffects: ONE int tagged with the block's own id. */
export function readSpellEffects(buf: ByteBuffer, obj: FramedObject): SpellEffectsInfo {
  const i = buf.indexOf(obj.id, obj.fieldsFrom);
  const v = i >= 0 && i < obj.fieldsEnd ? buf.readInt32LE(i + obj.id.length) : 0;
  return { id: obj.id, v };
}

/**
 * TurnSummary: count + N variant entries — fixed head {ID_PLAYER · TYPE · POS_X · POS_Y} then a
 * TYPE-selected payload (see TurnSummaryEntry). Type 3's ID_CITY is read AND written (the
 * reference's data() forgets it — a reference bug we don't replicate).
 */
export function readTurnSummary(buf: ByteBuffer, obj: FramedObject): TurnSummaryInfo {
  const { count, cur } = openCountList(buf, obj);
  const entries: TurnSummaryEntry[] = [];
  for (let i = 0; i < count; i++) {
    const player = cur.str("ID_PLAYER");
    const type = cur.int("TYPE");
    const x = cur.int("POS_X");
    const y = cur.int("POS_Y");
    const e: TurnSummaryEntry = { player, type, x, y };
    if (type === 0) {
      e.player2 = cur.str("ID_PLAYER2");
      e.spell = cur.str("ID_SPELL");
      e.stackD = cur.str("ID_STK_D");
      e.strStackD = cur.str("STR_STK_D");
    } else if (type === 1) {
      e.player2 = cur.str("ID_PLAYER2");
      e.stackA = cur.str("ID_STK_A");
      e.strStackA = cur.str("STR_STK_A");
      e.stackD = cur.str("ID_STK_D");
      e.strStackD = cur.str("STR_STK_D");
    } else if (type === 2 || type === 5) {
      e.stackD = cur.str("ID_STK_D");
      e.strStackD = cur.str("STR_STK_D");
    } else if (type === 3) {
      e.city = cur.str("ID_CITY");
    } else if (type === 6) {
      e.stackD = cur.str("ID_STK_D");
      e.strStackD = cur.str("STR_STK_D");
      e.acquire = cur.bool("ACQUIRE");
    } // type 4: no payload
    entries.push(e);
  }
  return { id: obj.id, entries };
}
