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
  readBoolValue,
  stripTrailingNul,
} from "../bytebuffer.js";
import type { FramedObject } from "../framing.js";
import { parseCompoundId } from "../framing.js";
import type { MapHeader, PlayerInfo, DiplomacyEntry, SubRaceInfo } from "@d2/map-schema";

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
  // DEBUNKL (defeat). The long ones use the '_' multi-part convention. Parts are read with a
  // MOVING CURSOR (consecutive on disk): a plain indexOf-per-tag false-matches when a value's
  // LENGTH byte forms the next tag (e.g. DEBUNKW len 0x33 = ASCII '3' reads as "DEBUNKW3").
  const objective = readDefaultString(buf, "BRIEFING", f, e) ?? "";
  const readParts = (tags: string[]): string[] => {
    const out: string[] = [];
    let cursor = f;
    for (const t of tags) {
      const i = buf.indexOf(t, cursor);
      if (i < 0 || i >= e) break;
      const lenAt = i + t.length;
      const len = buf.readInt32LE(lenAt);
      if (len < 0 || lenAt + 4 + len > e) break;
      out.push(stripTrailingNul(buf.cp1251Slice(lenAt + 4, lenAt + 4 + len)));
      cursor = lenAt + 4 + len;
    }
    return out;
  };
  // VERBATIM multi-string parts ('_' continuations + boundaries intact = on-disk history);
  // PRESENCE-DRIVEN: old-format maps carry only DEBUNKW — capture exactly what exists.
  const storyParts = readParts(["BRIEFLONG1", "BRIEFLONG2", "BRIEFLONG3", "BRIEFLONG4", "BRIEFLONG5"]);
  const winTextParts = readParts(["DEBUNKW", "DEBUNKW2", "DEBUNKW3", "DEBUNKW4", "DEBUNKW5"]);
  // the joined editor view derives FROM the parts (single source, no re-scan)
  const story = storyParts.map((p) => multiPart(p)).join("");
  const winText = winTextParts.map((p) => multiPart(p)).join("");
  const loseText = readDefaultString(buf, "DEBUNKL", f, e) ?? "";

  const maxUnit = readDefaultInt(buf, "MAX_UNIT", f, e);
  const maxSpell = readDefaultInt(buf, "MAX_SPELL", f, e);
  const maxLeader = readDefaultInt(buf, "MAX_LEADER", f, e);
  const maxCity = readDefaultInt(buf, "MAX_CITY", f, e);
  const suggestedLevel = readDefaultInt(buf, "SUGG_LVL", f, e);
  const seed = readDefaultInt(buf, "MAP_SEED", f, e);

  // ---- full D2ScenarioInfo field set (byte-exact model rebuild) ----
  const campaign = readDefaultString(buf, "CAMPAIGN", f, e);
  const sourceM = readBoolValue(buf, "SOURCE_M", f, e);
  const qtyCities = readDefaultInt(buf, "QTY_CITIES", f, e);
  const curTurn = readDefaultInt(buf, "CUR_TURN", f, e);
  // the single-letter "O" bool sits immediately BEFORE the CUR_TURN tag (indexOf("O") would
  // false-match text bytes, so locate it positionally and verify the tag byte).
  const ct = buf.indexOf("CUR_TURN", f);
  const flagO = ct > f + 1 && ct < e && buf.asciiSlice(ct - 2, ct - 1) === "O"
    ? buf.bytes[ct - 1] !== 0
    : null;
  // PLAYER_1..13 — fixed 13-int list (PLAYER_1 precedes PLAYER_10.. on disk, so the prefix
  // collision resolves positionally).
  const playerSlots: number[] = [];
  for (let i = 1; i <= 13; i++) {
    const v = readDefaultInt(buf, `PLAYER_${i}`, f, e);
    if (v === null) { playerSlots.length = 0; break; }
    playerSlots.push(v);
  }

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
    ...(campaign !== null ? { campaign } : {}),
    ...(sourceM !== null ? { sourceM } : {}),
    ...(qtyCities !== null ? { qtyCities } : {}),
    ...(flagO !== null ? { flagO } : {}),
    ...(curTurn !== null ? { curTurn } : {}),
    ...(playerSlots.length === 13 ? { playerSlots } : {}),
    ...(storyParts.length ? { storyParts } : {}),
    ...(winTextParts.length ? { winTextParts } : {}),
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
 * Player — FULL MidPlayer field set (D2Player.h port, byte-verified on the pristine corpus):
 * PLAYER_ID · NAME_TXT · DESC_TXT · LORD_ID · RACE_ID · FOG_ID · KNOWN_ID · BUILDS_ID · FACE ·
 * QTY_BREAKS · BANK · IS_HUMAN(value bool!) · SPELL_BANK · ATTITUDE · RESEAR_T · CONSTR_T ·
 * SPY_1..3 · CAPT_BY · [ALWAYSAI] · [EXMAPID/TURN 1..3] (version-conditional tails — captured
 * iff present, re-emitted iff captured). `playerNo`/`race` stay derived for the editor.
 * NOTE: IS_HUMAN carries a VALUE byte — the old presence-only read reported every player human.
 */
