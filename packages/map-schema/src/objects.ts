import { z } from "zod";

/** Fields shared by every placed object. `id` is the compound .sg uid e.g. "ST0001".
 *  `pos` is the anchor cell (cartesian). `imageName` is the lookup key into the asset
 *  manifest (Contract B). `footprint` defaults to 1x1 when the object occupies one cell. */
const base = {
  id: z.string(),
  pos: z.object({ x: z.number().int(), y: z.number().int() }),
  footprint: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }).optional(),
  imageName: z.string().optional(),
  z: z.number().int().optional(),
};

/** One garrison/army slot's unit: a global Gunit id + its level and (max) HP. The .sg stores
 *  these as a MidUnit instance; the editor model carries the resolved global id + stats. */
export const GarrisonUnit = z.object({
  unit: z.string(), // global Gunit id (G###UU####)
  level: z.number().int().default(1),
  hp: z.number().int().default(0), // current HP (== max for a freshly placed unit)
});
export type GarrisonUnit = z.infer<typeof GarrisonUnit>;

/** One formation cell of a stack TEMPLATE (MidStackTemplate): a GLOBAL Gunit id + level. Unlike
 *  a placed stack (MidUnit instances), a template references unit TYPES directly — the block is
 *  self-contained (no dependent instance blocks). */
export const TemplateUnit = z.object({
  unit: z.string(), // global Gunit id
  level: z.number().int().default(1),
});
export type TemplateUnit = z.infer<typeof TemplateUnit>;

/** A reusable army template spawned by events (CREATE_NEW_STACK / MOVE_STACK effects). */
export const StackTemplate = z.object({
  id: z.string(), // on-disk compound id, e.g. "S143TM0000"
  name: z.string().default(""),
  owner: z.string().default(""), // player uid ("" = neutral/none)
  leader: z.string().default(""), // leader Gunit id
  leaderLevel: z.number().int().default(1),
  orderTarget: z.string().default(""),
  subRace: z.string().default(""),
  order: z.number().int().default(1),
  /** 6 formation cells (index = cell); null = empty. */
  units: z.array(TemplateUnit.nullable()).default([]),
  useFacing: z.boolean().default(false),
  facing: z.number().int().default(0),
  aiPriority: z.number().int().default(0),
  /** Unit-modifier list (preserved; advanced-edit later): per entry {unitPos, modifId Gmodif}. */
  modifiers: z.array(z.object({ unitPos: z.number().int(), modifId: z.string() })).default([]),
});
export type StackTemplate = z.infer<typeof StackTemplate>;

/** A stack leader's equipment slots — each a global item id ("000000"/undefined = empty). */
export const StackEquip = z.object({
  tome: z.string().optional(), // spellbook
  battle1: z.string().optional(),
  battle2: z.string().optional(),
  artifact1: z.string().optional(),
  artifact2: z.string().optional(),
  boots: z.string().optional(),
});
export type StackEquip = z.infer<typeof StackEquip>;

/**
 * Load-only byte-exact snapshot of a compound object's instance graph (the minted-id refs:
 * UNIT_0..5 / POS_0..5 / LEADER_ID / ITEM_ID). Editor-transparent; the semantic round-trip STRIPS
 * it — a PLACED/edited object mints fresh instance ids at export, so this can't match the
 * pre-export op. The resolved garrison/leader/inventory/scalars still compare exactly.
 */
export const InstanceRawSnapshot = z.object({
  unitSlots: z.array(z.string().nullable()).optional(),
  posOfCell: z.array(z.number().int()).optional(),
  leaderId: z.string().optional(),
  itemIds: z.array(z.string()).optional(),
});
export type InstanceRawSnapshot = z.infer<typeof InstanceRawSnapshot>;

