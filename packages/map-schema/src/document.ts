import { z } from "zod";
import { TerrainGrid } from "./cells.js";
import { MapObject } from "./objects.js";

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
});
export type MapHeader = z.infer<typeof MapHeader>;

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
});
export type MapDocument = z.infer<typeof MapDocument>;
