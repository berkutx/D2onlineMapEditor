/**
 * Per-type field codec for MidEvent conditions/effects — the ONE table the reader
 * (blocks/events.ts) and writer (writer/eventFrame.ts) both drive, so their byte order
 * and tags cannot drift. A direct port of toolsqt D2Event.h read()/write() (verbatim copy in
 * the session tool-results). Field KEYS match the model in @d2/map-schema events.ts; the .sg
 * TAG and serialization io are attached here.
 *
 * io kinds:
 *  - int      : tag + int32
 *  - bool     : tag + 1 byte (0/1)
 *  - ref      : tag + int32(11) + 10-char id + NUL  (empty id <-> "" via EMPTY_REF)
 *  - str      : tag + int32(len+1) + CP1251 bytes + NUL  (variable-length string)
 *  - audioStr : like `str`, but the value is canonicalized to the bare SOUND/MUSIC name (no
 *               audio extension) on read AND write via normalizeAudioRef — a ".mp3"/".wav"
 *               name NULL-crashes the game on playback. No-op on every shipped map (all bare).
 *  - existInt : STACK_EXISTANCE MISC_INT — stored int, 0 => true (mustExist)
 *  - popupShow: DISPLAY_POPUP_MESSAGE POPUP_SHOW — stored string "TRI"/"ALL"/"AFF" <-> 0/1/2
 *
 * `customScript` and `changeFog` have irregular layouts (raw script blocks / nested lists) and
 * are handled explicitly by the reader/writer, not by this table (special: true).
 */

export type CodecIo = "int" | "bool" | "ref" | "str" | "audioStr" | "existInt" | "popupShow";

export interface CodecField {
  key: string;
  tag: string;
  io: CodecIo;
}

export interface TypeCodec {
  fields: readonly CodecField[];
  /** true = the reader/writer handle this type explicitly (not via `fields`). */
  special?: boolean;
}

const f = (key: string, tag: string, io: CodecIo): CodecField => ({ key, tag, io });

/** POPUP_SHOW string <-> enum. */
export const POPUP_SHOW_TO_INT: Record<string, number> = { TRI: 0, ALL: 1, AFF: 2 };
export const POPUP_SHOW_TO_STR: Record<number, string> = { 0: "TRI", 1: "ALL", 2: "AFF" };

export const COND_CODEC: Record<string, TypeCodec> = {
  frequency: { fields: [f("days", "FREQUENCY", "int")] },
  enterZone: { fields: [f("locId", "ID_LOC", "ref")] },
  enterCity: { fields: [f("cityId", "ID_CITY", "ref")] },
  owningCity: { fields: [f("cityId", "ID_CITY", "ref")] },
  destroyStack: { fields: [f("stackId", "ID_STACK", "ref")] },
  owningItem: { fields: [f("itemType", "TYPE_ITEM", "str")] },
  leaderOwningItem: { fields: [f("itemType", "TYPE_ITEM", "str"), f("stackId", "ID_STACK", "ref")] },
  diplomacy: { fields: [f("player1", "ID_PLAYER1", "ref"), f("player2", "ID_PLAYER2", "ref"), f("relation", "DIPLOMACY", "int")] },
  alliance: { fields: [f("player1", "ID_PLAYER1", "ref"), f("player2", "ID_PLAYER2", "ref")] },
  lootingRuin: { fields: [f("ruinId", "ID_RUIN", "ref")] },
  transformLand: { fields: [f("pct", "PCT_LAND", "int")] },
  visitingSite: { fields: [f("siteId", "ID_SITE", "ref")] },
  stackInLocation: { fields: [f("stackId", "ID_STACK", "ref"), f("locId", "ID_LOC", "ref")] },
  stackInCity: { fields: [f("stackId", "ID_STACK", "ref"), f("cityId", "ID_CITY", "ref")] },
  itemToLocation: { fields: [f("itemType", "TYPE_ITEM", "str"), f("locId", "ID_LOC", "ref")] },
  stackExists: { fields: [f("stackId", "ID_STACK", "ref"), f("mustExist", "MISC_INT", "existInt")] },
  varInRange: { fields: [
    f("var1", "MISC_INT", "int"), f("min1", "MISC_INT2", "int"), f("max1", "MISC_INT3", "int"),
    f("var2", "MISC_INT4", "int"), f("min2", "MISC_INT5", "int"), f("max2", "MISC_INT6", "int"),
    f("relation", "MISC_INT7", "int") ] },
  resourceAmount: { fields: [f("bank", "BANK", "str"), f("greaterOrEqual", "GRE", "bool")] },
  gameMode: { fields: [f("mode", "MODE", "int")] },
  checkForHuman: { fields: [f("isAI", "AI", "bool")] },
  compareVar: { fields: [f("var1", "VAR1", "int"), f("var2", "VAR2", "int"), f("cmp", "CMP", "int")] },
  customScript: { fields: [], special: true },
};