export function readPlayer(buf: ByteBuffer, obj: FramedObject): PlayerInfo {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  const id = readDefaultString(buf, "PLAYER_ID", f, e) ?? obj.id;
  const name = readDefaultString(buf, "NAME_TXT", f, e) ?? "";
  const raceId = readDefaultString(buf, "RACE_ID", f, e);
  const parsedPlayer = parseCompoundId(id);
  const parsedRace = raceId ? parseCompoundId(raceId) : null;
  const isHuman = readBoolValue(buf, "IS_HUMAN", f, e) ?? false;

  const str = (tag: string) => readDefaultString(buf, tag, f, e);
  const int = (tag: string) => readDefaultInt(buf, tag, f, e);
  const desc = str("DESC_TXT");
  const lordId = str("LORD_ID");
  const fogId = str("FOG_ID");
  const knownId = str("KNOWN_ID");
  const buildsId = str("BUILDS_ID");
  const face = int("FACE");
  const qtyBreaks = int("QTY_BREAKS");
  const bank = str("BANK");
  const spellBank = str("SPELL_BANK");
  const attitude = int("ATTITUDE");
  const researchT = int("RESEAR_T");
  const constructT = int("CONSTR_T");
  const spy1 = str("SPY_1");
  const spy2 = str("SPY_2");
  const spy3 = str("SPY_3");
  const capturedBy = str("CAPT_BY");
  const alwaysAi = readBoolValue(buf, "ALWAYSAI", f, e); // conditional on disk — null when absent
  const exMapId1 = str("EXMAPID1");
  const exMapTurn1 = int("EXMAPTURN1");
  const exMapId2 = str("EXMAPID2");
  const exMapTurn2 = int("EXMAPTURN2");
  const exMapId3 = str("EXMAPID3");
  const exMapTurn3 = int("EXMAPTURN3");

  return {
    id,
    playerNo: parsedPlayer ? parsedPlayer.index : 0,
    race: parsedRace ? parsedRace.index : 0,
    name,
    isHuman,
    ...(desc !== null ? { desc } : {}),
    ...(lordId !== null ? { lordId } : {}),
    ...(raceId !== null ? { raceId } : {}),
    ...(fogId !== null ? { fogId } : {}),
    ...(knownId !== null ? { knownId } : {}),
    ...(buildsId !== null ? { buildsId } : {}),
    ...(face !== null ? { face } : {}),
    ...(qtyBreaks !== null ? { qtyBreaks } : {}),
    ...(bank !== null ? { bank } : {}),
    ...(spellBank !== null ? { spellBank } : {}),
    ...(attitude !== null ? { attitude } : {}),
    ...(researchT !== null ? { researchT } : {}),
    ...(constructT !== null ? { constructT } : {}),
    ...(spy1 !== null ? { spy1 } : {}),
    ...(spy2 !== null ? { spy2 } : {}),
    ...(spy3 !== null ? { spy3 } : {}),
    ...(capturedBy !== null ? { capturedBy } : {}),
    ...(alwaysAi !== null ? { alwaysAi } : {}),
    ...(exMapId1 !== null ? { exMapId1 } : {}),
    ...(exMapTurn1 !== null ? { exMapTurn1 } : {}),
    ...(exMapId2 !== null ? { exMapId2 } : {}),
    ...(exMapTurn2 !== null ? { exMapTurn2 } : {}),
    ...(exMapId3 !== null ? { exMapId3 } : {}),
    ...(exMapTurn3 !== null ? { exMapTurn3 } : {}),
  };
}

/** MidSubRace — full record (D2SubRace.h port): SUBRACE_ID(self) · SUBRACE · PLAYER_ID ·
 *  NUMBER · NAME_TXT · BANNER. */
export function readSubRace(buf: ByteBuffer, obj: FramedObject): SubRaceInfo {
  const { fieldsFrom: f, fieldsEnd: e } = obj;
  // "SUBRACE" is a PREFIX of the leading "SUBRACE_ID" tag — search the int field only after it.
  const idTag = buf.indexOf("SUBRACE_ID", f);
  const afterId = idTag >= 0 && idTag < e ? idTag + "SUBRACE_ID".length : f;
  return {
    id: obj.id,
    subrace: readDefaultInt(buf, "SUBRACE", afterId, e) ?? 0,
    playerId: readDefaultString(buf, "PLAYER_ID", f, e) ?? "G000000000",
    number: readDefaultInt(buf, "NUMBER", f, e) ?? 0,
    name: readDefaultString(buf, "NAME_TXT", f, e) ?? "",
    banner: readDefaultInt(buf, "BANNER", f, e) ?? 0,
  };
}