export const StackObject = z.object({
  ...base,
  type: z.literal("stack"),
  owner: z.string().optional(), // player uid
  leaderUnitId: z.string().optional(), // raw LEADER_ID instance (reader → leaderCell post-pass)
  leaderCell: z.number().int().optional(), // formation cell (0..5) holding the leader/hero
  leaderImage: z.string().optional(), // resolved iso sprite of the lead unit
  facing: z.number().int().optional(), // 8 iso directions 0..7
  banner: z.string().optional(),
  subRace: z.string().optional(), // SUBRACE uid -> MidSubRace (faction/banner)
  bannerIndex: z.number().int().optional(), // resolved subrace banner number
  garrisoned: z.boolean().optional(), // INSIDE a fort -> editor draws nothing
  order: z.number().int().optional(), // ORDER (1=Normal,2=Stand,3=Guard,4=Attack,7=Roam,8=Move,9=Defend,10=Berserk)
  morale: z.number().int().optional(),
  move: z.number().int().optional(), // movement points
  priority: z.number().int().optional(), // AIPRIORITY 0..6
  creatLvl: z.number().int().optional(), // CREAT_LVL creature level
  equip: StackEquip.optional(), // leader equipment slots
  inventory: z.array(z.string()).optional(), // carried items (global GItem template ids)
  units: z.array(z.string()).optional(), // legacy/unused (formation lives in `garrison` now)
  inside: z.string().optional(), // INSIDE: a city/fort uid this stack is stationed in (a "visitor")
  // formation by cell (POS 0..5) -> {unit (global Gunit id), level, hp}; the stack's own army.
  // For a garrisoned/visiting stack this IS the city's "visitor" garrison (edited via the stack id).
  garrison: z.array(GarrisonUnit.nullable()).optional(),
  garrisonRaw: z.array(z.string().nullable()).optional(), // by-cell instance ids (reader → post-pass)
  // ---- full-parse scalars (byte-exact model rebuild). Omitted at their defaults so a placed/
  // default stack round-trips without a phantom field. ----
  aiOrder: z.number().int().optional(), // AIORDER (default 2 = Stand; ≠2 on ~99.8% of shipped stacks)
  aiOrderTarget: z.string().optional(), // AIORDERTAR ref
  orderTarget: z.string().optional(), // ORDER_TARG ref
  srcTemplate: z.string().optional(), // SRCTMPL_ID ref (the MidStackTemplate this was spawned from)
  leaderAlive: z.boolean().optional(), // LEADR_ALIV (default true)
  invisible: z.boolean().optional(), // INVISIBLE
  aiIgnore: z.boolean().optional(), // AI_IGNORE
  upgCount: z.number().int().optional(), // UPGCOUNT
  nbBattle: z.number().int().optional(), // NBBATTLE
  /** Load-only byte-exact snapshot of the instance graph (UNIT_/POS_/LEADER_ID/ITEM_ID). */
  raw: InstanceRawSnapshot.optional(),
});

export const FortObject = z.object({
  ...base,
  type: z.literal("fort"),
  owner: z.string().optional(),
  race: z.number().int().optional(),
  name: z.string().default(""),
});
export const CapitalObject = z.object({
  ...base,
  type: z.literal("capital"),
  owner: z.string().optional(),
  race: z.number().int().optional(),
  subRace: z.string().optional(), // SUBRACE uid -> MidSubRace (banner)
  bannerIndex: z.number().int().optional(), // resolved subrace banner number
  name: z.string().default(""),
  desc: z.string().optional(), // DESC_TXT
  priority: z.number().int().optional(), // AIPRIORITY 0..6
  // garrison = the city's OWN DEFENSE: formation cell (POS 0..5) -> {unit (global Gunit id),
  // level, hp}, resolved from the embedded UNIT_0..5/POS_0..5 MidUnit instances. null = empty.
  garrison: z.array(GarrisonUnit.nullable()).optional(),
  garrisonRaw: z.array(z.string().nullable()).optional(), // by-cell instance ids (reader → post-pass)
  stackRef: z.string().optional(), // STACK uid -> the visiting hero MidStack (the SECOND garrison)
  /** ITEM_ID list — the capital's stored items (addRace seeds 3× G000IG0006), resolved to GItem
   *  templates in the post-pass (like a chest). */
  items: z.array(z.string()).optional(),
  raw: InstanceRawSnapshot.optional(), // load-only byte-exact snapshot (garrison slots + item instances)
});
export const VillageObject = z.object({
  ...base,
  type: z.literal("village"),
  owner: z.string().optional(),
  race: z.number().int().optional(),
  subRace: z.string().optional(), // SUBRACE uid -> MidSubRace (banner)
  bannerIndex: z.number().int().optional(), // resolved subrace banner number
  name: z.string().default(""),
  desc: z.string().optional(), // DESC_TXT
  tier: z.number().int().default(1), // city level 1..5 (SIZE) -> City.ff sprite
  priority: z.number().int().optional(), // AIPRIORITY 0..6
  morale: z.number().int().optional(), // MORALE
  regen: z.number().int().optional(), // REGEN_B garrison regen
  growth: z.number().int().optional(), // GROWTH_T unit growth timer
  garrison: z.array(GarrisonUnit.nullable()).optional(), // formation cell -> unit (see CapitalObject)
  garrisonRaw: z.array(z.string().nullable()).optional(), // by-cell instance ids (reader → post-pass)
  stackRef: z.string().optional(),
  raw: InstanceRawSnapshot.optional(), // load-only byte-exact snapshot (garrison + captured-loot ITEM_ID)
});

