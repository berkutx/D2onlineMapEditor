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

export const StackObject = z.object({
  ...base,
  type: z.literal("stack"),
  owner: z.string().optional(), // player uid
  leaderUnitId: z.string().optional(),
  leaderImage: z.string().optional(), // resolved iso sprite of the lead unit
  facing: z.number().int().optional(),
  banner: z.string().optional(),
  subRace: z.string().optional(), // SUBRACE uid -> MidSubRace (faction/banner)
  bannerIndex: z.number().int().optional(), // resolved subrace banner number
  garrisoned: z.boolean().optional(), // INSIDE a fort -> editor draws nothing
  order: z.number().int().optional(), // ORDER (1=Normal..3=Guard..); Guard => guard-range overlay
  units: z.array(z.string()).default([]),
  // formation by cell (POS 0..5) -> MidUnit INSTANCE id; used to resolve a linked fort garrison
  garrison: z.array(z.string().nullable()).optional(),
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
  // garrison: formation cell (POS 0..5) -> global Gunit id (resolved from the embedded
  // UNIT_0..5/POS_0..5 MidUnit instances, or the linked STACK fort-stack). null = empty cell.
  garrison: z.array(z.string().nullable()).optional(),
  stackRef: z.string().optional(), // STACK uid (linked-stack garrison form), if any
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
  garrison: z.array(z.string().nullable()).optional(), // formation cell -> Gunit id (see CapitalObject)
  stackRef: z.string().optional(), // STACK uid (linked-stack garrison form)
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
  item: z.string().optional(), // ITEM single artifact reward id ("000000" = none)
  priority: z.number().int().optional(), // AIPRIORITY 0..6
});

const SiteCommon = {
  ...base,
  name: z.string().default(""),
  image: z.number().int().optional(),
};
// Site STOCK lists carry GLOBAL template ids (NOT MidItem/MidUnit instances), count-prefixed
// by a literal QTY_* tag. Merchant sells items (+qty), mage sells spells, mercs hire units
// (+level/unique). Trainer has no stock.
export const MerchantObject = z.object({
  ...SiteCommon,
  type: z.literal("merchant"),
  items: z.array(z.object({ id: z.string(), count: z.number().int() })).optional(),
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
});
export const LandmarkObject = z.object({
  ...base,
  type: z.literal("landmark"),
  baseType: z.string().optional(), // resolves footprint+image from SLmark.dbf
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
});
export const TreasureObject = z.object({
  ...base,
  type: z.literal("treasure"),
  image: z.number().int().optional(), // MidBag IMAGE -> G000BG0000{0|1}{image}
  priority: z.number().int().optional(), // AIPRIORITY 0..6
  items: z.array(z.string()).optional(), // ITEM_ID list — the bag's contents
});

export const RodObject = z.object({
  ...base,
  type: z.literal("rod"),
  owner: z.string().optional(),
  race: z.number().int().optional(), // owner player's Grace index -> G000RR<rodRaceID>RROD8
});
export const TombObject = z.object({
  ...base,
  type: z.literal("tomb"), // constant sprite G000TB0000G
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
