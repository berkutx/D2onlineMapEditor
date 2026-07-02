/**
 * @d2/sg-parser writer — round-trip-safe `.sg` editing primitives.
 *
 * `parseScenarioRaw` yields a patchable byte index; `SgWriter` splices fixed-width
 * edits into a copy of the original bytes; `verify.*` proves integrity. The
 * op-aware layer (EditOp -> writer calls, semantic round-trip) lives in @d2/map-edit.
 */

export {
  parseScenarioRaw,
  originKey,
  cellKey,
  type SgRaw,
  type SgObjectRaw,
  type SgBlockRaw,
  type SgRoadRaw,
} from "./sgRaw.js";
export { SgWriter } from "./patch.js";
export {
  appendBlocks,
  roadFrame,
  landmarkFrame,
  mountainsFrame,
  itemFrame,
  unitFrame,
  stackFrame,
  replaceBlock,
  deleteBlocks,
  spliceStringFields,
  spliceVariableFields,
  emitBlock,
  type MountainEntry,
  type StringFieldEdit,
  type ItemListEdit,
  type QtyListEdit,
} from "./sgRebuild.js";
export { eventFrame } from "./eventFrame.js";
export { ByteWriter, EMPTY_REF } from "./byteWriter.js";
export { encodeCp1251, cp1251Length } from "./cp1251.js";
export {
  createBlankMap,
  FILL_VALUE,
  TERRAIN_FILLS,
  MOUNTAIN_CELL,
  type TerrainFill,
  type BlankMountain,
  type BlankMapOptions,
} from "./createBlankMap.js";
export {
  roundTripIdentity,
  verifyCellOffsets,
  validateMap,
  bytesEqual,
  firstDiff,
  type ValidateResult,
} from "./verify.js";
