export { SCHEMA_VERSION } from "./version.js";
export { Ground, ObjectType } from "./enums.js";
export type { GroundId } from "./enums.js";

export { MapCell, TerrainGrid } from "./cells.js";
export {
  MapObject,
  GarrisonUnit,
  TemplateUnit,
  StackTemplate,
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
export { MapDocument, MapHeader, PlayerInfo, DiplomacyEntry, ItemInstance, UnitInstance, SubRaceInfo } from "./document.js";
export {
  MapEvent,
  ScenarioVariable,
  EventCondition,
  EventEffect,
  EventRaces,
  CONDITION_SPECS,
  EFFECT_SPECS,
  STACK_ORDER_OPTIONS,
  CONDITION_BY_KIND,
  CONDITION_BY_CODE,
  EFFECT_BY_KIND,
  EFFECT_BY_CODE,
} from "./events.js";
export type { EventTypeSpec, EventFieldSpec } from "./events.js";

/** Iso transform constants (documented here; applied only in the renderer). */
export const ISO = {
  /** isoX = x - y */
  isoX: (x: number, y: number): number => x - y,
  /** isoY = (x + y) / 2 */
  isoY: (x: number, y: number): number => (x + y) / 2,
  /** D2 terrain tile width in px */
  tileW: 192,
} as const;
