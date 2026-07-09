/**
 * Growable `.sg` edits — APPEND new block frames (e.g. MidRoad) to the object
 * stream and bump the header object count. The `.sg` has no footer (header then
 * concatenated frames), so appending at EOF + patching the OB0000 count is enough;
 * `offset` is player-count-derived and unchanged. This is the M4 path for edits
 * that add blocks, complementing the fixed-width SgWriter.
 *
 * (Our reader scans for blocks, so appended blocks are found regardless of order;
 * game-faithful placement / Plan entries are a later refinement.)
 */

import { ByteBuffer, tagValueOffset } from "../bytebuffer.js";
import { ByteWriter } from "./byteWriter.js";
import { encodeCp1251 } from "./cp1251.js";

const hex4 = (n: number): string => (n >>> 0).toString(16).padStart(4, "0");

/** Build one complete framed block: WHAT/code/.?AVC + OBJ_ID + BEGOBJECT + body + ENDOBJECT. */
export function emitBlock(
  version: string,
  typeName: string,
  code: number,
  short: string,
  second: number,
  body: (w: ByteWriter, fullId: string) => void,
): Uint8Array {
  const full = version + short + hex4(second);
  const w = new ByteWriter();
  w.blockHeader(typeName, code);
  w.refField("OBJ_ID", full);
  w.begin();
  body(w, full);
  w.end();
  return w.toBytes();
}

/** A MidRoad block frame (code 15, short RA): ROAD_ID, INDEX, VAR, POS_X, POS_Y. */
export function roadFrame(
  version: string,
  second: number,
  x: number,
  y: number,
  index: number,
  variant: number,
): Uint8Array {
  return emitBlock(version, "MidRoad", 0x0f, "RA", second, (w, full) => {
    w.refField("ROAD_ID", full);
    w.defaultInt("INDEX", index);
    w.defaultInt("VAR", variant);
    w.defaultInt("POS_X", x);
    w.defaultInt("POS_Y", y);
  });
}

/**
 * A MidLandmark block frame (code 0x13, short MM): LMARK_ID, TYPE, POS_X, POS_Y, [DESC_TXT].
 * `desc` is optional: pass `undefined` to OMIT the DESC_TXT field entirely (RMG-generated
 * landmarks never carry it); pass `""` or a name to write it (editor-authored landmarks always
 * do — the reference editor writes DESC_TXT on every landmark it saves).
 */
export function landmarkFrame(
  version: string,
  second: number,
  x: number,
  y: number,
  lmarkId: string,
  desc?: string,
): Uint8Array {
  return emitBlock(version, "MidLandmark", 0x13, "MM", second, (w, full) => {
    w.refField("LMARK_ID", full);
    w.stringField("TYPE", lmarkId);
    w.defaultInt("POS_X", x);
    w.defaultInt("POS_Y", y);
    if (desc !== undefined) w.stringField("DESC_TXT", desc);
  });
}

/** A MidLocation block frame (code 0x13, short LO): LOC_ID (self), POS_X, POS_Y,
 *  NAME_TXT (CP1251), RADIUS — byte-verified field order on Riders.sg. */
export function locationFrame(
  version: string,
  second: number,
  x: number,
  y: number,
  name: string,
  radius: number,
): Uint8Array {
  return emitBlock(version, "MidLocation", 0x13, "LO", second, (w, full) => {
    w.refField("LOC_ID", full);
    w.defaultInt("POS_X", x);
    w.defaultInt("POS_Y", y);
    w.stringField("NAME_TXT", name);
    w.defaultInt("RADIUS", radius);
  });
}

/**
 * MidCrystal frame (code 0x12, short CR): CRYSTAL_ID(self) · RESOURCE · POS_X · POS_Y · AIPRIORITY.
 * Field order + code byte + short verified against Riders (`CR0000`: RESOURCE/POS_X/POS_Y/AIPRIORITY,
 * priority defaults to 3). resource packs mana school+amount; priority = AI collection priority.
 */
export function crystalFrame(
  version: string,
  second: number,
  x: number,
  y: number,
  resource: number,
  priority = 3,
): Uint8Array {
  return emitBlock(version, "MidCrystal", 0x12, "CR", second, (w, full) => {
    w.refField("CRYSTAL_ID", full);
    w.defaultInt("RESOURCE", resource);
    w.defaultInt("POS_X", x);
    w.defaultInt("POS_Y", y);
    w.defaultInt("AIPRIORITY", priority);
  });
}

/** A MidItem block frame (code 0x0f, short IM): ITEM_ID (self) + ITEM_TYPE (global
 *  GItem template id). A scenario item instance referenced by chests/heroes. */
export function itemFrame(version: string, second: number, templateId: string): Uint8Array {
  return emitBlock(version, "MidItem", 0x0f, "IM", second, (w, full) => {
    w.refField("ITEM_ID", full);
    w.refField("ITEM_TYPE", templateId);
  });
}

/** A MidBag block frame (code 0x0e, short BG) — a treasure chest/bag. Field order
 *  byte-verified on Riders.sg (incl. the empty-list block S143BG000a and the 17-item
 *  S143BG0000): BAG_ID(self) · POS_X · POS_Y · IMAGE · AIPRIORITY · <ownId> item count ·
 *  N×ITEM_ID. The ITEM_ID entries are MidItem INSTANCE refs — the caller mints the
 *  instances (itemFrame) and appends them alongside this frame. */
export function bagFrame(
  version: string,
  second: number,
  o: { posX: number; posY: number; image: number; priority?: number; itemIds?: readonly string[] },
): Uint8Array {
  return emitBlock(version, "MidBag", 0x0e, "BG", second, (w, full) => {
    w.refField("BAG_ID", full);
    w.defaultInt("POS_X", o.posX);
    w.defaultInt("POS_Y", o.posY);
    w.defaultInt("IMAGE", o.image);
    w.defaultInt("AIPRIORITY", o.priority ?? 0);
    const items = o.itemIds ?? [];
    w.defaultInt(full, items.length); // item-list count (tag = the bag's own id)
    for (const id of items) w.refField("ITEM_ID", id);
  });
}

/** A MidVillage block frame (code 0x12, short FT — the fort id prefix SHARED with Capital).
 *  Field order byte-verified on Riders.sg (all MidVillage blocks agree, incl. the empty-
 *  garrison/empty-item-list S143FT0005): CITY_ID(self) · NAME_TXT · DESC_TXT · OWNER ·
 *  SUBRACE · STACK · POS_X · POS_Y · GROUP_ID(self) · UNIT_0..5 · POS_0..5 · <ownId> item
 *  count + N×ITEM_ID · AIPRIORITY · PROTECT_B(ref) · REGEN_B · MORALE · GROWTH_T · SIZE ·
 *  P_O_UN/P_O_HE/P_O_HU/P_O_DW/P_O_EL (bools) · RIOT_T.
 *  Garrison encoding matches the fort garrison writer: `unitSlots` = MidUnit instance refs
 *  packed in insertion order, `posOfCell[i]` = the UNIT_ slot of FORMATION CELL i (-1 =
 *  empty) — cell i = UNIT_[POS_i]. */
