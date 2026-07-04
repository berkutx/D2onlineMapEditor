/**
 * @d2/map-edit — the editor's logical layer over Contracts A & C.
 *
 * - bits:           terrain cell bit pack/unpack for brushes
 * - ops:            applyOp/applyOps (in-memory) + inverse for undo
 * - applyBytes:     EditOp journal -> byte patches via the sg-parser writer
 * - verifySemantic: round-trip (bytes -> doc) === (model applied ops)
 * - relations:      editor-only object links (inference + cascade are M5 stubs)
 * - project:        EditorProject diff/undo format (our own save format)
 */

export * from "./bits.js";
export * from "./ops.js";
export * from "./brush.js";
// selective (not *): brush.js already re-exports roadTypeFromMask — a second star export
// would make the symbol ambiguous and ESM would silently DROP it from the barrel
export { roadOverlay, type RoadOverlay, type CellPatch } from "./roadOverlay.js";
export * from "./roadSelect.js";
export * from "./zones.js";
export * from "./place.js";
export * from "./generate.js";
export * from "./applyBytes.js";
export * from "./verifySemantic.js";
export * from "./mechanics.js";
export * from "./relations.js";
export * from "./cascade.js";
export * from "./project.js";
