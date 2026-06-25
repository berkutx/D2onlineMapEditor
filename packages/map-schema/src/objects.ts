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
  units: z.array(z.string()).default([]),
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
  name: z.string().default(""),
});
export const VillageObject = z.object({
  ...base,
  type: z.literal("village"),
  owner: z.string().optional(),
  race: z.number().int().optional(),
  name: z.string().default(""),
  tier: z.number().int().default(1), // city level 1..5 -> City.ff sprite
});

export const RuinObject = z.object({
  ...base,
  type: z.literal("ruin"),
  name: z.string().default(""),
  image: z.number().int().optional(),
  looted: z.boolean().default(false),
});

const SiteCommon = {
  ...base,
  name: z.string().default(""),
  image: z.number().int().optional(),
};
export const MerchantObject = z.object({ ...SiteCommon, type: z.literal("merchant") });
export const MageObject = z.object({ ...SiteCommon, type: z.literal("mage") });
export const TrainerObject = z.object({ ...SiteCommon, type: z.literal("trainer") });
export const MercenaryObject = z.object({ ...SiteCommon, type: z.literal("mercenary") });

export const MountainsObject = z.object({
  ...base,
  type: z.literal("mountains"),
  image: z.number().int().optional(),
  race: z.number().int().optional(),
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
  GenericObject,
]);
export type MapObject = z.infer<typeof MapObject>;