export function villageFrame(
  version: string,
  second: number,
  o: {
    posX: number;
    posY: number;
    name?: string;
    desc?: string;
    owner?: string;
    subRace?: string;
    stackRef?: string;
    tier?: number;
    priority?: number;
    regen?: number;
    morale?: number;
    growth?: number;
    riot?: number;
    unitSlots?: readonly (string | null)[];
    posOfCell?: readonly number[];
    itemIds?: readonly string[];
  },
): Uint8Array {
  const NIL = "G000000000";
  return emitBlock(version, "MidVillage", 0x12, "FT", second, (w, full) => {
    w.refField("CITY_ID", full);
    w.stringField("NAME_TXT", o.name ?? "");
    w.stringField("DESC_TXT", o.desc ?? "");
    w.refField("OWNER", o.owner || NIL);
    w.refField("SUBRACE", o.subRace || NIL);
    w.refField("STACK", o.stackRef || NIL);
    w.defaultInt("POS_X", o.posX);
    w.defaultInt("POS_Y", o.posY);
    w.refField("GROUP_ID", full);
    for (let i = 0; i < 6; i++) w.refField(`UNIT_${i}`, o.unitSlots?.[i] ?? NIL);
    for (let i = 0; i < 6; i++) w.defaultInt(`POS_${i}`, o.posOfCell?.[i] ?? -1);
    const items = o.itemIds ?? [];
    w.defaultInt(full, items.length); // captured-loot item list (tag = the village's own id)
    for (const id of items) w.refField("ITEM_ID", id);
    w.defaultInt("AIPRIORITY", o.priority ?? 0);
    w.refField("PROTECT_B", NIL);
    w.defaultInt("REGEN_B", o.regen ?? 0);
    w.defaultInt("MORALE", o.morale ?? 0);
    w.defaultInt("GROWTH_T", o.growth ?? 0);
    w.defaultInt("SIZE", o.tier ?? 1);
    for (const tag of ["P_O_UN", "P_O_HE", "P_O_HU", "P_O_DW", "P_O_EL"]) w.bool(tag, false);
    w.defaultInt("RIOT_T", o.riot ?? 0);
  });
}

/**
 * A Capital block frame (code 0x0f, short FT — shared with MidVillage; disambiguated by the
 * `.?AVC Capital` decl). Field order byte-verified on 215 pristine capitals (ONE layout):
 * CITY_ID(self) · NAME_TXT · DESC_TXT · OWNER · SUBRACE · STACK · POS_X · POS_Y · GROUP_ID(self) ·
 * UNIT_0..5 · POS_0..5 · <ownId> item count + N×ITEM_ID · AIPRIORITY. Like a village but WITHOUT
 * the economy tail (PROTECT_B, REGEN_B, MORALE, GROWTH_T, SIZE, the P_O_ bools, RIOT_T).
 */
export function capitalFrame(
  version: string,
  second: number,
  o: {
    posX: number;
    posY: number;
    name?: string;
    desc?: string;
    owner?: string;
    subRace?: string;
    stackRef?: string;
    priority?: number;
    unitSlots?: readonly (string | null)[];
    posOfCell?: readonly number[];
    itemIds?: readonly string[];
  },
): Uint8Array {
  const NIL = "G000000000";
  return emitBlock(version, "Capital", 0x0f, "FT", second, (w, full) => {
    w.refField("CITY_ID", full);
    w.stringField("NAME_TXT", o.name ?? "");
    w.stringField("DESC_TXT", o.desc ?? "");
    w.refField("OWNER", o.owner || NIL);
    w.refField("SUBRACE", o.subRace || NIL);
    w.refField("STACK", o.stackRef || NIL);
    w.defaultInt("POS_X", o.posX);
    w.defaultInt("POS_Y", o.posY);
    w.refField("GROUP_ID", full);
    for (let i = 0; i < 6; i++) w.refField(`UNIT_${i}`, o.unitSlots?.[i] ?? NIL);
    for (let i = 0; i < 6; i++) w.defaultInt(`POS_${i}`, o.posOfCell?.[i] ?? -1);
    const items = o.itemIds ?? [];
    w.defaultInt(full, items.length); // stored-items count (tag = the capital's own id)
    for (const id of items) w.refField("ITEM_ID", id);
    w.defaultInt("AIPRIORITY", o.priority ?? 0);
  });
}

/**
 * A MidPlayer block frame (code 0x11, short PL) — FULL D2Player.h field order, byte-verified:
 * PLAYER_ID(self) · NAME_TXT · DESC_TXT · LORD_ID · RACE_ID · FOG_ID · KNOWN_ID · BUILDS_ID ·
 * FACE · QTY_BREAKS · BANK · IS_HUMAN(value bool) · SPELL_BANK · ATTITUDE · RESEAR_T · CONSTR_T ·
 * SPY_1..3 · CAPT_BY · [ALWAYSAI] · [EXMAPID/TURN 1..3]. The conditional tails are written iff
 * the model captured them (presence == what was on disk; EES maps always carry both).
 */
export function playerFrame(
  version: string,
  second: number,
  p: {
    name?: string; desc?: string; lordId?: string; raceId?: string;
    fogId?: string; knownId?: string; buildsId?: string;
    face?: number; qtyBreaks?: number; bank?: string; isHuman?: boolean; spellBank?: string;
    attitude?: number; researchT?: number; constructT?: number;
    spy1?: string; spy2?: string; spy3?: string; capturedBy?: string;
    alwaysAi?: boolean;
    exMapId1?: string; exMapTurn1?: number;
    exMapId2?: string; exMapTurn2?: number;
    exMapId3?: string; exMapTurn3?: number;
  },
): Uint8Array {
  const NIL = "G000000000";
  const EMPTY_BANK = "G0000:R0000:Y0000:E0000:W0000:B0000";
  return emitBlock(version, "MidPlayer", 0x11, "PL", second, (w, full) => {
    w.refField("PLAYER_ID", full);
    w.stringField("NAME_TXT", p.name ?? "");
    w.stringField("DESC_TXT", p.desc ?? "");
    w.refField("LORD_ID", p.lordId ?? "G000LR0001");
    w.refField("RACE_ID", p.raceId ?? "G000RR0004");
    w.refField("FOG_ID", p.fogId ?? NIL);
    w.refField("KNOWN_ID", p.knownId ?? NIL);
    w.refField("BUILDS_ID", p.buildsId ?? NIL);
    w.defaultInt("FACE", p.face ?? 1);
    w.defaultInt("QTY_BREAKS", p.qtyBreaks ?? 0);
    w.stringField("BANK", p.bank ?? EMPTY_BANK);
    w.bool("IS_HUMAN", p.isHuman ?? false);
    w.stringField("SPELL_BANK", p.spellBank ?? EMPTY_BANK);
    w.defaultInt("ATTITUDE", p.attitude ?? 1);
    w.defaultInt("RESEAR_T", p.researchT ?? 0);
    w.defaultInt("CONSTR_T", p.constructT ?? 0);
    w.refField("SPY_1", p.spy1 ?? NIL);
    w.refField("SPY_2", p.spy2 ?? NIL);
    w.refField("SPY_3", p.spy3 ?? NIL);
    w.refField("CAPT_BY", p.capturedBy ?? NIL);
    if (p.alwaysAi !== undefined) w.bool("ALWAYSAI", p.alwaysAi);
    if (p.exMapId1 !== undefined) {
      w.refField("EXMAPID1", p.exMapId1 || NIL);
      w.defaultInt("EXMAPTURN1", p.exMapTurn1 ?? 0);
      w.refField("EXMAPID2", p.exMapId2 || NIL);
      w.defaultInt("EXMAPTURN2", p.exMapTurn2 ?? 0);
      w.refField("EXMAPID3", p.exMapId3 || NIL);
      w.defaultInt("EXMAPTURN3", p.exMapTurn3 ?? 0);
    }
  });
}