/** Effect codec fields are in .sg ORDER (NUM is read/written by the wrapper, not listed here). */
export const EFF_CODEC: Record<string, TypeCodec> = {
  winLose: { fields: [f("win", "WIN_SCEN", "bool"), f("player", "ID_PLAYER1", "ref")] },
  createStack: { fields: [f("templateId", "ID_STKTEMP", "ref"), f("locId", "ID_LOC", "ref")] },
  castSpellTriggerer: { fields: [f("spellType", "TYPE_SPELL", "str"), f("player", "ID_PLAYER1", "ref")] },
  castSpellLocation: { fields: [f("spellType", "TYPE_SPELL", "str"), f("locId", "ID_LOC", "ref"), f("player", "ID_PLAYER1", "ref")] },
  changeStackOwner: { fields: [f("stackId", "ID_STACK", "ref"), f("player", "ID_PLAYER1", "ref"), f("firstOnly", "FIRST_ONLY", "bool"), f("playAnim", "PLAY_ANIM", "bool")] },
  moveStackToTriggerer: { fields: [f("stackId", "ID_STACK", "ref")] },
  goIntoBattle: { fields: [f("stackId", "ID_STACK", "ref"), f("firstOnly", "FIRST_ONLY", "bool")] },
  enableEvent: { fields: [f("eventId", "ID_EVENT", "ref"), f("enable", "ENABLE", "bool")] },
  giveSpell: { fields: [f("spellType", "TYPE_SPELL", "str")] },
  giveItem: { fields: [f("giveTo", "GIVETO", "int"), f("itemType", "TYPE_ITEM", "str")] },
  moveStackToLocation: { fields: [f("stackTmpId", "ID_STKTEMP", "ref"), f("locId", "ID_LOC", "ref"), f("boolVal", "BOOLVALUE", "bool")] },
  allyPlayers: { fields: [f("player1", "ID_PLAYER1", "ref"), f("player2", "ID_PLAYER2", "ref"), f("permAlly", "PERMALLI", "bool")] },
  changeDiplomacy: { fields: [f("player1", "ID_PLAYER1", "ref"), f("player2", "ID_PLAYER2", "ref"), f("relation", "DIPLOMACY", "int"), f("enabled", "ENABLE", "bool")] },
  changeFog: { fields: [], special: true },
  removeMountains: { fields: [f("locId", "ID_LOC", "ref")] },
  removeLandmark: { fields: [f("lmarkId", "ID_LMARK", "ref"), f("boolVal", "BOOLVALUE", "bool")] },
  changeObjective: { fields: [f("text", "OBJECT_TXT", "str")] },
  popup: { fields: [
    f("text", "POPUP_TXT", "str"), f("music", "MUSIC", "audioStr"), f("sound", "SOUND", "audioStr"),
    f("image", "IMAGE", "str"), f("image2", "IMAGE2", "str"), f("leftSide", "LEFT_SIDE", "bool"),
    f("popupShow", "POPUP_SHOW", "popupShow"), f("boolValue", "BOOLVALUE", "bool") ] },
  changeStackOrder: { fields: [f("stackId", "ID_STACK", "ref"), f("orderTarget", "ORDER_TARG", "ref"), f("firstOnly", "FIRST_ONLY", "bool"), f("order", "ORDER", "int")] },
  destroyItem: { fields: [f("itemType", "TYPE_ITEM", "str"), f("triggerOnly", "TRIG_ONLY", "bool")] },
  removeStack: { fields: [f("stackId", "ID_STACK", "ref"), f("firstOnly", "FIRST_ONLY", "bool")] },
  changeLandmark: { fields: [f("lmarkId", "ID_LMARK", "ref"), f("lmarkType", "TYPE_LMARK", "str")] },
  changeTerrain: { fields: [f("locId", "ID_LOC", "ref"), f("lookup", "LOOKUP", "int"), f("value", "NUMVALUE", "int")] },
  modifyVariable: { fields: [f("lookup", "LOOKUP", "int"), f("val1", "NUMVALUE", "int"), f("val2", "NUMVALUE2", "int")] },
};

/** The neutral/empty 10-char reference sentinel — the model stores "" for it. */
export const EMPTY_REF = "G000000000";
/** true if a field's D2EESFISIG-only (elf-expansion) tag should be read/written. Our target
 *  format is always D2EESFISIG (S143), but the flag keeps the gating explicit. */
export const EES_ONLY = new Set(["BOOLVALUE"]);