export const RuinObject = z.object({
  ...base,
  type: z.literal("ruin"),
  name: z.string().default(""), // TITLE
  desc: z.string().optional(), // DESC
  image: z.number().int().optional(),
  looted: z.boolean().default(false), // derived: LOOTER != none
  looter: z.string().optional(), // raw LOOTER id (player uid / "000000")
  reward: z.string().optional(), // CASH reward string "G####:R####:Y####:E####:W####:B####"
  item: z.string().optional(), // ITEM single artifact reward — a GLOBAL GItem template id
  priority: z.number().int().optional(), // AIPRIORITY 0..6
  // the ruin's GUARDIANS (embedded GROUP_ID + UNIT_0..5/POS_0..5, like a fort's defense) —
  // byte-verified: every Riders ruin carries 2-5 MidUnit guards
  garrison: z.array(GarrisonUnit.nullable()).optional(), // formation cell -> unit
  garrisonRaw: z.array(z.string().nullable()).optional(), // by-cell instance ids (reader → post-pass)
  raw: InstanceRawSnapshot.optional(), // load-only byte-exact snapshot (guardian garrison)
});

const SiteCommon = {
  ...base,
  name: z.string().default(""),
  image: z.number().int().optional(),
  /** TXT_DESC — the visit-dialog text; read so a delete's undo re-adds it verbatim. */
  desc: z.string().optional(),
  /** AIPRIORITY — AI visit priority (default 0; some shipped sites carry 3). */
  aiPriority: z.number().int().optional(),
};
// Site STOCK lists carry GLOBAL template ids (NOT MidItem/MidUnit instances), count-prefixed
// by a literal QTY_* tag. Merchant sells items (+qty), mage sells spells, mercs hire units
// (+level/unique). Trainer has no stock.
export const MerchantObject = z.object({
  ...SiteCommon,
  type: z.literal("merchant"),
  items: z.array(z.object({ id: z.string(), count: z.number().int() })).optional(),
  /** BUY_* toggles [armor, jewel, weapon, banner, potion, scroll, wand, value] — which item
   *  categories the merchant buys back. Omitted (all true) on the vast majority of maps. */
  buy: z.array(z.boolean()).length(8).optional(),
  /** MISSION — non-default (true) on a handful of shipped merchants. Omitted when false. */
  mission: z.boolean().optional(),
});
export const MageObject = z.object({
  ...SiteCommon,
  type: z.literal("mage"),
  spells: z.array(z.string()).optional(),
});
export const TrainerObject = z.object({ ...SiteCommon, type: z.literal("trainer") });
export const MercenaryObject = z.object({
  ...SiteCommon,
  type: z.literal("mercenary"),
  units: z.array(z.object({ id: z.string(), level: z.number().int(), unique: z.boolean() })).optional(),
});

