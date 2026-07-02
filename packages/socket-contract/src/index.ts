export { ScenarioEntry, MapMeta, ValidationReport, REST, Region, GenerateRequest, CopilotRequest } from "./rest.js";
export type { GenerateResult, CopilotResult, GenDebug } from "./rest.js";
export { EditOp, OpAck, ScenarioInfoPatch } from "./ops.js";
export { UserPresence } from "./presence.js";
export {
  EVENTS,
} from "./events.js";
export type {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
} from "./events.js";

export const SOCKET_CONTRACT_VERSION = "0.1.0" as const;
