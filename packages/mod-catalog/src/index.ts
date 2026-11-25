export {
  MOD_SCHEMA_VERSION,
  ModId,
  Sha256,
  BlobPath,
  ModStatus,
  Capability,
  ModSummary,
  ModIndex,
  ModSource,
  ModManifest,
  summaryOf,
} from "./manifest.js";
export { GlobalId, TableCode, ID_TABLES, IdSets, tableOf } from "./ids.js";
export type { KnownTableCode, GlobalIdRefs } from "./ids.js";
export { ModRace, ModProfile, raceFacts, raceCategories } from "./profile.js";
export type { RaceFacts } from "./profile.js";
export {
  ScenVariablePreset,
  ScenVariableDef,
  ScenVariableGroup,
  ScenVariableCatalog,
  findScenVariable,
  variableForms,
  readVariable,
  writeVariable,
  setRule,
  unsupportedVariables,
} from "./scenVariables.js";
export type { ScenVariableValue, ScenVariableForm, RuleChange, UnsupportedVariable } from "./scenVariables.js";
export {
  UNRESOLVED_GLOBAL_ID,
  UNRESOLVED_SCRIPT_ID,
  UNKNOWN_SCEN_VARIABLE,
  UNSUPPORTED_CAPABILITY,
  CompatibilityIssue,
  CompatibilityReport,
  ModCompatibility,
  ModDetection,
  indexIdSets,
  scoreCompatibility,
  detectMod,
  variableIssues,
} from "./compat.js";
export type { ModCandidateInput, IdIndex } from "./compat.js";
