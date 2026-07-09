import { z } from "zod";
import { TerrainGrid } from "./cells.js";
import { MapObject, StackTemplate } from "./objects.js";
import { MapEvent, ScenarioVariable } from "./events.js";

export const MapHeader = z.object({
  name: z.string().default(""),
  description: z.string().default(""),
  author: z.string().default(""),
  version: z.string().default(""), // e.g. "S143"
  size: z.number().int().positive(),
  difficulty: z
    .object({ scenario: z.number().int(), game: z.number().int() })
    .optional(),
  suggestedLevel: z.number().int().optional(),
  seed: z.number().int().optional(),
  /** BRIEFING — the short objective line shown at scenario start. */
  objective: z.string().optional(),
  /** BRIEFLONG1-5 joined — the long intro/story text ('_' multi-part convention). */
  story: z.string().optional(),
  /** DEBUNKW + DEBUNKW2-5 joined — the victory text. */
  winText: z.string().optional(),
  /** DEBUNKL — the defeat text. */
  loseText: z.string().optional(),
  /** Scenario caps: MAX_UNIT / MAX_SPELL / MAX_LEADER / MAX_CITY. */
  limits: z
    .object({
      unit: z.number().int(),
      spell: z.number().int(),
      leader: z.number().int(),
      city: z.number().int(),
    })
    .optional(),
  // ---- full ScenarioInfo field set (D2ScenarioInfo.h port) — additive/optional. ----
  campaign: z.string().optional(), // CAMPAIGN db ref (e.g. "C000CC0001")
  sourceM: z.boolean().optional(), // SOURCE_M value bool
  qtyCities: z.number().int().optional(), // QTY_CITIES
  flagO: z.boolean().optional(), // the single-letter "O" value bool
  curTurn: z.number().int().optional(), // CUR_TURN
  /** PLAYER_1..PLAYER_13 — fixed 13-int list (99 = closed slot). */
  playerSlots: z.array(z.number().int()).optional(),
  /** DEBUNKW,2..5 — the VERBATIM on-disk victory-text parts ('_' continuations intact).
   *  `winText` stays the derived joined/stripped view; parts are the byte-exact source. */
  winTextParts: z.array(z.string()).optional(),
  /** BRIEFLONG1..5 — the VERBATIM on-disk story parts (see winTextParts). */
  storyParts: z.array(z.string()).optional(),
});
export type MapHeader = z.infer<typeof MapHeader>;

/** One MidDiplomacy entry: relation between two RACES (Grace indices, as stored on disk).
 *  `relation` is the raw int32 — the 0..100 meter in the low bits (presets: 100=мир,
 *  49=нейтралитет, 0=война); possible alliance/war flags in high bits are preserved as-is. */
export const DiplomacyEntry = z.object({
  race1: z.number().int(),
  race2: z.number().int(),
  relation: z.number().int(),
});
export type DiplomacyEntry = z.infer<typeof DiplomacyEntry>;

export const PlayerInfo = z.object({
  id: z.string(), // player uid e.g. "PL0001"
  playerNo: z.number().int(), // 1..13
  race: z.number().int(),
  name: z.string().default(""),
  isHuman: z.boolean().default(false),
  color: z.string().optional(), // derived team color hex (#rrggbb)
  // ---- full MidPlayer field set (D2Player.h port, byte-verified) — all optional so old docs
  // stay valid; refs are kept VERBATIM (the byte-exact value incl. version prefix / sentinel). ----
  desc: z.string().optional(), // DESC_TXT
  lordId: z.string().optional(), // LORD_ID — global Glord db id (e.g. G000LR0013)
  raceId: z.string().optional(), // RACE_ID — global Grace db id (the string `race` is derived from)
  fogId: z.string().optional(), // FOG_ID -> MidFog block ref
  knownId: z.string().optional(), // KNOWN_ID -> PlayerKnownSpells block ref
  buildsId: z.string().optional(), // BUILDS_ID -> PlayerBuildings block ref
  face: z.number().int().optional(), // FACE portrait index
  qtyBreaks: z.number().int().optional(), // QTY_BREAKS
  bank: z.string().optional(), // BANK "G####:R####:Y####:E####:W####:B####"
  spellBank: z.string().optional(), // SPELL_BANK (same resource-string format)
  attitude: z.number().int().optional(), // ATTITUDE
  researchT: z.number().int().optional(), // RESEAR_T — research on this turn
  constructT: z.number().int().optional(), // CONSTR_T — construction on this turn
  spy1: z.string().optional(), // SPY_1 ref (G000000000 = none)
  spy2: z.string().optional(), // SPY_2
  spy3: z.string().optional(), // SPY_3
  capturedBy: z.string().optional(), // CAPT_BY ref
  /** ALWAYSAI — version-conditional on disk (EES or offset==0); present iff it was read. */
  alwaysAi: z.boolean().optional(),
  /** EXMAPID1-3 / EXMAPTURN1-3 — EES-only trailing group; present iff read. */
  exMapId1: z.string().optional(),
  exMapTurn1: z.number().int().optional(),
  exMapId2: z.string().optional(),
  exMapTurn2: z.number().int().optional(),
  exMapId3: z.string().optional(),
  exMapTurn3: z.number().int().optional(),
});
export type PlayerInfo = z.infer<typeof PlayerInfo>;

