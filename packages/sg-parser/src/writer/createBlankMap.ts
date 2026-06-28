/**
 * createBlankMap — emit a brand-new, game-loadable `.sg` terrain skeleton FROM
 * SCRATCH (no base file), fillable with default land / water / snow, plus mountains.
 *
 * This is a faithful port of toolsqt `D2MapEditor::createMap` + `commitGrid` +
 * `MapHeaderBlock::data` + every block's `data()` (read verbatim from the
 * NevendaarTools sources). Nothing here is guessed: block codes, TypeNames, field
 * order and the header layout all come from that source, cross-checked against a
 * real game map (Riders.sg).
 *
 * Verified facts baked in:
 *  - Grid default fill = 5 (D2MapEditor::createMap: m_grid.init(size, 5)).
 *  - Cell value bits: terrain=v&7, ground=(v>>3)&7 (water=3, mountain=4), forest=v>>>26.
 *    default=5, water=29, snow=2 (Mountain-Clans terrain idx 2), mountain cell=37.
 *  - Header `offset` = firstObjectOffset - 30 (invariant observed on every real map;
 *    computed here rather than toolsqt's hardcoded 2760).
 *  - Block order = createMap's 15 singletons, then commitGrid's MidgardMapBlock chunks
 *    (8 cols x 4 rows, id = (row<<8)|col).
 *
 * Caveats (load is the user's gold check — open in the game's own editor):
 *  - The neutral player's FOG_ID references S143FG0000 with no fog block emitted —
 *    this is exactly what createMap does; the game is expected to init fog on load.
 *  - `_playersData` header blob is left empty (createMap/emptyInit leave it empty).
 */

import { ByteWriter, EMPTY_REF } from "./byteWriter.js";
import { cp1251Length } from "./cp1251.js";

const VERSION = "S143";

/**
 * Base terrain fills. Land fills set the terrain (race) tile-set index (v & 7);
 * "water" sets ground=3. Terrain ids from Lterrain: 1=HU Empire, 2=DW Mountain-Clans
 * (snow), 3=HE Legions, 4=UN Undead, 5=NE Neutral, 6=EL Elves.
 */
export type TerrainFill =
  | "default"
  | "water"
  | "snow"
  | "empire"
  | "legions"
  | "undead"
  | "elf";

/** Packed int32 cell values per fill (terrain | (ground<<3)). */
export const FILL_VALUE: Record<TerrainFill, number> = {
  default: 5, // NE neutral land, ground 0
  water: 29, // terrain 5 + ground 3 (water)
  snow: 2, // DW Mountain-Clans (snow)
  empire: 1, // HU Empire
  legions: 3, // HE Legions
  undead: 4, // UN Undead
  elf: 6, // EL Elves
};

/** All fill ids (for server validation + the New Map UI). */
export const TERRAIN_FILLS = Object.keys(FILL_VALUE) as TerrainFill[];
/** A cell stamped under a mountain footprint: terrain 5, ground 4 (mountain). */
export const MOUNTAIN_CELL = 37;

export interface BlankMountain {
  x: number;
  y: number;
  w: number;
  h: number;
  image?: number;
  race?: number;
}

export interface BlankMapOptions {
  /** Map dimension N (cells per side). Must be a positive multiple of 8. */
  size: number;
  /** Base terrain fill. Default "default" (neutral land). */
  fill?: TerrainFill;
  /** Scenario name (also the header name). Default "my test". */
  name?: string;
  /** Scenario description. Default "". */
  description?: string;
  /** Scenario author/creator. Default "". */
  author?: string;
  /** Optional mountains (object + a 37-stamp on their footprint cells). */
  mountains?: BlankMountain[];
}

const hex4 = (n: number): string => (n >>> 0).toString(16).padStart(4, "0");
const fullId = (short: string, second: number): string => VERSION + short + hex4(second);

