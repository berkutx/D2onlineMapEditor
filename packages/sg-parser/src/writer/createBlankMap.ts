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

/**
 * Playable races for `addRace` (port of toolsqt D2MapEditor::addRace, lines 97-207).
 * Constants extracted VERBATIM from the game's Globals DBFs (Grace.dbf / Glord.dbf /
 * Gunits.dbf, deletion-flagged rows skipped) — do not re-derive:
 *   Grace: RACE_ID, RACE_TYPE, GUARDIAN, LEADER_1;
 *   Glord: the race's category-0 («воин») lord;
 *   Gunits: base LEVEL=1 HIT_POINT for the guardian/leader (addUnit at base level
 *   writes hp = unit->hit_point — the dyn-upgrade math only kicks in above base level).
 * `terrain` = the Lterrain id addRace stamps 5×5 under the capital (raw cell value).
 */
export type RaceKey = "empire" | "legions" | "clans" | "undead" | "elves";
export interface RaceDef {
  raceId: string;
  raceType: number;
  guardian: string;
  guardianHp: number;
  leader: string;
  leaderHp: number;
  lord: string;
  terrain: number;
  name: string;
}
export const RACES: Record<RaceKey, RaceDef> = {
  empire: { raceId: "G000RR0000", raceType: 0, guardian: "G000UU3001", guardianHp: 900, leader: "G000UU0019", leaderHp: 135, lord: "G000LR0003", terrain: 1, name: "Империя" },
  legions: { raceId: "G000RR0001", raceType: 3, guardian: "G000UU3002", guardianHp: 900, leader: "G000UU0044", leaderHp: 200, lord: "G000LR0006", terrain: 3, name: "Легионы Проклятых" },
  clans: { raceId: "G000RR0002", raceType: 2, guardian: "G000UU3003", guardianHp: 900, leader: "G000UU0070", leaderHp: 150, lord: "G000LR0009", terrain: 2, name: "Горные Кланы" },
  undead: { raceId: "G000RR0003", raceType: 1, guardian: "G000UU3004", guardianHp: 900, leader: "G000UU0096", leaderHp: 135, lord: "G000LR0012", terrain: 4, name: "Орды Нежити" },
  elves: { raceId: "G000RR0005", raceType: 5, guardian: "G000UU8040", guardianHp: 900, leader: "G000UU8009", leaderHp: 135, lord: "G000LR0018", terrain: 6, name: "Эльфийский Союз" },
};
export const RACE_KEYS = Object.keys(RACES) as RaceKey[];

/** addRace's capital starting item — 3× G000IG0006 (verbatim constant; not a talisman,
 *  so no TalismanCharges entry). */
const CAPITAL_ITEM = "G000IG0006";

/** Preset capital anchors (the reference takes a user click; a blank map spreads them
 *  to the corners / top edge, 5×5 footprint kept in bounds with a margin). */