/** A MidSubRace block frame (code 0x12, short SR): SUBRACE_ID(self) · SUBRACE · PLAYER_ID ·
 *  NUMBER · NAME_TXT · BANNER — full D2SubRace.h port, byte-verified. */
export function subraceFrame(
  version: string,
  second: number,
  sr: { subrace: number; playerId: string; number: number; name: string; banner: number },
): Uint8Array {
  return emitBlock(version, "MidSubRace", 0x12, "SR", second, (w, full) => {
    w.refField("SUBRACE_ID", full);
    w.defaultInt("SUBRACE", sr.subrace);
    w.refField("PLAYER_ID", sr.playerId || "G000000000");
    w.defaultInt("NUMBER", sr.number);
    w.stringField("NAME_TXT", sr.name);
    w.defaultInt("BANNER", sr.banner);
  });
}

/** A MidRod block frame (code 0x0e, short RD): ROD_ID(self) · OWNER · POS_X · POS_Y.
 *  Byte-verified on 33 pristine rods (ONE layout). */
export function rodFrame(version: string, second: number, x: number, y: number, owner?: string): Uint8Array {
  return emitBlock(version, "MidRod", 0x0e, "RD", second, (w, full) => {
    w.refField("ROD_ID", full);
    w.refField("OWNER", owner || "G000000000");
    w.defaultInt("POS_X", x);
    w.defaultInt("POS_Y", y);
  });
}

/**
 * A MidTomb block frame (code 0x0f, short TB): TOMB_ID(self) · POS_X · POS_Y · QTY_EP +
 * N×{STACK_OWNR(ref) · KILLER(ref) · TURN(int) · STACK_NAME(CP1251)}. Tombs are playthrough
 * state (a stack died here) — 0 on authored maps; layout byte-verified on campaign saves.
 */
export function tombFrame(
  version: string,
  second: number,
  x: number,
  y: number,
  epitaphs: readonly { owner: string; killer: string; turn: number; name: string }[] = [],
): Uint8Array {
  return emitBlock(version, "MidTomb", 0x0f, "TB", second, (w, full) => {
    w.refField("TOMB_ID", full);
    w.defaultInt("POS_X", x);
    w.defaultInt("POS_Y", y);
    w.defaultInt("QTY_EP", epitaphs.length);
    for (const ep of epitaphs) {
      w.refField("STACK_OWNR", ep.owner);
      w.refField("KILLER", ep.killer);
      w.defaultInt("TURN", ep.turn);
      w.stringField("STACK_NAME", ep.name);
    }
  });
}

/** A MidUnit block frame (code 0x0f, short UN): a unit INSTANCE referenced by a fort garrison
 *  or a stack. Minimal body verified on real bytes: UNIT_ID(self) + TYPE(global Gunit id) +
 *  LEVEL + MODIF count(0, tag=self id) + CREATION(0) + NAME_TXT("") + TRANSF/DYNLEVEL(false) +
 *  HP + XP. */
export function unitFrame(
  version: string,
  second: number,
  typeId: string,
  level: number,
  hp: number,
  xp = 0,
  opts?: {
    /** MODIF_ID list — level-up / equipment modifiers (global Gmodif refs, order + dupes as-is). */
    modifiers?: readonly string[];
    /** CREATION field (0 for a freshly minted unit). */
    creation?: number;
    /** NAME_TXT — custom unit name (empty for an unnamed unit). */
    name?: string;
  },
): Uint8Array {
  return emitBlock(version, "MidUnit", 0x0f, "UN", second, (w, full) => {
    w.refField("UNIT_ID", full);
    w.refField("TYPE", typeId);
    w.defaultInt("LEVEL", level);
    const mods = opts?.modifiers ?? [];
    w.defaultInt(full, mods.length); // MODIF_ID list count (count tag = the unit's own id)
    for (const m of mods) w.refField("MODIF_ID", m);
    w.defaultInt("CREATION", opts?.creation ?? 0);
    w.stringField("NAME_TXT", opts?.name ?? "");
    w.bool("TRANSF", false);
    w.bool("DYNLEVEL", false);
    w.defaultInt("HP", hp);
    w.defaultInt("XP", xp);
  });
}

/** A MidStack block frame (code 0x10, short KC) — a hero stack. Body matches D2Stack::data()
 *  field order exactly; empty refs are the "G000000000" sentinel (verified on real bytes —
 *  the struct's "000000" QString defaults normalize to it on disk). With only the required
 *  fields it emits a fresh EMPTY stack (the city-VISITOR case); the optional formation/
 *  inventory/equip/scalar fields emit a REAL army in one frame:
 *   - `unitSlots` = MidUnit instance refs in insertion order; `posOfCell[i]` = the UNIT_
 *     slot of FORMATION CELL i (-1 = empty) — cell i = UNIT_[POS_i] (the garrison encoding);
 *   - `leaderId` = the leader cell's MidUnit instance ref (LEADER_ID);
 *   - `itemIds`  = carried-inventory MidItem instance refs (minted by the caller). */
export function stackFrame(
  version: string,
  second: number,
  o: {
    owner: string;
    inside: string;
    subRace?: string;
    posX: number;
    posY: number;
    unitSlots?: readonly (string | null)[];
    posOfCell?: readonly number[];
    leaderId?: string;
    itemIds?: readonly string[];
    morale?: number;
    move?: number;
    facing?: number;
    banner?: string;
    equip?: {
      tome?: string; battle1?: string; battle2?: string;
      artifact1?: string; artifact2?: string; boots?: string;
    };
    order?: number;
    priority?: number;
    creatLvl?: number;
    // ---- full-parse scalars (defaults reproduce a fresh stack) ----
    srcTemplate?: string;
    leaderAlive?: boolean;
    invisible?: boolean;
    aiIgnore?: boolean;
    upgCount?: number;
    orderTarget?: string;
    aiOrder?: number;
    aiOrderTarget?: string;
    nbBattle?: number;
  },
): Uint8Array {
  const NIL = "G000000000";
  return emitBlock(version, "MidStack", 0x10, "KC", second, (w, full) => {
    w.refField("GROUP_ID", full);
    for (let i = 0; i < 6; i++) w.refField(`UNIT_${i}`, o.unitSlots?.[i] ?? NIL);
    for (let i = 0; i < 6; i++) w.defaultInt(`POS_${i}`, o.posOfCell?.[i] ?? -1);
    const items = o.itemIds ?? [];
    w.defaultInt(full, items.length); // carried-items count (tag = own id)
    for (const id of items) w.refField("ITEM_ID", id);
    w.refField("STACK_ID", full);
    w.refField("SRCTMPL_ID", o.srcTemplate || NIL);
    w.refField("LEADER_ID", o.leaderId ?? NIL);
    w.bool("LEADR_ALIV", o.leaderAlive ?? true);
    w.defaultInt("POS_X", o.posX);
    w.defaultInt("POS_Y", o.posY);
    w.defaultInt("MORALE", o.morale ?? 0);
    w.defaultInt("MOVE", o.move ?? 20);
    w.defaultInt("FACING", o.facing ?? 0);
    w.refField("BANNER", o.banner || NIL);
    w.refField("TOME", o.equip?.tome || NIL);
    w.refField("BATTLE1", o.equip?.battle1 || NIL);
    w.refField("BATTLE2", o.equip?.battle2 || NIL);
    w.refField("ARTIFACT1", o.equip?.artifact1 || NIL);
    w.refField("ARTIFACT2", o.equip?.artifact2 || NIL);
    w.refField("BOOTS", o.equip?.boots || NIL);
    w.refField("OWNER", o.owner);
    w.refField("INSIDE", o.inside);
    w.refField("SUBRACE", o.subRace || NIL);
    w.bool("INVISIBLE", o.invisible ?? false);
    w.bool("AI_IGNORE", o.aiIgnore ?? false);
    w.defaultInt("UPGCOUNT", o.upgCount ?? 0);
    w.defaultInt("ORDER", o.order ?? 1); // 1 = Normal
    w.refField("ORDER_TARG", o.orderTarget || NIL);
    w.defaultInt("AIORDER", o.aiOrder ?? 2); // 2 = Stand
    w.refField("AIORDERTAR", o.aiOrderTarget || NIL);
    w.defaultInt("AIPRIORITY", o.priority ?? 3);
    w.defaultInt("CREAT_LVL", o.creatLvl ?? 1);
    w.defaultInt("NBBATTLE", o.nbBattle ?? 0);
  });
}

