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
import type { MapHeader, PlayerInfo } from "@d2/map-schema";

export interface ScenarioInfo {
  size: number;
  header: MapHeader;
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

  const header: MapHeader = {
    name,
    description,
    author,
    version: "",
    size,
    ...(scenario !== null && game !== null
      ? { difficulty: { scenario, game } }
      : {}),
  };
  return { size, header };
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