export function createBlankMap(opts: BlankMapOptions): Uint8Array {
  const size = opts.size;
  if (!Number.isInteger(size) || size <= 0 || size % 8 !== 0) {
    throw new Error(`createBlankMap: size must be a positive multiple of 8 (got ${size})`);
  }
  const fill = opts.fill ?? "default";
  const name = opts.name ?? "my test";
  const description = opts.description ?? "";
  const author = opts.author ?? "";
  const mountains = opts.mountains ?? [];

  if (cp1251Length(name) > 64) throw new Error("createBlankMap: name too long (max 64 bytes)");
  if (cp1251Length(description) > 256) throw new Error("createBlankMap: description too long (max 256)");
  if (cp1251Length(author) > 21) throw new Error("createBlankMap: author too long (max 21)");

  // ---- grid -----------------------------------------------------------------
  const grid = new Int32Array(size * size).fill(FILL_VALUE[fill]);
  for (const m of mountains) {
    for (let i = 0; i < m.w; i++) {
      for (let k = 0; k < m.h; k++) {
        const x = m.x + i;
        const y = m.y + k;
        if (x >= 0 && y >= 0 && x < size && y < size) grid[y * size + x] = MOUNTAIN_CELL;
      }
    }
  }

  const numChunks = (size / 4) * (size / 8);
  const objCount = 15 + numChunks;

  const w = new ByteWriter();

  // ---- header (MapHeaderBlock::data, D2EESFISIG branch — verbatim) ----------
  w.cp("D2EESFISIG");
  w.raw([0, 0]);
  w.i32(-1);
  const offsetAt = w.length; // patch with firstObjectOffset - 30 once header is built
  w.i32(0);
  w.raw([0x01, 0, 0, 0, 0x23, 0, 0, 0, 0, 0, 0, 0]);
  w.cp(VERSION + "SC0000");
  w.u8(0);
  w.cp(description).repitable(0, 256 - cp1251Length(description));
  w.cp(author).repitable(0, 21 - cp1251Length(author));
  w.u8(0); // writeBool("", strategyFirst=false)
  w.cp(name).repitable(0, 64 - cp1251Length(name));
  w.repitable(0, 192);
  w.i32(size); // mapSize
  w.i32(1).i32(0).i32(0); // unknown1/2/3
  w.cp("C000CC0001");
  w.repitable(0, 1);
  w.raw([1, 0, 0, 0, 1]); // _unknownBits (emptyInit: [0]=1,[4]=1)
  w.cp("Гоудфрой").repitable(0, 16 - cp1251Length("Гоудфрой"));
  w.repitable(0, 1065 - 6); // _unknownData
  w.i32(190); // _unknownInt1
  w.repitable(0, 1000); // _unknownData2
  w.i32(0); // _unknownPadding count -> writeDefaultInt("", 0)
  // _playersData — the game's CScenarioInfo::StreamRaces reads this blob:
  //   i32(playerCount) + playerCount * 40-byte record (first i32 = race index, rest 0).
  // An EMPTY blob makes the game read the "S143" sentinel as a huge count and crash.
  // Decoded from real maps: neutral race index = 4 (matches RACE_ID RR0004).
  w.i32(1); // one player (the neutral), matching the single MidPlayer block
  w.i32(4).repitable(0, 36); // neutral race record
  w.cp(VERSION);
  w.cp("OB0000");
  w.i32(objCount);
  w.patchI32(offsetAt, w.length - 30);

  // ---- block frame helper ---------------------------------------------------
  const frame = (type: string, code: number, short: string, second: number, body: (f: string) => void): void => {
    const f = fullId(short, second);
    w.blockHeader(type, code);
    w.refField("OBJ_ID", f);
    w.begin();
    body(f);
    w.end();
  };

  // ---- 15 singletons, in createMap order ------------------------------------
  frame("MidStackDestroyed", 0x19, "SD", 0, (f) => w.defaultInt(f, 0));

  frame("ScenarioInfo", 0x14, "IF", 0, (f) => {
    w.refField("INFO_ID", f);
    w.stringField("CAMPAIGN", "C000CC0001");
    w.bool("SOURCE_M", false);
    w.defaultInt("QTY_CITIES", 0);
    w.stringField("NAME", name);
    w.stringField("DESC", description);
    w.stringField("BRIEFING", "Цели сценария не определены");
    // writeMultyStringPart: empty next & empty current -> ""; else current + "_"
    w.stringField("DEBUNKW", "Поздравляем! Вы победили в этом сценарии._" + "_");
    w.stringField("DEBUNKW2", "");
    w.stringField("DEBUNKW3", "");
    w.stringField("DEBUNKW4", "");
    w.stringField("DEBUNKW5", "");
    w.stringField("DEBUNKL", "Вы потерпели поражение, враги достигли своей цели.");
    w.stringField("BRIEFLONG1", "Цели сценария_" + "_");
    w.stringField("BRIEFLONG2", "");
    w.stringField("BRIEFLONG3", "");
    w.stringField("BRIEFLONG4", "");
    w.stringField("BRIEFLONG5", "");
    w.bool("O", false);
    w.defaultInt("CUR_TURN", 0);
    w.defaultInt("MAX_UNIT", 2);
    w.defaultInt("MAX_SPELL", 2);
    w.defaultInt("MAX_LEADER", 3);
    w.defaultInt("MAX_CITY", 5);
    w.defaultInt("MAP_SIZE", size);
    w.defaultInt("DIFFSCEN", 3);
    w.defaultInt("DIFFGAME", 1);
    w.stringField("CREATOR", author);
    for (let i = 0; i < 13; i++) w.defaultInt(`PLAYER_${i + 1}`, i === 0 ? 4 : 99);
    w.defaultInt("SUGG_LVL", 1);
    w.defaultInt("MAP_SEED", 390690065);
  });

  frame("MidMountains", 0x14, "ML", 0, (f) => {
    w.defaultInt(f, mountains.length);
    mountains.forEach((m, i) => {
      w.defaultInt("ID_MOUNT", i);
      w.defaultInt("SIZE_X", m.w);
      w.defaultInt("SIZE_Y", m.h);
      w.defaultInt("POS_X", m.x);
      w.defaultInt("POS_Y", m.y);
      w.defaultInt("IMAGE", m.image ?? 0);
      w.defaultInt("RACE", m.race ?? 0);
    });
  });

  frame("MidQuestLog", 0x13, "QL", 0, (f) => w.defaultInt(f, 0));
  frame("MidgardPlan", 0x13, "PN", 0, (f) => {
    w.defaultInt(f, size); // plan.size = grid columns = N
    w.defaultInt(f, 0); // no plan elements
  });
  frame("MidgardMap", 0x12, "MP", 0, (f) => w.defaultInt(f, size));
  frame("MidScenVariables", 0x18, "SV", 0, (f) => w.defaultInt(f, 0));
  frame("TurnSummary", 0x13, "TS", 0, (f) => w.defaultInt(f, 0));
  frame("MidTalismanCharges", 0x1a, "TC", 0, (f) => w.defaultInt(f, 0));
  frame("MidSpellEffects", 0x17, "ET", 0, (f) => w.defaultInt(f, 0));
  frame("MidSpellCast", 0x14, "ST", 0, (f) => {
    w.defaultInt(f, 0);
    w.defaultInt(f, 0);
  });
  frame("MidDiplomacy", 0x14, "DP", 0, (f) => w.defaultInt(f, 0));

  frame("MidPlayer", 0x11, "PL", 0, (f) => {
    w.refField("PLAYER_ID", f);
    w.stringField("NAME_TXT", "Нейтралы");
    w.stringField("DESC_TXT", "Описание расы отсутствует");
    w.stringField("LORD_ID", "G000LR0013");
    w.stringField("RACE_ID", "G000RR0004");
    w.refField("FOG_ID", `${VERSION}FG0000`);
    w.refField("KNOWN_ID", `${VERSION}KS0000`);
    w.refField("BUILDS_ID", `${VERSION}PB0000`);
    w.defaultInt("FACE", 1);
    w.defaultInt("QTY_BREAKS", 0);
    w.stringField("BANK", "G0000:R0000:Y0000:E0000:W0000:B0000");
    w.bool("IS_HUMAN", false);
    w.stringField("SPELL_BANK", "G0000:R0000:Y0000:E0000:W0000:B0000");
    w.defaultInt("ATTITUDE", 1);
    w.defaultInt("RESEAR_T", 0);
    w.defaultInt("CONSTR_T", 0);
    w.refField("SPY_1", EMPTY_REF);
    w.refField("SPY_2", EMPTY_REF);
    w.refField("SPY_3", EMPTY_REF);
    w.refField("CAPT_BY", EMPTY_REF);
    w.bool("ALWAYSAI", false);
    w.refField("EXMAPID1", EMPTY_REF);
    w.defaultInt("EXMAPTURN1", 0);
    w.refField("EXMAPID2", EMPTY_REF);
    w.defaultInt("EXMAPTURN2", 0);
    w.refField("EXMAPID3", EMPTY_REF);
    w.defaultInt("EXMAPTURN3", 0);
  });

  frame("PlayerBuildings", 0x17, "PB", 0, (f) => w.defaultInt(f, 0));
  frame("PlayerKnownSpells", 0x19, "KS", 0, (f) => w.defaultInt(f, 0));

  // ---- MidgardMapBlock chunks (commitGrid order) ----------------------------
  for (let i = 0; i < size; i += 4) {
    // row origin
    for (let k = 0; k < size; k += 8) {
      // col origin
      const second = (i << 8) | k;
      frame("MidgardMapBlock", 0x17, "MB", second, (f) => {
        w.refField("BLOCKID", f);
        w.defaultInt("BLOCKDATA", 128);
        for (let q = 0; q < 32; q++) {
          const x = k + (q % 8);
          const y = i + Math.floor(q / 8);
          w.i32(grid[y * size + x]!);
        }
      });
    }
  }

  return w.toBytes();
}
