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

/** The exact image/animation key for an object, or undefined if not drawable. */
export function objectSpriteKey(obj: MapObject): string | undefined {
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

    default:
      return undefined;
  }
}