/** One MidSubRace table entry (D2SubRace.h port): the faction/banner record stacks & forts
 *  link via SUBRACE. Full field set — byte-exact model rebuild. */
export const SubRaceInfo = z.object({
  id: z.string(), // full uid, e.g. "S143SR0003"
  subrace: z.number().int(), // SUBRACE — LSubRace enum value
  playerId: z.string(), // PLAYER_ID ref (verbatim, e.g. "S143PL0000" or the nil sentinel)
  number: z.number().int(), // NUMBER
  name: z.string(), // NAME_TXT (CP1251)
  banner: z.number().int(), // BANNER — the sprite index stacks/forts resolve
});
export type SubRaceInfo = z.infer<typeof SubRaceInfo>;

/** A MidItem instance block: a scenario item living inside a chest / stack inventory (NOT a
 *  placed object). ITEM_TYPE = the global GItem template it instantiates. */
export const ItemInstance = z.object({
  id: z.string(), // ITEM_ID (self, e.g. S143IM0003)
  itemType: z.string(), // ITEM_TYPE — global GItem template id
});
export type ItemInstance = z.infer<typeof ItemInstance>;

/** A MidUnit instance block: a unit living inside a stack/fort garrison (NOT a placed object).
 *  Captured in FULL (impl/level/hp/xp/creation/name/modifiers) for a byte-exact model rebuild of
 *  the instance graph; the editor works with the resolved garrison and ignores this. */
export const UnitInstance = z.object({
  id: z.string(), // UNIT_ID (self, e.g. S143UN001a)
  implId: z.string().optional(), // TYPE — global Gunit template
  level: z.number().int().optional(), // LEVEL
  hp: z.number().int().optional(), // HP (current hit points)
  xp: z.number().int().optional(), // XP
  creation: z.number().int().optional(), // CREATION
  name: z.string().optional(), // NAME_TXT — custom unit name (omitted when empty)
  /** MODIF_ID list — level-up / equipment stat modifiers (global Gmodif refs), in file order. */
  modifiers: z.array(z.string()).optional(),
  /** TRANSF true → a polymorphed unit carrying a 5-field nested block we don't model. Such a unit
   *  is kept as a RAW block in the rebuild (never seen on shipped maps: 0 of 34k). */
  transformed: z.boolean().optional(),
});
export type UnitInstance = z.infer<typeof UnitInstance>;

// ---- satellite blocks: per-player state + playthrough logs (full ports of the reference's
// D2MapFog / D2PlayerSpells / D2PlayerBuildings / D2TalismanCharges / D2StackDestroyed /
// D2QuestLog / D2SpellCast / D2SpellEffects / D2TurnSummary). All typed, no raw bytes. ----

/** One MidgardMapFog row: the row's visibility bitmask (1 bit per cell, packed bytes — the
 *  mask bytes ARE the semantic value, like the packed terrain cell ints). */
export const FogRow = z.object({ y: z.number().int(), mask: z.array(z.number().int()) });
export const FogInfo = z.object({ id: z.string(), rows: z.array(FogRow) });
export type FogInfo = z.infer<typeof FogInfo>;

export const PlayerSpellsInfo = z.object({ id: z.string(), spells: z.array(z.string()) });
export type PlayerSpellsInfo = z.infer<typeof PlayerSpellsInfo>;

export const PlayerBuildingsInfo = z.object({ id: z.string(), buildings: z.array(z.string()) });
export type PlayerBuildingsInfo = z.infer<typeof PlayerBuildingsInfo>;

