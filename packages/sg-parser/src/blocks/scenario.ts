/**
 * ScenarioInfo + MidPlayer readers.
 *
 * ScenarioInfo TypeName is "ScenarioInfo" (no Mid prefix). Verified fields:
 *  MAP_SIZE (int), NAME (str), DESC (str), DIFFSCEN/DIFFGAME (int), QTY_CITIES.
 * MidPlayer fields: PLAYER_ID, NAME_TXT, RACE_ID (compound, race in 4-hex),
 *  IS_HUMAN (bool flag), ATTITUDE.
 */

import {
  ByteBuffer,
  readDefaultInt,
  readDefaultString,
  readDefaultBool,
} from "../bytebuffer.js";
import type { FramedObject } from "../framing.js";
import { parseCompoundId } from "../framing.js";
import type { MapHeader, PlayerInfo, DiplomacyEntry } from "@d2/map-schema";

export interface ScenarioInfo {
  size: number;
  header: MapHeader;
}

/**
 * One part of a '_'-multi-part string (D2ScenarioInfo readMultyStringPart): "." means empty,
 * a trailing '_' is the continuation marker and is stripped; parts are then joined in order.
 */
function multiPart(s: string | null): string {
  if (!s || s === ".") return "";
  return s.endsWith("_") ? s.slice(0, -1) : s;
}

export function readScenarioInfo(buf: ByteBuffer, obj: FramedObject): ScenarioInfo | null {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const size = readDefaultInt(buf, "MAP_SIZE", f, e);
  if (size === null || size <= 0) return null;

  const name = readDefaultString(buf, "NAME", f, e) ?? "";
  const description = readDefaultString(buf, "DESC", f, e) ?? "";
  const author = readDefaultString(buf, "CREATOR", f, e) ?? "";
  const scenario = readDefaultInt(buf, "DIFFSCEN", f, e);
  const game = readDefaultInt(buf, "DIFFGAME", f, e);

  // scenario texts: BRIEFING (short objective), BRIEFLONG1-5 (story), DEBUNKW+W2-5 (victory),
  // DEBUNKL (defeat). The long ones use the '_' multi-part convention.
  const objective = readDefaultString(buf, "BRIEFING", f, e) ?? "";
  const story = ["BRIEFLONG1", "BRIEFLONG2", "BRIEFLONG3", "BRIEFLONG4", "BRIEFLONG5"]
    .map((t) => multiPart(readDefaultString(buf, t, f, e)))
    .join("");
  const winText = ["DEBUNKW", "DEBUNKW2", "DEBUNKW3", "DEBUNKW4", "DEBUNKW5"]
    .map((t) => multiPart(readDefaultString(buf, t, f, e)))
    .join("");
  const loseText = readDefaultString(buf, "DEBUNKL", f, e) ?? "";

  const maxUnit = readDefaultInt(buf, "MAX_UNIT", f, e);
  const maxSpell = readDefaultInt(buf, "MAX_SPELL", f, e);
  const maxLeader = readDefaultInt(buf, "MAX_LEADER", f, e);
  const maxCity = readDefaultInt(buf, "MAX_CITY", f, e);
  const suggestedLevel = readDefaultInt(buf, "SUGG_LVL", f, e);
  const seed = readDefaultInt(buf, "MAP_SEED", f, e);

  const header: MapHeader = {
    name,
    description,
    author,
    version: "",
    size,
    ...(scenario !== null && game !== null
      ? { difficulty: { scenario, game } }
      : {}),
    ...(suggestedLevel !== null ? { suggestedLevel } : {}),
    ...(seed !== null ? { seed } : {}),
    objective,
    story,
    winText,
    loseText,
    ...(maxUnit !== null && maxSpell !== null && maxLeader !== null && maxCity !== null
      ? { limits: { unit: maxUnit, spell: maxSpell, leader: maxLeader, city: maxCity } }
      : {}),
  };
  return { size, header };
}

/**
 * MidDiplomacy (code 0x14, short DP, singleton): count (tag == the block's own compound id)
 * then N × (RACE_1:int, RACE_2:int, RELATION:int). Race values are Grace indices; RELATION
 * is kept as the raw int32 (0..100 meter; any high-bit flags preserved).
 * Byte-verified on Riders: 3 entries (4-0, 4-1, 0-1), relation 0.
 */
export function readDiplomacy(buf: ByteBuffer, obj: FramedObject): DiplomacyEntry[] {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const count = readDefaultInt(buf, obj.id, f, e) ?? 0;
  const out: DiplomacyEntry[] = [];
  // entries are back-to-back; walk sequentially from the count value
  let p = buf.indexOf(obj.id, f);
  if (p < 0) return out;
  p += obj.id.length + 4;
  for (let i = 0; i < count; i++) {
    const r1 = buf.indexOf("RACE_1", p);
    if (r1 < 0 || r1 >= e) break;
    const race1 = buf.readInt32LE(r1 + 6);
    const r2 = buf.indexOf("RACE_2", r1 + 10);
    if (r2 < 0 || r2 >= e) break;
    const race2 = buf.readInt32LE(r2 + 6);
    const rl = buf.indexOf("RELATION", r2 + 10);
    if (rl < 0 || rl >= e) break;
    const relation = buf.readInt32LE(rl + 8);
    out.push({ race1, race2, relation });
    p = rl + 12;
  }
  return out;
}

/**
 * Player. `playerNo` and `race` are derived from the RACE_ID/PLAYER_ID compound
 * 4-hex indices. IS_HUMAN is a presence-only bool flag.
 */
export function readPlayer(buf: ByteBuffer, obj: FramedObject): PlayerInfo {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const id = readDefaultString(buf, "PLAYER_ID", f, e) ?? obj.id;
  const name = readDefaultString(buf, "NAME_TXT", f, e) ?? "";
  const raceId = readDefaultString(buf, "RACE_ID", f, e);
  const parsedPlayer = parseCompoundId(id);
  const parsedRace = raceId ? parseCompoundId(raceId) : null;
  const isHuman = readDefaultBool(buf, "IS_HUMAN", f, e);

  return {
    id,
    playerNo: parsedPlayer ? parsedPlayer.index : 0,
    race: parsedRace ? parsedRace.index : 0,
    name,
    isHuman,
  };
}