/**
 * A MidRuin block frame (code 0x0f, short RU). Field order byte-verified against every
 * Riders ruin (and toolsqt D2Ruin::data()): RUIN_ID · TITLE · DESC · IMAGE · POS_X ·
 * POS_Y · CASH · ITEM(ref: a GLOBAL GItem template, NOT a MidItem instance) · LOOTER ·
 * AIPRIORITY · <ownId> int visiterCount (0 — visiters unmodeled; 0 on every shipped map)
 * · GROUP_ID(=own id) · UNIT_0..5(guard MidUnit instances) · POS_0..5.
 */
export function ruinFrame(
  version: string,
  second: number,
  o: {
    posX: number;
    posY: number;
    name?: string;
    desc?: string;
    image?: number;
    reward?: string;
    item?: string;
    looter?: string;
    priority?: number;
    unitSlots?: readonly (string | null)[];
    posOfCell?: readonly number[];
  },
): Uint8Array {
  const NIL = "G000000000";
  return emitBlock(version, "MidRuin", 0x0f, "RU", second, (w, full) => {
    w.refField("RUIN_ID", full);
    w.stringField("TITLE", o.name ?? "");
    w.stringField("DESC", o.desc ?? "");
    w.defaultInt("IMAGE", o.image ?? 0);
    w.defaultInt("POS_X", o.posX);
    w.defaultInt("POS_Y", o.posY);
    w.stringField("CASH", o.reward ?? "");
    w.refField("ITEM", o.item || NIL);
    w.refField("LOOTER", o.looter || NIL);
    w.defaultInt("AIPRIORITY", o.priority ?? 0);
    w.defaultInt(full, 0); // visiter count (tag = the ruin's own compound id)
    w.refField("GROUP_ID", full);
    for (let i = 0; i < 6; i++) w.refField(`UNIT_${i}`, o.unitSlots?.[i] ?? NIL);
    for (let i = 0; i < 6; i++) w.defaultInt(`POS_${i}`, o.posOfCell?.[i] ?? -1);
  });
}

/**
 * A MidSite* block frame — merchant/mage/trainer/mercenary camp. Layout byte-verified on
 * every Riders site (14 blocks): SITE_ID · IMG_ISO · IMG_INTF(len-prefixed string, empty
 * on all shipped sites) · TXT_TITLE · TXT_DESC · POS_X · POS_Y · VISITER(G000000000) ·
 * AIPRIORITY · <stock section per type> · <ownId> int(0) trailer (the visiter-count idiom,
 * same as ruins). Merchant extras: 8 × BUY_* one-byte flags BEFORE the stock (all = 01 on
 * every shipped merchant) and a MISSION byte AFTER it (= 00 everywhere). Stock lists are
 * GLOBAL template ids (no MidItem/MidUnit instances → no delete cascade).
 */
export type SiteKind = "merchant" | "mage" | "trainer" | "mercenary";
const SITE_BLOCK: Record<SiteKind, { typeName: string; code: number }> = {
  merchant: { typeName: "MidSiteMerchant", code: 0x17 },
  mage: { typeName: "MidSiteMage", code: 0x13 },
  trainer: { typeName: "MidSiteTrainer", code: 0x16 },
  mercenary: { typeName: "MidSiteMercs", code: 0x14 },
};
export function siteFrame(
  version: string,
  second: number,
  kind: SiteKind,
  o: {
    posX: number;
    posY: number;
    name?: string;
    desc?: string;
    image?: number;
    aiPriority?: number;
    items?: readonly { id: string; count: number }[];
    buy?: readonly boolean[];
    mission?: boolean;
    spells?: readonly string[];
    units?: readonly { id: string; level: number; unique: boolean }[];
  },
): Uint8Array {
  const { typeName, code } = SITE_BLOCK[kind];
  return emitBlock(version, typeName, code, "SI", second, (w, full) => {
    w.refField("SITE_ID", full);
    w.defaultInt("IMG_ISO", o.image ?? 0);
    w.stringField("IMG_INTF", ""); // empty on every shipped site
    w.stringField("TXT_TITLE", o.name ?? "");
    w.stringField("TXT_DESC", o.desc ?? "");
    w.defaultInt("POS_X", o.posX);
    w.defaultInt("POS_Y", o.posY);
    w.refField("VISITER", "G000000000");
    w.defaultInt("AIPRIORITY", o.aiPriority ?? 0);
    if (kind === "merchant") {
      const buyTags = ["BUY_ARMOR", "BUY_JEWEL", "BUY_WEAPON", "BUY_BANNER", "BUY_POTION", "BUY_SCROLL", "BUY_WAND", "BUY_VALUE"];
      buyTags.forEach((f, i) => w.bool(f, o.buy?.[i] ?? true)); // default: buys every category
      const items = o.items ?? [];
      w.defaultInt("QTY_ITEM", items.length);
      for (const it of items) {
        w.refField("ITEM_ID", it.id);
        w.defaultInt("ITEM_COUNT", it.count);
      }
      w.bool("MISSION", o.mission ?? false);
    } else if (kind === "mage") {
      const spells = o.spells ?? [];
      w.defaultInt("QTY_SPELL", spells.length);
      for (const sp of spells) w.refField("SPELL_ID", sp);
    } else if (kind === "mercenary") {
      const units = o.units ?? [];
      w.defaultInt("QTY_UNIT", units.length);
      for (const u of units) {
        w.refField("UNIT_ID", u.id);
        w.defaultInt("UNIT_LEVEL", u.level);
        w.bool("UNIT_UNIQ", u.unique);
      }
    }
    w.defaultInt(full, 0); // visiter count (tag = the site's own compound id)
  });
}

/** One mountain entry written into the MidMountains body. */
export interface MountainEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  image: number;
  race: number;
  /** ID_MOUNT — the per-entry id from a loaded block (non-sequential); falls back to the index. */
  idMount?: number;
}

/** The single MidMountains block frame (code 0x14, short ML): count + per-entry fields. */
export function mountainsFrame(
  version: string,
  second: number,
  mountains: readonly MountainEntry[],
): Uint8Array {
  return emitBlock(version, "MidMountains", 0x14, "ML", second, (w, full) => {
    w.defaultInt(full, mountains.length);
    mountains.forEach((m, i) => {
      w.defaultInt("ID_MOUNT", m.idMount ?? i);
      w.defaultInt("SIZE_X", m.w);
      w.defaultInt("SIZE_Y", m.h);
      w.defaultInt("POS_X", m.x);
      w.defaultInt("POS_Y", m.y);
      w.defaultInt("IMAGE", m.image);
      w.defaultInt("RACE", m.race);
    });
  });
}

