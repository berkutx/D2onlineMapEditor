import { z } from "zod";
import { TerrainGrid } from "./cells.js";
import { MapObject, StackTemplate } from "./objects.js";
import { MapEvent, ScenarioVariable } from "./events.js";

export const MapHeader = z.object({
  name: z.string().default(""),
  description: z.string().default(""),
  author: z.string().default(""),
  version: z.string().default(""), // e.g. "S143"
  size: z.number().int().positive(),
  difficulty: z
    .object({ scenario: z.number().int(), game: z.number().int() })
    .optional(),
  suggestedLevel: z.number().int().optional(),
  seed: z.number().int().optional(),
  /** BRIEFING — the short objective line shown at scenario start. */
  objective: z.string().optional(),
  /** BRIEFLONG1-5 joined — the long intro/story text ('_' multi-part convention). */
  story: z.string().optional(),
  /** DEBUNKW + DEBUNKW2-5 joined — the victory text. */
  winText: z.string().optional(),
  /** DEBUNKL — the defeat text. */
  loseText: z.string().optional(),
  /** Scenario caps: MAX_UNIT / MAX_SPELL / MAX_LEADER / MAX_CITY. */
  limits: z
    .object({
      unit: z.number().int(),
      spell: z.number().int(),
      leader: z.number().int(),
      city: z.number().int(),
    })
    .optional(),
});
export type MapHeader = z.infer<typeof MapHeader>;

/** One MidDiplomacy entry: relation between two RACES (Grace indices, as stored on disk).
 *  `relation` is the raw int32 — the 0..100 meter in the low bits (presets: 100=мир,
 *  49=нейтралитет, 0=война); possible alliance/war flags in high bits are preserved as-is. */
export const DiplomacyEntry = z.object({
  race1: z.number().int(),
  race2: z.number().int(),
  relation: z.number().int(),
});
export type DiplomacyEntry = z.infer<typeof DiplomacyEntry>;

export const PlayerInfo = z.object({
  id: z.string(), // player uid e.g. "PL0001"
  playerNo: z.number().int(), // 1..13
  race: z.number().int(),
  name: z.string().default(""),
  isHuman: z.boolean().default(false),
  color: z.string().optional(), // derived team color hex (#rrggbb)
});
export type PlayerInfo = z.infer<typeof PlayerInfo>;

/** The neutral, render-ready map document. Produced by @d2/sg-parser; consumed by
 *  the server, the Vue store, and the PixiJS renderer. The single source of truth. */
export const MapDocument = z.object({
  schemaVersion: z.string(),
  parserVersion: z.string().optional(),
  header: MapHeader,
  size: z.number().int().positive(),
  terrain: TerrainGrid,
  objects: z.array(MapObject),
  players: z.array(PlayerInfo).default([]),
  events: z.array(MapEvent).default([]),
  variables: z.array(ScenarioVariable).default([]),
  templates: z.array(StackTemplate).default([]),
  diplomacy: z.array(DiplomacyEntry).default([]),
});
export type MapDocument = z.infer<typeof MapDocument>;
