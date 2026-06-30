export { SCHEMA_VERSION } from "./version.js";
export { Ground, ObjectType } from "./enums.js";
export type { GroundId } from "./enums.js";

export { MapCell, TerrainGrid } from "./cells.js";
export {
  MapObject,
  GarrisonUnit,
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
} from "./objects.js";
export { MapDocument, MapHeader, PlayerInfo } from "./document.js";

/** Iso transform constants (documented here; applied only in the renderer). */
export const ISO = {
  /** isoX = x - y */
  isoX: (x: number, y: number): number => x - y,
  /** isoY = (x + y) / 2 */
  isoY: (x: number, y: number): number => (x + y) / 2,
  /** D2 terrain tile width in px */
  tileW: 192,
} as const;