/** Per-block frame ranges (start/end byte offsets + on-disk OBJ_ID), in file order. */
function frameRanges(buf: ByteBuffer): { start: number; end: number; objId: string }[] {
  const out: { start: number; end: number; objId: string }[] = [];
  const first = buf.indexOf("WHAT");
  if (first < 0) return out;
  const starts: number[] = [];
  let p = first;
  for (;;) {
    const i = buf.indexOf("WHAT", p);
    if (i < 0) break;
    starts.push(i);
    p = i + 4;
  }
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k]!;
    const end = k + 1 < starts.length ? starts[k + 1]! : buf.length;
    const oid = buf.indexOf("OBJ_ID", start);
    // OBJ_ID is a refField: "OBJ_ID" + [0B 00 00 00] + value(10) + NUL
    const objId = oid >= 0 && oid < end ? buf.asciiSlice(oid + 10, oid + 20) : "";
    out.push({ start, end, objId });
  }
  return out;
}

/** Replace the block whose OBJ_ID == `objId` with `newFrame` (object count unchanged). */
export function replaceBlock(bytes: Uint8Array, objId: string, newFrame: Uint8Array): Uint8Array {
  const buf = new ByteBuffer(bytes);
  const f = frameRanges(buf).find((r) => r.objId === objId);
  if (!f) throw new Error(`replaceBlock: block ${objId} not found`);
  const out = new Uint8Array(bytes.length - (f.end - f.start) + newFrame.length);
  out.set(bytes.subarray(0, f.start), 0);
  out.set(newFrame, f.start);
  out.set(bytes.subarray(f.end), f.start + newFrame.length);
  return out;
}

/**
 * DELETE whole top-level blocks by OBJ_ID (the M4 mid-stream delete): splice each block's
 * [WHAT .. next WHAT) frame out and decrement the header's OB0000 object count by the number
 * of removed frames. This mirrors the reference editor, where deletion is simply "the block
 * is not in the list on the next save" and the count is the list size (D2MapModel::save).
 *
 * The OB0000 count lives in the HEADER (before the first WHAT), so frame splices never move
 * it. Fails loud on an unknown id — a delete that cannot be applied must not be silently
 * dropped (the validator's semantic tier would then reject the export anyway).
 */
export function deleteBlocks(
  bytes: Uint8Array,
  objIds: readonly string[],
  dependentIds: readonly string[] = [],
): Uint8Array {
  if (objIds.length === 0 && dependentIds.length === 0) return bytes;
  // `dependentIds` = instance blocks owned by a primary object (a stack's/bag's MidItem
  // inventory + a stack's/fort's garrison MidUnit) — removed alongside it. They pass the
  // SAME referential guard below: their expected refs (the owner's UNIT_x/ITEM_ID/LEADER_ID)
  // sit INSIDE the deleted frames (allowed zone), and their side-table entries (talisman
  // charges) are purged first — so anything left pointing at them is a REAL dangling ref.
  // Dedup: a repeated id (two peers racing to delete the same object) must splice ONE frame,
  // not shift-and-cut an innocent byte range on the second pass — delete is idempotent.
  const allIds = [...new Set([...objIds, ...dependentIds])];

  // SURVIVORS: an id that also has a re-added frame in these bytes (a delete + re-add in one
  // journal — the collab append-inverse UNDO of a delete). The original frame is spliced but
  // the id stays resolvable, so its side-table entries must SURVIVE: purging the plan/charges
  // here would kill the re-added object's entries too (both carry the same id). The survivor
  // keeps the ORIGINAL entries; the add-path skips emitting duplicates for these ids.
  const preFrames = frameRanges(new ByteBuffer(bytes));
  const survivors = new Set(
    allIds.filter((id) => preFrames.filter((f) => f.objId === id).length > 1),
  );
  const purgeIds = new Set(allIds.filter((id) => !survivors.has(id)));
  // the placement plan (MidgardPlan) holds one {POS_X,POS_Y,ELEMENT->id} entry per occupied
  // cell — purge the deleted objects' entries first (the reference rebuilds the whole plan
  // on save via commitGrid; entry removal is the patch-in-place equivalent)
  bytes = purgePlanEntries(bytes, purgeIds);
  // talisman charges: MidTalismanCharges maps each placed TALISMAN MidItem instance to its
  // remaining charge count — drop the deleted items' entries (the reference does exactly
  // this in D2MapEditor::removeItem before m_map.remove).
  bytes = purgeTalismanCharges(bytes, purgeIds);
  const buf = new ByteBuffer(bytes);
  const frames = frameRanges(buf);
  const ranges: { start: number; end: number }[] = [];
  for (const id of allIds) {
    // the FIRST frame with the id = the pre-existing block (a same-id re-add was APPENDED)
    const f = frames.find((r) => r.objId === id);
    if (!f) throw new Error(`deleteBlocks: block ${id} not found`);
    ranges.push({ start: f.start, end: f.end });
  }

  // Referential guard: a 10-char ref VALUE is always [0B 00 00 00] + id. Any such pattern
  // outside the allowed zones means another live object still points at the deleted one —
  // fail loud rather than ship a dangling reference. Allowed zones: the deleted frames
  // (self OBJ_ID / refs between objects deleted together) and any OTHER frame carrying the
  // same objId (a delete + re-add in one journal leaves a same-id survivor — not dangling).
  const insideDeleted = (at: number): boolean =>
    ranges.some((r) => at >= r.start && at < r.end);
  for (const id of allIds) {
    const sameId = frames.filter((f) => f.objId === id);
    if (sameId.length > 1) continue; // a same-id block survives — the id stays resolvable
    const pat = new Uint8Array(4 + id.length);
    pat.set([0x0b, 0x00, 0x00, 0x00], 0);
    for (let i = 0; i < id.length; i++) pat[4 + i] = id.charCodeAt(i);
    for (let at = indexOfBytes(bytes, pat, 0); at >= 0; at = indexOfBytes(bytes, pat, at + 1)) {
      if (!insideDeleted(at)) {
        throw new Error(`deleteBlocks: ${id} is still referenced at byte ${at + 4}`);
      }
    }
  }
  // locate the count BEFORE splicing (same technique as appendBlocks — it sits in the header)
  const firstWhat = buf.indexOf("WHAT");
  const obAt = buf.lastIndexOf("OB0000", firstWhat);
  if (obAt < 0) throw new Error("deleteBlocks: OB0000 count not found");
  const objCountAt = obAt + 6;
  const objCount = buf.readInt32LE(objCountAt);

  // splice highest-offset-first so earlier ranges stay valid
  ranges.sort((a, b) => b.start - a.start);
  let out = bytes;
  for (const r of ranges) {
    const next = new Uint8Array(out.length - (r.end - r.start));
    next.set(out.subarray(0, r.start), 0);
    next.set(out.subarray(r.end), r.start);
    out = next;
  }
  new DataView(out.buffer, out.byteOffset, out.byteLength).setInt32(
    objCountAt,
    objCount - ranges.length,
    true,
  );
  return out;
}

/** indexOf for a raw byte pattern (Uint8Array has no pattern indexOf). */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = Math.max(0, from); i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Locate the MidgardPlan entry table. Verified layout (Riders bytes): after `BEGOBJECT\0`
 * the plan block is `<blockId(10)> int32 mapSize`, `<blockId(10)> int32 entryCount`, then
 * entryCount fixed 40-byte entries `POS_X int32 · POS_Y int32 · ELEMENT [0B 00 00 00]
 * <id(10)> NUL`. Walks with tag validation and FAILS LOUD on any layout surprise.
 * Returns null when the map has no plan block.
 */