function capitalSpot(index: number, size: number): { x: number; y: number } {
  const m = 6;
  const far = size - m - 5;
  const mid = Math.floor(size / 2) - 2;
  const spots = [
    { x: m, y: m },
    { x: far, y: far },
    { x: m, y: far },
    { x: far, y: m },
    { x: mid, y: m },
  ];
  return spots[index % spots.length]!;
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
  /** Playable races to add (each = player + fog + capital + guardian + hero, the
   *  addRace port). Order picks the capital corner. Max 5. */
  races?: RaceKey[];
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
  const races = opts.races ?? [];
  if (races.length > 5) throw new Error("createBlankMap: max 5 races");
  for (const r of races) if (!RACES[r]) throw new Error(`createBlankMap: unknown race '${r}'`);
  if (size < 24 && races.length > 0) throw new Error("createBlankMap: races need size >= 24");

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
  // addRace: stamp the race's Lterrain value on the 5×5 under each capital (raw cell
  // value = the terrain id; the reference writes it verbatim, no ground bits).
  races.forEach((key, idx) => {
    const spot = capitalSpot(idx, size);
    const t = RACES[key].terrain;
    for (let i = 0; i < 5; i++)
      for (let k = 0; k < 5; k++) grid[(spot.y + k) * size + (spot.x + i)] = t;
  });

  const numChunks = (size / 4) * (size / 8);
  // 15 createMap singletons + the neutral player's own MidgardMapFog (FG0000) — every player
  // needs a fog block, incl. neutral, or its FOG_ID dangles and the game won't load the map.
  // + the MidSubRace table (gold-checked as REQUIRED by the game editor): 1 neutral SR + 8
  // fixed neutral-special SRs (subrace 6..13) + 1 per race player.
  // per race: fog + buildings + spells + player + capital + guardian unit + hero unit +
  // hero stack + 3 capital items = 10 blocks
  const SUBRACE_FIXED = 9; // neutral SR0000 + 8 neutral-special tail (subrace 6..13)
  const objCount = 16 + SUBRACE_FIXED + numChunks + races.length * (10 + 1);

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
  // Decoded from real maps: neutral race index = 4 (matches RACE_ID RR0004). With races
  // this is updateSubraces verbatim: one record per MidPlayer in block order.
  const playerRaceTypes = [4, ...races.map((r) => RACES[r].raceType)];
  w.i32(playerRaceTypes.length);
  for (const rt of playerRaceTypes) w.i32(rt).repitable(0, 36);
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
    // updateSubraces: PLAYER_i = each player's race_type (block order), 99 for unused slots
    for (let i = 0; i < 13; i++) w.defaultInt(`PLAYER_${i + 1}`, playerRaceTypes[i] ?? 99);
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

  // MidgardMapFog per player: entryCount(tag=own id) + per row POS_Y + FOG(size/8, all dark).
  // EVERY player references its OWN fog by player index (Riders: player n -> FGn) — the neutral
  // needs one too, else its FOG_ID = FG0000 dangles and the GAME editor refuses to load the map
  // (createMap alone omits it — this is why a from-scratch base failed the gold check).
  const emitFog = (second: number): void => {
    frame("MidgardMapFog", 0x15, "FG", second, (f) => {
      w.defaultInt(f, size);
      for (let y = 0; y < size; y++) {
        w.defaultInt("POS_Y", y);
        w.cp("FOG").i32(size / 8).repitable(0, size / 8);
      }
    });
  };
  emitFog(0); // neutral player's fog (FG0000)

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

  // ---- MidSubRace table (gold-checked REQUIRED: without it the game editor refuses the
  // map). Verbatim structure extracted from 28 real campaign maps (no guessing):
  //   • one neutral SR (SUBRACE 5, PLAYER=neutral, BANNER 4) — always SR0000;
  //   • one per race player (SUBRACE = raceType+1, verified Empire0→1/Undead1→2/Clans2→3/
  //     Neutral4→5; BANNER = SUBRACE-1) — SR<playerNo>, the id the capital's SUBRACE refs;
  //   • the fixed neutral-special tail SUBRACE 6..13 (BANNER 5..12), identical across every
  //     real map — the game's neutral factions (greenskins/marsh/…).
  // Trailing SUBRACE=0 blocks (per-map, tied to placed neutral units) are omitted: a blank
  // map has none. Code 0x12, short "SR".
  const NIL = EMPTY_REF;
  const subRaceBlock = (second: number, subrace: number, playerId: string, banner: number): void => {
    frame("MidSubRace", 0x12, "SR", second, (f) => {
      w.refField("SUBRACE_ID", f);
      w.defaultInt("SUBRACE", subrace);
      w.refField("PLAYER_ID", playerId);
      w.defaultInt("NUMBER", 0);
      w.stringField("NAME_TXT", "");
      w.defaultInt("BANNER", banner);
    });
  };
  const neutralId = fullId("PL", 0);
  subRaceBlock(0, 5, neutralId, 4); // SR0000: neutral player's subrace
  races.forEach((key, idx) => {
    const sub = RACES[key].raceType + 1; // verified: subrace = raceType + 1
    subRaceBlock(idx + 1, sub, fullId("PL", idx + 1), sub - 1); // SR<playerNo>, banner=sub-1
  });
  // fixed neutral-special tail SR (subrace 6..13, banner 5..12), ids after the race SRs
  for (let s = 6; s <= 13; s++) subRaceBlock(races.length + 1 + (s - 6), s, neutralId, s - 1);

  // ---- races (D2MapEditor::addRace, verbatim port) --------------------------
  // Block order per addRace's replace/addDataBlock sequence: fog, buildings, spells,
  // player, 3 capital items, guardian unit, hero unit, capital, hero stack.
  // Ids follow m_idsHelper.nextId per type: neutral owns PL0000/PB0000/KS0000/FG0000; race
  // #idx gets PL/PB/KS/FG(idx+1), FT/KC(idx), UN(idx*2, idx*2+1), IM(idx*3..+2). FOG is keyed
  // by PLAYER index (matching Riders: player n -> FGn), NOT the race index — the neutral's
  // FG0000 already exists above. The capital's SUBRACE ref = SR<playerNo> (emitted above).
  races.forEach((key, idx) => {
    const race = RACES[key];
    const spot = capitalSpot(idx, size);
    const playerNo = idx + 1;
    const playerId = fullId("PL", playerNo);
    const fogId = fullId("FG", playerNo);
    const pbId = fullId("PB", playerNo);
    const ksId = fullId("KS", playerNo);
    const capitalId = fullId("FT", idx);
    const guardianId = fullId("UN", idx * 2);
    const heroId = fullId("UN", idx * 2 + 1);
    const stackId = fullId("KC", idx);
    // capital.subRace = {IDataBlock::SubRace, player.uid.second} — an "SR"+playerNo ref
    // (the reference does NOT create a MidSubRace block; the game editor materializes
    // them on re-save — matching toolsqt output exactly).
    const subRaceId = fullId("SR", playerNo);
    const itemIds = [0, 1, 2].map((n) => fullId("IM", idx * 3 + n));

    // fog for this race's player (FG = playerNo; the neutral fog FG0000 was emitted above)
    emitFog(playerNo);

    frame("PlayerBuildings", 0x17, "PB", playerNo, (f) => w.defaultInt(f, 0));
    frame("PlayerKnownSpells", 0x19, "KS", playerNo, (f) => w.defaultInt(f, 0));

    // player: same body as the neutral above, with addRace's values (bank with 100 gold,
    // face 0, the race's category-0 lord).
    frame("MidPlayer", 0x11, "PL", playerNo, (f) => {
      w.refField("PLAYER_ID", f);
      w.stringField("NAME_TXT", race.name);
      w.stringField("DESC_TXT", "");
      w.stringField("LORD_ID", race.lord);
      w.stringField("RACE_ID", race.raceId);
      w.refField("FOG_ID", fogId);
      w.refField("KNOWN_ID", ksId);
      w.refField("BUILDS_ID", pbId);
      w.defaultInt("FACE", 0);
      w.defaultInt("QTY_BREAKS", 0);
      w.stringField("BANK", "G0100:R0000:Y0000:E0000:W0000:B0000");
      w.bool("IS_HUMAN", false);
      w.stringField("SPELL_BANK", "G0000:R0000:Y0000:E0000:W0000:B0000");
      w.defaultInt("ATTITUDE", 1);
      w.defaultInt("RESEAR_T", 0);
      w.defaultInt("CONSTR_T", 0);
      w.refField("SPY_1", NIL);
      w.refField("SPY_2", NIL);
      w.refField("SPY_3", NIL);
      w.refField("CAPT_BY", NIL);
      w.bool("ALWAYSAI", false);
      w.refField("EXMAPID1", NIL);
      w.defaultInt("EXMAPTURN1", 0);
      w.refField("EXMAPID2", NIL);
      w.defaultInt("EXMAPTURN2", 0);
      w.refField("EXMAPID3", NIL);
      w.defaultInt("EXMAPTURN3", 0);
    });

    // 3 capital items (addItem: MidItem instance per G000IG0006; not a talisman)
    for (const im of itemIds) {
      frame("MidItem", 0x0f, "IM", parseInt(im.slice(6), 16), (f) => {
        w.refField("ITEM_ID", f);
        w.refField("ITEM_TYPE", CAPITAL_ITEM);
      });
    }

    // guardian + hero unit instances (unitFrame body, byte-verified)
    const unit = (second: number, typeId: string, hp: number, unitName: string): void => {
      frame("MidUnit", 0x0f, "UN", second, (f) => {
        w.refField("UNIT_ID", f);
        w.refField("TYPE", typeId);
        w.defaultInt("LEVEL", 1);
        w.defaultInt(f, 0); // MODIF list count (tag = own id)
        w.defaultInt("CREATION", 0);
        w.stringField("NAME_TXT", unitName);
        w.bool("TRANSF", false);
        w.bool("DYNLEVEL", false);
        w.defaultInt("HP", hp);
        w.defaultInt("XP", 0);
      });
    };
    unit(idx * 2, race.guardian, race.guardianHp, "");
    unit(idx * 2 + 1, race.leader, race.leaderHp, "Герой");

    // capital (body order byte-verified on Riders FT0000): guardian in cell 2 (pos[2]=0)
    frame("Capital", 0x0f, "FT", idx, (f) => {
      w.refField("CITY_ID", f);
      w.stringField("NAME_TXT", `Столица (${race.name})`);
      w.stringField("DESC_TXT", "");
      w.refField("OWNER", playerId);
      w.refField("SUBRACE", subRaceId);
      w.refField("STACK", stackId);
      w.defaultInt("POS_X", spot.x);
      w.defaultInt("POS_Y", spot.y);
      w.refField("GROUP_ID", f);
      w.refField("UNIT_0", guardianId);
      for (let i = 1; i < 6; i++) w.refField(`UNIT_${i}`, NIL);
      const pos = [-1, -1, 0, -1, -1, -1]; // capital.stack.pos[2] = 0 (slot 0 in cell 2)
      for (let i = 0; i < 6; i++) w.defaultInt(`POS_${i}`, pos[i]!);
      w.defaultInt(f, itemIds.length); // item list count (tag = own id)
      for (const im of itemIds) w.refField("ITEM_ID", im);
      w.defaultInt("AIPRIORITY", 0);
    });

    // hero stack (stackFrame body order, byte-verified) — hero leads from cell 2,
    // inside the capital; addRace: move=35, aiorder=1.
    frame("MidStack", 0x10, "KC", idx, (f) => {
      w.refField("GROUP_ID", f);
      w.refField("UNIT_0", heroId);
      for (let i = 1; i < 6; i++) w.refField(`UNIT_${i}`, NIL);
      const pos = [-1, -1, 0, -1, -1, -1]; // stack.pos[2] = 0
      for (let i = 0; i < 6; i++) w.defaultInt(`POS_${i}`, pos[i]!);
      w.defaultInt(f, 0); // carried-items count
      w.refField("STACK_ID", f);
      w.refField("SRCTMPL_ID", NIL);
      w.refField("LEADER_ID", heroId);
      w.bool("LEADR_ALIV", true);
      w.defaultInt("POS_X", spot.x);
      w.defaultInt("POS_Y", spot.y);
      w.defaultInt("MORALE", 0);
      w.defaultInt("MOVE", 35);
      w.defaultInt("FACING", 0);
      w.refField("BANNER", NIL);
      w.refField("TOME", NIL);
      w.refField("BATTLE1", NIL);
      w.refField("BATTLE2", NIL);
      w.refField("ARTIFACT1", NIL);
      w.refField("ARTIFACT2", NIL);
      w.refField("BOOTS", NIL);
      w.refField("OWNER", playerId);
      w.refField("INSIDE", capitalId);
      w.refField("SUBRACE", subRaceId);
      w.bool("INVISIBLE", false);
      w.bool("AI_IGNORE", false);
      w.defaultInt("UPGCOUNT", 0);
      w.defaultInt("ORDER", 1); // Normal
      w.refField("ORDER_TARG", NIL);
      w.defaultInt("AIORDER", 1); // addRace: heroStack.aiorder = 1
      w.refField("AIORDERTAR", NIL);
      w.defaultInt("AIPRIORITY", 3);
      w.defaultInt("CREAT_LVL", 1);
      w.defaultInt("NBBATTLE", 0);
    });
  });

  return w.toBytes();
}
