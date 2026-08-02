import { z } from "zod";
import { MapEvent } from "@d2/map-schema";
import { EditOp } from "./ops.js";

export const VOICE_CONTRACT_VERSION = 1 as const;

/** Validate against the editor schema without returning Zod's stripped/defaulted clone.
 * The voice service must round-trip forward-compatible event/effect fields it does not know. */
const LosslessMapEvent = z.custom<z.infer<typeof MapEvent>>(
  (value) => MapEvent.safeParse(value).success,
  { message: "Invalid MapEvent" },
);

export const VoiceAudioAsset = z.object({
  assetId: z.string(),
  kind: z.enum(["audio", "music"]),
  logicalName: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  size: z.number().int().nonnegative(),
});
export type VoiceAudioAsset = z.infer<typeof VoiceAudioAsset>;

/** Canonical editor → private voice-service snapshot. Only scenario events cross the boundary. */
export const DialogHandoffV1 = z.object({
  contractVersion: z.literal(VOICE_CONTRACT_VERSION),
  sourceProjectId: z.string().regex(/^[a-f0-9]{64}$/i),
  sourceMapId: z.string(),
  mapName: z.string(),
  mapRevision: z.string().regex(/^[a-f0-9]{64}$/i),
  eventsRevision: z.string().regex(/^[a-f0-9]{64}$/i),
  eventHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/i)),
  events: z.array(LosslessMapEvent),
  returnPath: z.string(),
});
export type DialogHandoffV1 = z.infer<typeof DialogHandoffV1>;

export const DialogEventChange = z.object({
  eventId: z.string(),
  base: LosslessMapEvent.nullable(),
  next: LosslessMapEvent.nullable(),
});
export type DialogEventChange = z.infer<typeof DialogEventChange>;

/** Private voice-service → editor return envelope, fetched through the editor backend. */
export const DialogReturnV1 = z.object({
  contractVersion: z.literal(VOICE_CONTRACT_VERSION),
  returnId: z.string().regex(/^[a-f0-9]{64}$/i),
  sourceProjectId: z.string().regex(/^[a-f0-9]{64}$/i),
  sourceMapId: z.string(),
  baseRevision: z.string(),
  changedEvents: z.array(DialogEventChange),
  audio: z.array(VoiceAudioAsset),
  returnPath: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(["pending", "consumed"]),
});
export type DialogReturnV1 = z.infer<typeof DialogReturnV1>;

export interface VoiceHandoffResult {
  ok: true;
  launchUrl: string;
  project: { id: string; name: string; kind: string; linked: boolean };
  hasDraft?: boolean;
}

export interface VoiceConflict {
  eventId: string;
  eventName: string;
  editorSummary: string;
  voiceSummary: string;
}

export interface VoiceReturnPreview {
  returnId: string;
  sourceProjectId: string;
  currentEventsRevision: string;
  /** Hashes only for events touched by this return. Unrelated event/map edits do not block it. */
  currentEventHashes: Record<string, string>;
  autoEventIds: string[];
  alreadyAppliedEventIds: string[];
  conflicts: VoiceConflict[];
}

export interface VoiceReturnApplyResult {
  returnId: string;
  currentEventsRevision: string;
  ops: z.infer<typeof EditOp>[];
  uids: string[];
  acceptedEvents: z.infer<typeof MapEvent>[];
}