function locatePlanEntries(
  buf: ByteBuffer,
): { countAt: number; count: number; entries: { start: number; end: number; ref: string }[] } | null {
  const avc = buf.indexOf(".?AVCMidgardPlan@@");
  if (avc < 0) return null;
  const beg = buf.indexOf("BEGOBJECT", avc);
  if (beg < 0) throw new Error("MidgardPlan: BEGOBJECT not found after decl");
  let p = beg + 9;
  if (buf.bytes[p] === 0) p++;
  const tag = buf.asciiSlice(p, p + 10); // the block's own compound id doubles as the field tag
  p += 10 + 4; // + int32 map size
  if (buf.asciiSlice(p, p + 10) !== tag) {
    throw new Error("MidgardPlan: expected the count field (blockId tag) after the size");
  }
  const countAt = p + 10;
  const count = buf.readInt32LE(countAt);
  let q = countAt + 4;
  const entries: { start: number; end: number; ref: string }[] = [];
  for (let i = 0; i < count; i++) {
    const start = q;
    if (buf.asciiSlice(q, q + 5) !== "POS_X") throw new Error(`MidgardPlan: entry ${i}: POS_X expected at ${q}`);
    q += 5 + 4;
    if (buf.asciiSlice(q, q + 5) !== "POS_Y") throw new Error(`MidgardPlan: entry ${i}: POS_Y expected at ${q}`);
    q += 5 + 4;
    if (buf.asciiSlice(q, q + 7) !== "ELEMENT") throw new Error(`MidgardPlan: entry ${i}: ELEMENT expected at ${q}`);
    q += 7 + 4;
    const ref = buf.asciiSlice(q, q + 10);
    q += 10 + 1; // + NUL
    entries.push({ start, end: q, ref });
  }
  return { countAt, count, entries };
}

/**
 * Read every MidgardPlan entry as {x, y, element}. Fail-SOFT (returns what parsed, or []):
 * this feeds the plan↔footprint gold-check, so a layout surprise must never throw and abort
 * a save — the worst case is an incomplete parse, and the gate errs toward not blocking.
 */
export function parsePlanEntries(bytes: Uint8Array): { x: number; y: number; element: string }[] {
  const buf = new ByteBuffer(bytes);
  const avc = buf.indexOf(".?AVCMidgardPlan@@");
  if (avc < 0) return [];
  const beg = buf.indexOf("BEGOBJECT", avc);
  if (beg < 0) return [];
  let p = beg + 9;
  if (buf.bytes[p] === 0) p++;
  const tag = buf.asciiSlice(p, p + 10); // block's own compound id doubles as the field tag
  p += 10 + 4; // + int32 map size
  if (buf.asciiSlice(p, p + 10) !== tag) return [];
  const count = buf.readInt32LE(p + 10);
  let q = p + 14;
  const out: { x: number; y: number; element: string }[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.asciiSlice(q, q + 5) !== "POS_X") break;
    const x = buf.readInt32LE(q + 5);
    q += 5 + 4;
    if (buf.asciiSlice(q, q + 5) !== "POS_Y") break;
    const y = buf.readInt32LE(q + 5);
    q += 5 + 4;
    if (buf.asciiSlice(q, q + 7) !== "ELEMENT") break;
    q += 7 + 4; // tag + the [0B 00 00 00] ref length
    out.push({ x, y, element: buf.asciiSlice(q, q + 10) });
    q += 10 + 1; // id + NUL
  }
  return out;
}

/** One MidgardPlan entry to add: an occupied cell + the occupying object's compound id. */
export interface PlanEntry {
  x: number;
  y: number;
  /** the placed object's full 10-char compound id (the ELEMENT ref). */
  element: string;
}

/**
 * ADD MidgardPlan entries — the placement-plan counterpart of appendBlocks: one 40-byte
 * entry per occupied footprint cell, inserted after the existing entries, bumping the
 * plan's entry count. Same fail-loud locator/walk as the delete-side purge. A map without
 * a plan block is left unchanged (mirrors purge; the reference editor rebuilds the whole
 * plan from footprints on save — we patch it in place).
 *
 * TODO (deferred, low priority): optional export-time FULL plan rebuild-from-objects, like
 * the reference D2MapEditor::addPlanObject (clear MidgardPlan, re-emit one entry per footprint
 * cell of every object). Would auto-heal a LOADED map carrying a stale/partial plan (e.g. made
 * by an old build before the landmarkSize writer fix). We currently assume loaded maps are
 * correct; `planCoverageErrors` is the gate that rejects them and asks the author to fix.
 */
export function addPlanEntries(bytes: Uint8Array, entries: readonly PlanEntry[]): Uint8Array {
  if (entries.length === 0) return bytes;
  const buf = new ByteBuffer(bytes);
  const plan = locatePlanEntries(buf);
  if (!plan) return bytes;
  const w = new ByteWriter();
  for (const e of entries) {
    w.defaultInt("POS_X", e.x);
    w.defaultInt("POS_Y", e.y);
    w.refField("ELEMENT", e.element);
  }
  const region = w.toBytes();
  const insertAt = plan.entries.length
    ? plan.entries[plan.entries.length - 1]!.end
    : plan.countAt + 4;
  const out = new Uint8Array(bytes.length + region.length);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(region, insertAt);
  out.set(bytes.subarray(insertAt), insertAt + region.length);
  // countAt precedes every entry, so the insert above never moved it
  new DataView(out.buffer, out.byteOffset, out.byteLength).setInt32(
    plan.countAt,
    plan.count + entries.length,
    true,
  );
  return out;
}

/**
 * Remove every MidgardPlan entry whose ELEMENT references one of `ids`, decrementing the
 * plan's entry count. No plan block = no-op.
 */
function purgePlanEntries(bytes: Uint8Array, ids: ReadonlySet<string>): Uint8Array {
  const buf = new ByteBuffer(bytes);
  const plan = locatePlanEntries(buf);
  if (!plan) return bytes;
  const { countAt, count } = plan;
  const ranges: { start: number; end: number }[] = plan.entries.filter((e) => ids.has(e.ref));
  if (ranges.length === 0) return bytes;
  ranges.sort((a, b) => b.start - a.start);
  let out = bytes;
  for (const r of ranges) {
    const next = new Uint8Array(out.length - (r.end - r.start));
    next.set(out.subarray(0, r.start), 0);
    next.set(out.subarray(r.end), r.start);
    out = next;
  }
  // countAt precedes every entry, so the splices above never moved it
  new DataView(out.buffer, out.byteOffset, out.byteLength).setInt32(countAt, count - ranges.length, true);
  return out;
}

/** Default talisman charge count (GVars.dbf TALIS_CHRG; byte-verified: every entry in every
 *  shipped campaign map carries 5). The reference addItem uses this when no explicit count. */
export const DEFAULT_TALISMAN_CHARGES = 5;

/**
 * Locate the MidTalismanCharges entry table. Verified layout (Riders bytes + toolsqt
 * D2TalismanCharges.h, they agree): after `BEGOBJECT\0` — `<blockId(10)> int32 entryCount`,
 * then entryCount 34-byte entries `ID_TALIS [0B 00 00 00] <MidItem-instance-id(10)> NUL ·
 * CHARGES int32`. Walks with tag validation and FAILS LOUD on any layout surprise.
 * Returns null when the map has no block (all 54 shipped maps have one, but stay lenient
 * like the plan locator — absence just skips the side-table maintenance).
 */
