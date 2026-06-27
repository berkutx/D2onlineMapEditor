/**
 * objectSprite — EXACT port of each editor accessor's FrameData LIST (MapObjects/
 * ObjectAccessors.cpp :: <Type>Accessor::frameData). An object is a STACK of
 * sub-sprites drawn in order (e.g. a land stack = leader body + banner; a fort =
 * building + banner).
 *
 * NO FALLBACKS, NO GUESSES (per project rule): every key is built the editor's way.
 * If a required input is missing (an unresolved race code, a missing leader, an
 * out-of-range enum) we THROW — we never silently draw nothing or substitute a
 * default sprite, because that hides data/logic bugs. The ONE tolerated branch is
 * the editor's OWN documented village two-try (race-suffixed key, else base), which
 * is the editor's behaviour, not our invention.
 *
 * Shadows (leader SSTO, boat BOAT, fort SHLV shield) are intentionally omitted for
 * now: they need the editor's "Shadows" preprocessing shader (deferred, see TODO.md).
 */
import type { MapObject } from "@d2/map-schema";

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

/** Fail loud: a required input for an object's sprite is missing/invalid. */
function fail(obj: MapObject, why: string): never {
  throw new Error(`objectSprites(${obj.type} ${obj.id}): ${why}`);
}

/** CrystalObject::CrystalIdByResource — resource enum GOLG..ELVES (0..5). */
const CRYSTAL_ID = [
  "G000CR0000GL", // GOLG
  "G000CR0000RD", // DEMONS
  "G000CR0000YE", // EMPIRE
  "G000CR0000RG", // UNDEAD
  "G000CR0000WH", // CLANS
  "G000CR0000GR", // ELVES
] as const;

/** MerchantObject::type -> site code (Items/Spells/Units/Trainer). */
const SITE_CODE: Record<string, string> = {
  merchant: "MERH", // Items
  mage: "MAGE", // Spells
  mercenary: "MERC", // Units
  trainer: "TRAI", // Trainer
};

/** RodObject::rodByRaceID — swaps gnoms(1)<->undead(3), else identity. */
const rodByRaceID = (k: number): number => (k === 1 ? 3 : k === 3 ? 1 : k);

/** A single drawable layer of an object (editor FrameData entry). */
export interface SubSprite {
  /** primary atlas key */
  key: string;
  /** fallback key tried only if `key` doesn't resolve (the editor's village two-try). */
  fallback?: string;
}

/** Extra context some accessors need to build their keys. */
export interface SpriteKeyContext {
  /** Grace race index -> 2-letter fort code (Grace.RACE_TYPE -> Lrace), capital/village. */
  graceFortCodes?: Record<number, string>;
  /** Grace race index -> Lrace key (RACE_TYPE int), for the rod sprite. */
  graceRaceType?: Record<number, number>;
  /** leader impl id -> boat race (Lrace key); present ONLY for boat-eligible leaders
   *  (not water_only, not flying). Absent => that leader shows its STOP frame on water. */
  unitBoat?: Record<string, number>;
  /** whether this object's cell is water (treasure variant + stack boat). */
  water?: boolean;
}

/** STACK_BANNER_<nn>00 — the faction banner flag (subrace.banner). */
function bannerSub(bannerIndex: number | undefined): SubSprite | null {
  if (bannerIndex === undefined) return null;
  return { key: `STACK_BANNER_${pad(bannerIndex, 2)}00` };
}

