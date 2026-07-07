/**
 * @d2/sg-parser writer — round-trip-safe `.sg` editing primitives.
 *
 * `parseScenarioRaw` yields a patchable byte index; `SgWriter` splices fixed-width
 * edits into a copy of the original bytes; `verify.*` proves integrity. The
 * op-aware layer (EditOp -> writer calls, semantic round-trip) lives in @d2/map-edit.
 */

export {
  splitScenario,
  joinScenario,
  type ScenarioBlock,
  type ScenarioBlocks,
} from "./sgBlocks.js";

export {
  parseScenarioRaw,
  stackDeleteCascade,
  villageDeleteCascade,
  bagDeleteCascade,
  ruinDeleteCascade,
  originKey,
  cellKey,
  type SgRaw,
  type SgObjectRaw,
  type SgBlockRaw,
  type SgRoadRaw,
  type StackDeleteCascade,
  type FortDeleteCascade,
} from "./sgRaw.js";
export { SgWriter } from "./patch.js";
export {
  appendBlocks,
  roadFrame,
  landmarkFrame,
  locationFrame,
  mountainsFrame,
  itemFrame,
  unitFrame,
  stackFrame,
  bagFrame,
  villageFrame,
  ruinFrame,
  siteFrame,
  type SiteKind,
  replaceBlock,
  deleteBlocks,
  addPlanEntries,
  parsePlanEntries,
  addTalismanCharges,
  DEFAULT_TALISMAN_CHARGES,
  spliceStringFields,
  spliceVariableFields,
  emitBlock,
  type MountainEntry,
  type StringFieldEdit,
  type ItemListEdit,
  type QtyListEdit,
  type PlanEntry,
  type TalismanEntry,
} from "./sgRebuild.js";
export {
  eventFrame,
  scenVariablesFrame,
  stackTemplateFrame,
  diplomacyFrame,
  splitMultiString,
} from "./eventFrame.js";
export { ByteWriter, EMPTY_REF } from "./byteWriter.js";
export { encodeCp1251, cp1251Length } from "./cp1251.js";
export {
  createBlankMap,
  FILL_VALUE,
  TERRAIN_FILLS,
  MOUNTAIN_CELL,
  RACES,
  RACE_KEYS,
  type RaceKey,
  type RaceDef,
  type TerrainFill,
  type BlankMountain,
  type BlankMapOptions,
} from "./createBlankMap.js";
export {
  roundTripIdentity,
  verifyCellOffsets,
  validateMap,
  verifyBlockIntegrity,
  bytesEqual,
  firstDiff,
  type ValidateResult,
} from "./verify.js";
