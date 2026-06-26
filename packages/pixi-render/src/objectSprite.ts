/**
 * objectSprite — EXACT port of the editor's per-type image key (MapObjects/
 * ObjectAccessors.cpp :: <Type>Accessor::frameData). One key per object, built the
 * same way the editor builds it; the renderer then searches the asset store for that
 * exact key (animation -> AnimatedSprite, else static). No guessing, no fallback
 * candidates — if a key doesn't resolve, the object simply isn't drawn.
 *
 * Types that resolve through DBF tables (forts/capitals/villages via Grace/subrace,
 * stacks via Gunit, treasure/tomb/rod) are not ported here yet and return undefined
 * rather than a guessed key. They'll be added by porting their exact accessor + the
 * required DBF lookups.
 */
import type { MapObject } from "@d2/map-schema";

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

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

/** Extra context some accessors need to build their key. */
export interface SpriteKeyContext {
  /** terrain race index -> 2-letter code (Lterrain.dbf), for fort/capital sprites. */
  raceCodes?: Record<number, string>;
  /** whether this object's cell is water — selects the treasure (bag) variant. */
  water?: boolean;
}

/** The exact image/animation key for an object, or undefined if not drawable. */
export function objectSpriteKey(
  obj: MapObject,
  ctx?: SpriteKeyContext,
): string | undefined {
  switch (obj.type) {
    // MountainObjectAccessor: "MOMNE" + w(2) + image(2)   [IsoTerrn]
    case "mountains":
      return `MOMNE${pad(obj.w ?? 0, 2)}${pad(obj.image ?? 0, 2)}`;

    // LandmarkObjectAccessor: lmarkId.toUpper()            [IsoCmon, IsoAnim]
    case "landmark":
      return obj.baseType ? obj.baseType.toUpperCase() : undefined;

    // RuinObjectAccessor: "G000RU0000" + image(3)          [IsoCmon, IsoAnim]
    case "ruin":
      return `G000RU0000${pad(obj.image ?? 0, 3)}`;

    // MerchantObjectAccessor: "G000SI0000" + <TYPE> + image(2)
    case "merchant":
    case "mage":
    case "mercenary":
    case "trainer":
      return `G000SI0000${SITE_CODE[obj.type]}${pad(obj.image ?? 0, 2)}`;

    // CrystalObjectAccessor: CrystalIdByResource(resource)
    case "crystal":
      return CRYSTAL_ID[obj.resource ?? 0];

    // FortObjectAccessor (Capital): "G000FT0000" + race(2) + "0". Needs the race code.
    case "capital": {
      const code = ctx?.raceCodes?.[obj.race ?? -1];
      return code ? `G000FT0000${code}0` : undefined;
    }

    // FortObjectAccessor (Village): "G000FT0000NE" + level. (The editor prefers a
    // race-suffixed variant and falls back to this base, which always resolves.)
    case "village":
      return `G000FT0000NE${obj.tier ?? 1}`;

    // TreasureObjectAccessor: "G000BG0000" + (water ? 0 : 1) + image(2)
    case "treasure":
      return `G000BG0000${ctx?.water ? "0" : "1"}${pad(obj.image ?? 0, 2)}`;

    default:
      return undefined;
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
    default: // crystal, unit, generic -> base default 1x1
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