/** The ordered list of drawable sub-sprites for an object (editor FrameData list). */
export function objectSprites(
  obj: MapObject,
  ctx?: SpriteKeyContext,
): SubSprite[] {
  switch (obj.type) {
    // MountainObjectAccessor: "MOMNE" + w(2) + image(2)   [IsoTerrn]
    case "mountains":
      return [{ key: `MOMNE${pad(obj.w ?? 0, 2)}${pad(obj.image ?? 0, 2)}` }];

    // LandmarkObjectAccessor: lmarkId.toUpper()            [IsoCmon, IsoAnim]
    case "landmark":
      if (!obj.baseType) return fail(obj, "no baseType (TYPE) — cannot build landmark key");
      return [{ key: obj.baseType.toUpperCase() }];

    // RuinObjectAccessor: "G000RU0000" + image(3); destroyed/looted -> image+100
    // ("+100 to destructed", ObjectAccessors.cpp).
    case "ruin":
      return [{ key: `G000RU0000${pad((obj.image ?? 0) + (obj.looted ? 100 : 0), 3)}` }];

    // MerchantObjectAccessor: "G000SI0000" + <TYPE> + image(2)
    case "merchant":
    case "mage":
    case "mercenary":
    case "trainer":
      return [{ key: `G000SI0000${SITE_CODE[obj.type]}${pad(obj.image ?? 0, 2)}` }];

    // CrystalObjectAccessor: CrystalIdByResource((ResourceType)resource). resource is
    // the D2Crystal RESOURCE int cast straight to the 0..5 enum (NOT packed). Out of
    // range = bad data -> fail loud.
    case "crystal": {
      const res = obj.resource;
      if (res === undefined || res < 0 || res >= CRYSTAL_ID.length)
        return fail(obj, `RESOURCE ${res} out of range 0..${CRYSTAL_ID.length - 1}`);
      return [{ key: CRYSTAL_ID[res]! }];
    }

    // FortObjectAccessor (Capital): building "G000FT0000" + race(2) + "0", + banner.
    case "capital": {
      if (obj.race === undefined) return fail(obj, "no owner race resolved (owner -> player.race)");
      const code = ctx?.graceFortCodes?.[obj.race];
      if (!code) return fail(obj, `no graceFortCodes entry for race ${obj.race}`);
      const subs: SubSprite[] = [{ key: `G000FT0000${code}0` }];
      const banner = bannerSub(obj.bannerIndex);
      if (banner) subs.push(banner);
      return subs;
    }

    // FortObjectAccessor (Village): "G000FT0000NE" + level + ownerRaceCode, with the
    // editor's fallback to base "NE" + level; + banner.
    case "village": {
      if (obj.race === undefined) return fail(obj, "no owner race resolved (owner -> player.race)");
      const code = ctx?.graceFortCodes?.[obj.race];
      if (!code) return fail(obj, `no graceFortCodes entry for race ${obj.race}`);
      const tier = obj.tier ?? 1;
      // editor's OWN two-try: race-suffixed key, else base "NE"+level (ObjectAccessors).
      const subs: SubSprite[] = [
        { key: `G000FT0000NE${tier}${code}`, fallback: `G000FT0000NE${tier}` },
      ];
      const banner = bannerSub(obj.bannerIndex);
      if (banner) subs.push(banner);
      return subs;
    }

    // TreasureObjectAccessor: "G000BG0000" + (water ? 0 : 1) + image(2)
    case "treasure":
      return [{ key: `G000BG0000${ctx?.water ? "0" : "1"}${pad(obj.image ?? 0, 2)}` }];

    // RodObjectAccessor: "G000RR" + rodByRaceID(owner race -> Lrace key)(4) + "RROD8"
    case "rod": {
      if (obj.race === undefined) return fail(obj, "no owner race resolved (owner -> player.race)");
      const lr = ctx?.graceRaceType?.[obj.race];
      if (lr === undefined) return fail(obj, `no graceRaceType entry for race ${obj.race}`);
      return [{ key: `G000RR${pad(rodByRaceID(lr), 4)}RROD8` }];
    }

    // TombObjectAccessor: constant "G000TB0000G"
    case "tomb":
      return [{ key: "G000TB0000G" }];

    // StackObjectAccessor: garrisoned -> nothing; on water (boat-eligible leader) ->
    // boat body only; else leader STOP + banner. (Shadows omitted — see header.)
    case "stack": {
      // garrisoned (INSIDE a fort) -> editor draws nothing. Explicit editor behaviour,
      // not a fallback.
      if (obj.garrisoned) return [];
      const leader = obj.leaderImage;
      if (!leader) return fail(obj, "no leaderImage resolved (LEADER_ID -> unit.implId)");
      const facing = obj.facing ?? 0;
      const boatRace = ctx?.water ? ctx?.unitBoat?.[leader] : undefined;
      if (boatRace !== undefined) {
        // editor returns early on water: boat body, no banner.
        return [{ key: `G000RR000${boatRace}SBOA${facing}` }];
      }
      const subs: SubSprite[] = [{ key: `${leader}STOP${facing}` }];
      const banner = bannerSub(obj.bannerIndex);
      if (banner) subs.push(banner);
      return subs;
    }

    default:
      return [];
  }
}

/** Landmark id (UPPER) -> [cx, cy] footprint, from GLmark.dbf (objectdata.json). */
export type LandmarkFootprints = Record<string, [number, number]>;

/**
 * Object footprint in cells — a port of each accessor's getW/getH (the editor
 * centres the full sprite on this footprint's centre, see CustomMapObject). Base
 * default is 1x1 (MapObjectAccessor::getW/getH).
 */
export function objectFootprint(
  obj: MapObject,
  landmarks?: LandmarkFootprints,
): { w: number; h: number } {
  switch (obj.type) {
    case "mountains":
      return { w: obj.w ?? 1, h: obj.h ?? 1 };
    case "ruin": // RuinObjectAccessor::getW/getH = 3
    case "merchant": // MerchantObjectAccessor::getW/getH = 3
    case "mage":
    case "mercenary":
    case "trainer":
      return { w: 3, h: 3 };
    case "capital": // FortObjectAccessor: Capital = 5
      return { w: 5, h: 5 };
    case "village": // FortObjectAccessor: else = 4
    case "fort":
      return { w: 4, h: 4 };
    case "location": {
      const r = obj.radius ?? 1; // LocationObjectAccessor::getW/getH = r
      return { w: r, h: r };
    }
    case "landmark": {
      const fp = obj.baseType ? landmarks?.[obj.baseType.toUpperCase()] : undefined;
      return fp ? { w: fp[0], h: fp[1] } : { w: 1, h: 1 };
    }
    default: // crystal, unit, rod, tomb, treasure, generic -> base default 1x1
      return { w: 1, h: 1 };
  }
}

/** Painter's-order z base — a port of each accessor's getZ (default 15). */
export function objectZBase(obj: MapObject): number {
  switch (obj.type) {
    case "stack":
      return 15.2;
    case "unit":
      return 0;
    case "location":
      return 1300;
    default:
      return 15;
  }
}