export const MountainsObject = z.object({
  ...base,
  type: z.literal("mountains"),
  idMount: z.number().int().optional(), // ID_MOUNT — per-entry id (NOT sequential); kept for byte-exact rebuild
  image: z.number().int().optional(),
  race: z.number().int().optional(),
  // SIZE_X / SIZE_Y from the .sg entry. The editor's image key is
  // "MOMNE" + w(2) + image(2) (MountainObjectAccessor::frameData).
  w: z.number().int().optional(),
  h: z.number().int().optional(),
});
export const CrystalObject = z.object({
  ...base,
  type: z.literal("crystal"),
  resource: z.number().int().optional(), // mana type+amount packed
  priority: z.number().int().optional(), // AIPRIORITY — AI collection priority (default 3)
});
export const LandmarkObject = z.object({
  ...base,
  type: z.literal("landmark"),
  baseType: z.string().optional(), // resolves footprint+image from SLmark.dbf
  /** DESC_TXT — the author's CP1251 name/label for this decoration (e.g. "Топь", "Фонтан").
   *  Modeled by the reference's D2LandMark; our parser used to drop it (lossy re-serialize).
   *  Optional + omitted when empty (like baseType) so an unnamed landmark round-trips cleanly. */
  desc: z.string().optional(),
});
export const LocationObject = z.object({
  ...base,
  type: z.literal("location"),
  name: z.string().default(""),
  radius: z.number().int().default(0),
});
export const UnitObject = z.object({
  ...base,
  type: z.literal("unit"),
  implId: z.string().optional(), // unit impl -> IsoUnit/IsoStill sprite
  level: z.number().int().optional(), // MidUnit LEVEL
  hp: z.number().int().optional(), // MidUnit HP (current)
});
export const TreasureObject = z.object({
  ...base,
  type: z.literal("treasure"),
  image: z.number().int().optional(), // MidBag IMAGE -> G000BG0000{0|1}{image}
  priority: z.number().int().optional(), // AIPRIORITY 0..6
  items: z.array(z.string()).optional(), // ITEM_ID list — the bag's contents (resolved to templates)
  raw: InstanceRawSnapshot.optional(), // load-only byte-exact snapshot (ITEM_ID instance refs)
});

export const RodObject = z.object({
  ...base,
  type: z.literal("rod"),
  owner: z.string().optional(),
  race: z.number().int().optional(), // owner player's Grace index -> G000RR<rodRaceID>RROD8
});
/** One MidTomb epitaph: a stack that died on this cell — owner, killer, turn, stack name. */
export const TombEpitaph = z.object({
  owner: z.string(), // STACK_OWNR player ref
  killer: z.string(), // KILLER player ref
  turn: z.number().int(), // TURN
  name: z.string(), // STACK_NAME (CP1251)
});
export type TombEpitaph = z.infer<typeof TombEpitaph>;

export const TombObject = z.object({
  ...base,
  type: z.literal("tomb"), // constant sprite G000TB0000G
  /** QTY_EP epitaph list — playthrough state (tombs appear only in campaign saves, 0 on
   *  authored maps); modeled so a save round-trips through the full rebuild. */
  epitaphs: z.array(TombEpitaph).optional(),
});

/** Fallback for any block type the parser does not yet model: keeps the map renderable
 *  and round-trippable while @d2/sg-parser fills in concrete types. */
export const GenericObject = z.object({
  ...base,
  type: z.literal("generic"),
  blockType: z.string(), // the .?AVC TypeName
  raw: z.record(z.unknown()).default({}),
});

export const MapObject = z.discriminatedUnion("type", [
  StackObject,
  FortObject,
  CapitalObject,
  VillageObject,
  RuinObject,
  MerchantObject,
  MageObject,
  TrainerObject,
  MercenaryObject,
  MountainsObject,
  CrystalObject,
  LandmarkObject,
  LocationObject,
  UnitObject,
  TreasureObject,
  RodObject,
  TombObject,
  GenericObject,
]);
export type MapObject = z.infer<typeof MapObject>;