function locateTalismanCharges(
  buf: ByteBuffer,
): { countAt: number; count: number; entries: { start: number; end: number; ref: string }[] } | null {
  const avc = buf.indexOf(".?AVCMidTalismanCharges@@");
  if (avc < 0) return null;
  const beg = buf.indexOf("BEGOBJECT", avc);
  if (beg < 0) throw new Error("MidTalismanCharges: BEGOBJECT not found after decl");
  let p = beg + 9;
  if (buf.bytes[p] === 0) p++;
  p += 10; // the block's own compound id doubles as the count-field tag
  const countAt = p;
  const count = buf.readInt32LE(countAt);
  let q = countAt + 4;
  const entries: { start: number; end: number; ref: string }[] = [];
  for (let i = 0; i < count; i++) {
    const start = q;
    if (buf.asciiSlice(q, q + 8) !== "ID_TALIS") {
      throw new Error(`MidTalismanCharges: entry ${i}: ID_TALIS expected at ${q}`);
    }
    q += 8;
    if (buf.readInt32LE(q) !== 11) {
      throw new Error(`MidTalismanCharges: entry ${i}: ref length != 11 at ${q}`);
    }
    q += 4;
    const ref = buf.asciiSlice(q, q + 10);
    q += 10 + 1; // + NUL
    if (buf.asciiSlice(q, q + 7) !== "CHARGES") {
      throw new Error(`MidTalismanCharges: entry ${i}: CHARGES expected at ${q}`);
    }
    q += 7 + 4;
    entries.push({ start, end: q, ref });
  }
  return { countAt, count, entries };
}

/**
 * Remove every MidTalismanCharges entry whose ID_TALIS references one of `ids` (deleted
 * MidItem instances), decrementing the entry count — the reference's D2MapEditor::removeItem
 * cascade. No block / no matching entry = no-op (non-talisman items have no entry).
 */
function purgeTalismanCharges(bytes: Uint8Array, ids: ReadonlySet<string>): Uint8Array {
  const buf = new ByteBuffer(bytes);
  const tc = locateTalismanCharges(buf);
  if (!tc) return bytes;
  const ranges = tc.entries.filter((e) => ids.has(e.ref));
  if (ranges.length === 0) return bytes;
  ranges.sort((a, b) => b.start - a.start);
  let out = bytes;
  for (const r of ranges) {
    const next = new Uint8Array(out.length - (r.end - r.start));
    next.set(out.subarray(0, r.start), 0);
    next.set(out.subarray(r.end), r.start);
    out = next;
  }
  // countAt precedes every entry, so the splices above never moved it
  new DataView(out.buffer, out.byteOffset, out.byteLength).setInt32(
    tc.countAt,
    tc.count - ranges.length,
    true,
  );
  return out;
}

/** One talisman-charges entry to add: a freshly minted talisman MidItem instance. */
export interface TalismanEntry {
  /** the MidItem INSTANCE compound id (e.g. "S143IM002f") — NOT the GItem template. */
  itemId: string;
  charges: number;
}

/**
 * ADD MidTalismanCharges entries — the add-side counterpart of the purge, mirroring the
 * reference's D2MapEditor::addItem (a talisman item gets `{talismanId, count}` appended).
 * Inserted after the existing entries, bumping the count. No block = no-op (lenient, like
 * addPlanEntries — createBlankMap always emits an empty one).
 */
export function addTalismanCharges(bytes: Uint8Array, entries: readonly TalismanEntry[]): Uint8Array {
  if (entries.length === 0) return bytes;
  const buf = new ByteBuffer(bytes);
  const tc = locateTalismanCharges(buf);
  if (!tc) return bytes;
  const w = new ByteWriter();
  for (const e of entries) {
    w.refField("ID_TALIS", e.itemId);
    w.defaultInt("CHARGES", e.charges);
  }
  const region = w.toBytes();
  const insertAt = tc.entries.length
    ? tc.entries[tc.entries.length - 1]!.end
    : tc.countAt + 4;
  const out = new Uint8Array(bytes.length + region.length);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(region, insertAt);
  out.set(bytes.subarray(insertAt), insertAt + region.length);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setInt32(
    tc.countAt,
    tc.count + entries.length,
    true,
  );
  return out;
}

/** One variable-length string field edit: where to find it + the new value. */
export interface StringFieldEdit {
  /** the object's BEGOBJECT+1 offset (raw.objectById fieldsFrom) */
  fieldsFrom: number;
  /** the object's ENDOBJECT offset (raw.objectById fieldsEnd) */
  fieldsEnd: number;
  /** the field tag, e.g. "NAME_TXT" / "TITLE" / "DESC_TXT" / "DESC" */
  tag: string;
  /** the new string value (CP1251-encoded; stored as int32 len(+NUL) + bytes + NUL) */
  value: string;
}

/** One count-prefixed ITEM_ID list edit (the chest item list). The new ordered list of
 *  MidItem instance ids replaces the whole `objId + int32(count) + N×ITEM_ID` tail. */
export interface ItemListEdit {
  /** the object's fieldsFrom (raw.objectById) */
  fieldsFrom: number;
  /** the object's fieldsEnd (raw.objectById) */
  fieldsEnd: number;
  /** the object's full 10-char compound id — the list count's tag (D2's writeDefaultInt(objId,count)). */
  objId: string;
  /** the new ordered list of MidItem instance ids (each a 10-char compound id). */
  instanceIds: readonly string[];
}

/** One site STOCK list edit (merchant items / mage spells / mercenary units). Unlike the
 *  chest ITEM_ID list, the count is keyed by a LITERAL `qtyTag` (not the objId) and the
 *  entries are GLOBAL template ids written directly (no MidItem/MidUnit instances). */
export interface QtyListEdit {
  fieldsFrom: number;
  fieldsEnd: number;
  qtyTag: string; // "QTY_ITEM" | "QTY_SPELL" | "QTY_UNIT"
  /** the per-entry field layout, in order (used to walk the OLD entries + write the new). */
  schema: { tag: string; kind: "str" | "int" | "bool" }[];
  /** new entries; each row's values are aligned to `schema`. */
  entries: (string | number | boolean)[][];
}

interface Splice {
  start: number;
  end: number;
  region: Uint8Array;
}

/** Build the splice that rewrites one site stock list (QTY_* tag + count + entries) in place. */
function qtyListSplice(buf: ByteBuffer, e: QtyListEdit): Splice {
  const at = buf.indexOf(e.qtyTag, e.fieldsFrom);
  if (at < 0 || at >= e.fieldsEnd) {
    throw new Error(`spliceVariableFields: stock tag ${e.qtyTag} not found in [${e.fieldsFrom},${e.fieldsEnd}]`);
  }
  // walk the OLD entries to find the span end (so we replace exactly the old list)
  let p = at + e.qtyTag.length;
  const oldCount = buf.readInt32LE(p);
  p += 4;
  for (let i = 0; i < oldCount; i++) {
    for (const fld of e.schema) {
      p += fld.tag.length;
      if (fld.kind === "str") p += 4 + buf.readInt32LE(p);
      else if (fld.kind === "int") p += 4;
      else p += 1;
    }
  }
  const w = new ByteWriter();
  w.cp(e.qtyTag).i32(e.entries.length);
  for (const row of e.entries) {
    e.schema.forEach((fld, j) => {
      const v = row[j];
      if (fld.kind === "str") w.stringField(fld.tag, String(v));
      else if (fld.kind === "int") w.defaultInt(fld.tag, Number(v));
      else w.bool(fld.tag, Boolean(v));
    });
  }
  return { start: at, end: p, region: w.toBytes() };
}