export const TalismanChargesInfo = z.object({
  id: z.string(),
  entries: z.array(z.object({ talisman: z.string(), charges: z.number().int() })), // ID_TALIS (MidItem instance) + CHARGES
});
export type TalismanChargesInfo = z.infer<typeof TalismanChargesInfo>;

export const StackDestroyedInfo = z.object({
  id: z.string(),
  entries: z.array(z.object({ stack: z.string(), killer: z.string(), srcTemplate: z.string() })),
});
export type StackDestroyedInfo = z.infer<typeof StackDestroyedInfo>;

export const QuestLogInfo = z.object({
  id: z.string(),
  entries: z.array(z.object({
    player: z.string(), seqNum: z.number().int(), curTurn: z.number().int(),
    type: z.number().int(), event: z.string(), effNum: z.number().int(),
  })),
});
export type QuestLogInfo = z.infer<typeof QuestLogInfo>;

/** MidSpellCast: two ints, both tagged with the block's own id on disk. Semantics unknown
 *  (0 on every authored map) — captured faithfully. */
export const SpellCastInfo = z.object({ id: z.string(), v1: z.number().int(), v2: z.number().int() });
export type SpellCastInfo = z.infer<typeof SpellCastInfo>;

export const SpellEffectsInfo = z.object({ id: z.string(), v: z.number().int() });
export type SpellEffectsInfo = z.infer<typeof SpellEffectsInfo>;

/** One TurnSummary log entry. TYPE (0..6) selects which optional payload fields exist —
 *  presence mirrors the on-disk variant exactly (refs/texts captured verbatim). */
export const TurnSummaryEntry = z.object({
  player: z.string(),
  type: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
  player2: z.string().optional(), // TYPE 0,1
  spell: z.string().optional(), // TYPE 0
  stackA: z.string().optional(), // TYPE 1
  strStackA: z.string().optional(), // TYPE 1
  stackD: z.string().optional(), // TYPE 0,1,2,5,6
  strStackD: z.string().optional(), // TYPE 0,1,2,5,6
  city: z.string().optional(), // TYPE 3 (the reference's data() forgets it — we write it)
  acquire: z.boolean().optional(), // TYPE 6
});
export type TurnSummaryEntry = z.infer<typeof TurnSummaryEntry>;
export const TurnSummaryInfo = z.object({ id: z.string(), entries: z.array(TurnSummaryEntry) });
export type TurnSummaryInfo = z.infer<typeof TurnSummaryInfo>;

/** The neutral, render-ready map document. Produced by @d2/sg-parser; consumed by
 *  the server, the Vue store, and the PixiJS renderer. The single source of truth. */
export const MapDocument = z.object({
  schemaVersion: z.string(),
  parserVersion: z.string().optional(),
  header: MapHeader,
  size: z.number().int().positive(),
  terrain: TerrainGrid,
  objects: z.array(MapObject),
  players: z.array(PlayerInfo).default([]),
  events: z.array(MapEvent).default([]),
  variables: z.array(ScenarioVariable).default([]),
  templates: z.array(StackTemplate).default([]),
  diplomacy: z.array(DiplomacyEntry).default([]),
  /** MidUnit / MidItem instance blocks — the graph that lives INSIDE stacks/forts/chests, kept for
   *  a byte-exact model rebuild. Optional + editor-transparent (the resolved garrison/inventory on
   *  the objects is what the UI uses). */
  instances: z
    .object({
      units: z.array(UnitInstance).default([]),
      items: z.array(ItemInstance).default([]),
    })
    .optional(),
  /** MidSubRace table — full records (bannerIndex resolution reads from here). Additive. */
  subraces: z.array(SubRaceInfo).optional(),
  /** Per-player satellite blocks + playthrough logs — fully typed (Stage D of the no-raw-bytes
   *  program). Editor-transparent; the rebuild re-emits each block from these records. */
  satellites: z
    .object({
      fogs: z.array(FogInfo).default([]),
      playerSpells: z.array(PlayerSpellsInfo).default([]),
      playerBuildings: z.array(PlayerBuildingsInfo).default([]),
      talismanCharges: z.array(TalismanChargesInfo).default([]),
      stackDestroyed: z.array(StackDestroyedInfo).default([]),
      questLogs: z.array(QuestLogInfo).default([]),
      spellCasts: z.array(SpellCastInfo).default([]),
      spellEffects: z.array(SpellEffectsInfo).default([]),
      turnSummaries: z.array(TurnSummaryInfo).default([]),
    })
    .optional(),
});
export type MapDocument = z.infer<typeof MapDocument>;