/** Build the splice for one variable-length string field (resize in place). */
function stringFieldSplice(buf: ByteBuffer, e: StringFieldEdit): Splice {
  const at = tagValueOffset(buf, e.tag, e.fieldsFrom, e.fieldsEnd);
  if (at === null) {
    throw new Error(`spliceVariableFields: field ${e.tag} not found in [${e.fieldsFrom},${e.fieldsEnd}]`);
  }
  const oldLen = buf.readInt32LE(at); // stored length = byteLen + 1 (incl trailing NUL)
  const enc = encodeCp1251(e.value);
  const region = new Uint8Array(4 + enc.length + 1); // int32 len + bytes + NUL(0)
  new DataView(region.buffer).setInt32(0, enc.length + 1, true);
  region.set(enc, 4);
  return { start: at, end: at + 4 + oldLen, region };
}

/**
 * Build the splice for one ITEM_ID list. The list is `objId + int32(count) + N×ITEM_ID`
 * written LAST in the object (verified against D2Bag), so the count's objId-tag (the
 * editor's writeDefaultInt(header.version+objId, count)) is the LAST occurrence of objId
 * in the field range, and [thatOffset, fieldsEnd] is exactly the count+items region.
 */
function itemListSplice(buf: ByteBuffer, e: ItemListEdit): Splice {
  const start = buf.lastIndexOf(e.objId, e.fieldsEnd);
  if (start < e.fieldsFrom) {
    throw new Error(`spliceVariableFields: item-list count tag ${e.objId} not found in [${e.fieldsFrom},${e.fieldsEnd}]`);
  }
  const w = new ByteWriter();
  w.cp(e.objId).i32(e.instanceIds.length);
  for (const id of e.instanceIds) w.refField("ITEM_ID", id);
  return { start, end: e.fieldsEnd, region: w.toBytes() };
}

/**
 * Stack (MidStack) inventory ITEM_ID list. Unlike a chest, the list sits MID-block (after
 * POS_0..5, before STACK_ID/SRCTMPL_ID) and the objId ALSO appears as the GROUP_ID/STACK_ID
 * ref VALUES — so neither lastIndexOf nor "replace to fieldsEnd" works. The bare count tag is
 * the objId occurrence NOT preceded by a refField length prefix (0B 00 00 00) — every ref VALUE
 * is, the count tag (preceded by POS_5's int32 ∈ {-1..5}) is not. We then walk the OLD N entries
 * to bound the span and replace EXACTLY that region.
 */
function stackCountTagOffset(buf: ByteBuffer, objId: string, from: number, end: number): number {
  let at = buf.indexOf(objId, from);
  while (at >= 0 && at < end) {
    const p = at - 4;
    const isRefValue =
      p >= 0 && buf.bytes[p] === 0x0b && buf.bytes[p + 1] === 0 && buf.bytes[p + 2] === 0 && buf.bytes[p + 3] === 0;
    if (!isRefValue) return at;
    at = buf.indexOf(objId, at + 1);
  }
  return -1;
}
function stackItemListSplice(buf: ByteBuffer, e: ItemListEdit): Splice {
  const start = stackCountTagOffset(buf, e.objId, e.fieldsFrom, e.fieldsEnd);
  if (start < 0) {
    throw new Error(`spliceVariableFields: stack item-list count tag ${e.objId} not found in [${e.fieldsFrom},${e.fieldsEnd}]`);
  }
  let p = start + e.objId.length;
  const oldCount = buf.readInt32LE(p);
  p += 4;
  for (let i = 0; i < oldCount; i++) {
    p += "ITEM_ID".length;
    p += 4 + buf.readInt32LE(p); // int32 len + payload (10-char id + NUL)
  }
  const w = new ByteWriter();
  w.cp(e.objId).i32(e.instanceIds.length);
  for (const id of e.instanceIds) w.refField("ITEM_ID", id);
  return { start, end: p, region: w.toBytes() }; // replace ONLY the old list span (mid-block safe)
}

/** Apply pre-computed splices to `bytes`, HIGHEST-offset-first so lower ranges stay valid. */
function applySplices(bytes: Uint8Array, splices: Splice[]): Uint8Array {
  if (splices.length === 0) return bytes;
  splices.sort((a, b) => b.start - a.start);
  let out = bytes;
  for (const s of splices) {
    const next = new Uint8Array(out.length - (s.end - s.start) + s.region.length);
    next.set(out.subarray(0, s.start), 0);
    next.set(s.region, s.start);
    next.set(out.subarray(s.end), s.start + s.region.length);
    out = next;
  }
  return out;
}

/**
 * M4 growable edit: rewrite variable-length STRING fields and count-prefixed ITEM_ID
 * lists in place, resizing the file. The `.sg` is purely marker-delimited (BEGOBJECT/
 * ENDOBJECT + tag scans) with only a header object-count and NO byte offset/size tables,
 * so a field can grow/shrink and the file stays valid — no fixups beyond the splice
 * itself. Object count is unchanged here (callers add/remove MidItem blocks separately
 * via appendBlocks). ALL offsets are computed UP FRONT on the input bytes, then splices
 * applied HIGHEST-offset-first so each lower range stays valid even across both kinds.
 */
export function spliceVariableFields(
  bytes: Uint8Array,
  stringEdits: readonly StringFieldEdit[],
  itemListEdits: readonly ItemListEdit[] = [],
  qtyListEdits: readonly QtyListEdit[] = [],
  stackItemListEdits: readonly ItemListEdit[] = [],
): Uint8Array {
  if (
    stringEdits.length === 0 && itemListEdits.length === 0 &&
    qtyListEdits.length === 0 && stackItemListEdits.length === 0
  ) return bytes;
  const buf = new ByteBuffer(bytes);
  const splices = [
    ...stringEdits.map((e) => stringFieldSplice(buf, e)),
    ...itemListEdits.map((e) => itemListSplice(buf, e)),
    ...qtyListEdits.map((e) => qtyListSplice(buf, e)),
    ...stackItemListEdits.map((e) => stackItemListSplice(buf, e)),
  ];
  return applySplices(bytes, splices);
}

/** Back-compat: string-field-only splice (used by existing callers/tests). */
export function spliceStringFields(bytes: Uint8Array, edits: readonly StringFieldEdit[]): Uint8Array {
  return spliceVariableFields(bytes, edits, []);
}

/** Append block frames to a `.sg` and bump the header object count. */
export function appendBlocks(bytes: Uint8Array, frames: Uint8Array[]): Uint8Array {
  if (frames.length === 0) return bytes.slice();
  const buf = new ByteBuffer(bytes);
  const firstWhat = buf.indexOf("WHAT");
  if (firstWhat < 0) throw new Error("appendBlocks: no object stream (no WHAT)");
  const obAt = buf.lastIndexOf("OB0000", firstWhat);
  if (obAt < 0) throw new Error("appendBlocks: OB0000 sentinel not found in header");
  const objCountAt = obAt + "OB0000".length;
  const objCount = buf.readInt32LE(objCountAt);

  const extra = frames.reduce((a, f) => a + f.length, 0);
  const out = new Uint8Array(bytes.length + extra);
  out.set(bytes, 0);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setInt32(
    objCountAt,
    objCount + frames.length,
    true,
  );
  let off = bytes.length;
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}
