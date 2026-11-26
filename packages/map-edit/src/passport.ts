/**
 * The map passport: what a map IS, in numbers — the sheet a map maker posts next to the
 * file (size, sides, what stands on it, how the land is split). Pure: a function of the
 * document, with no names of the interface in it — the web layer words it.
 *
 * Every number is counted from the document as the game would read the file: a party inside
 * a city is a party, a looted ruin is still a ruin. Nothing here is an estimate.
 */
import type { MapDocument, MapObject } from "@d2/map-schema";
import { getForest, getGround, getTerrain, GROUND_WATER } from "./bits.js";
import { fogHiddenCount, fogOfPlayer } from "./fog.js";

/** PlayerInfo.race of the neutral player (a Grace record index). */
const NEUTRAL_RACE = 4;

export interface PassportPlayer {
  id: string;
  name: string;
  /** Grace record index (0 Empire, 1 Clans, 2 Legions, 3 Undead, 4 Neutral, 5 Elves). */
  race: number;
  human: boolean;
  neutral: boolean;
  color?: string;
  /** top-left cell of the capital, when the player has one */
  capital?: { x: number; y: number };
  cities: number;
  /** parties on the map and inside cities */
  parties: number;
  /** units in those parties and in the garrisons of the player's cities */
  units: number;
  /** the player's fog of war in the file; null when the map has no fog block for the player */
  fog: { hidden: number; total: number } | null;
}

export interface MapPassport {
  name: string;
  description: string;
  author: string;
  size: number;
  cells: number;
  suggestedLevel?: number;
  difficulty?: { scenario: number; game: number };
  limits?: { unit: number; spell: number; leader: number; city: number };
  players: PassportPlayer[];
  /** playable sides (everyone but the neutral player) */
  sides: number;
  /** the two closest capitals, in cells between their centres; null with fewer than two */
  closestCapitals: { a: string; b: string; distance: number } | null;
  objects: {
    capitals: number;
    /** cities by level, index 0 = level 1 … index 4 = level 5 */
    citiesByTier: number[];
    cities: number;
    ruins: number;
    merchants: number;
    mages: number;
    trainers: number;
    mercenaries: number;
    resourceMarkets: number;
    chests: number;
    /** items lying in chests */
    chestItems: number;
    neutralParties: number;
    /** units in neutral parties, ruin guards and neutral garrisons */
    neutralUnits: number;
    /** mana crystals and gold mines by resource 0..5: gold, infernal, life, death, runic, grove */
    crystals: number[];
    rods: number;
    landmarks: number;
    mountains: number;
    locations: number;
  };
  terrain: {
    water: number;
    forest: number;
    roads: number;
    /** land cells (not water) by terrain id 0..7 — which race's land they are */
    land: number[];
    /** cells under mountain objects */
    mountainCells: number;
  };
  scenario: { events: number; variables: number; templates: number };
}

type Garrisoned = { garrison?: readonly (unknown | null)[] };
const garrisonSize = (o: MapObject): number => ((o as Garrisoned).garrison ?? []).filter(Boolean).length;
const owner = (o: MapObject): string | undefined => (o as { owner?: string }).owner;

/** The centre of a capital's 5×5 footprint. */
const capitalCentre = (pos: { x: number; y: number }): { x: number; y: number } => ({ x: pos.x + 2, y: pos.y + 2 });

export function mapPassport(doc: MapDocument): MapPassport {
  const size = doc.size;
  const neutralIds = new Set(doc.players.filter((p) => p.race === NEUTRAL_RACE).map((p) => p.id));
  const isNeutralOwner = (id: string | undefined): boolean => !id || neutralIds.has(id) || !doc.players.some((p) => p.id === id);

  const objects: MapPassport["objects"] = {
    capitals: 0, citiesByTier: [0, 0, 0, 0, 0], cities: 0, ruins: 0, merchants: 0, mages: 0, trainers: 0,
    mercenaries: 0, resourceMarkets: 0, chests: 0, chestItems: 0, neutralParties: 0, neutralUnits: 0,
    crystals: [0, 0, 0, 0, 0, 0], rods: 0, landmarks: 0, mountains: 0, locations: 0,
  };
  const perPlayer = new Map(doc.players.map((p) => [p.id, { cities: 0, parties: 0, units: 0, capital: undefined as { x: number; y: number } | undefined }]));
  let mountainCells = 0;

  for (const o of doc.objects) {
    const mine = perPlayer.get(owner(o) ?? "");
    switch (o.type) {
      case "capital":
        objects.capitals++;
        if (mine) {
          mine.capital = { x: o.pos.x, y: o.pos.y };
          mine.units += garrisonSize(o);
        }
        break;
      case "village": {
        objects.cities++;
        const tier = Math.min(5, Math.max(1, o.tier ?? 1));
        objects.citiesByTier[tier - 1]!++;
        if (mine && !isNeutralOwner(owner(o))) {
          mine.cities++;
          mine.units += garrisonSize(o);
        } else objects.neutralUnits += garrisonSize(o);
        break;
      }
      case "stack":
        if (mine && !isNeutralOwner(owner(o))) {
          mine.parties++;
          mine.units += garrisonSize(o);
        } else {
          objects.neutralParties++;
          objects.neutralUnits += garrisonSize(o);
        }
        break;
      case "ruin":
        objects.ruins++;
        objects.neutralUnits += garrisonSize(o);
        break;
      case "merchant": objects.merchants++; break;
      case "mage": objects.mages++; break;
      case "trainer": objects.trainers++; break;
      case "mercenary": objects.mercenaries++; break;
      case "resourceMarket": objects.resourceMarkets++; break;
      case "treasure":
        objects.chests++;
        objects.chestItems += o.items?.length ?? 0;
        break;
      case "crystal": {
        const r = o.resource ?? 0;
        if (r >= 0 && r < objects.crystals.length) objects.crystals[r]!++;
        break;
      }
      case "rod": objects.rods++; break;
      case "landmark": objects.landmarks++; break;
      case "mountains":
        objects.mountains++;
        mountainCells += (o.w ?? 1) * (o.h ?? 1);
        break;
      case "location": objects.locations++; break;
      default: break;
    }
  }

  const terrain: MapPassport["terrain"] = { water: 0, forest: 0, roads: 0, land: [0, 0, 0, 0, 0, 0, 0, 0], mountainCells };
  for (const cell of doc.terrain.cells) {
    if (!cell) continue;
    if (getGround(cell.value) === GROUND_WATER) terrain.water++;
    else {
      terrain.land[getTerrain(cell.value)]!++;
      if (getForest(cell.value) > 0) terrain.forest++;
    }
    if (cell.roadType >= 0) terrain.roads++;
  }

  const players: PassportPlayer[] = doc.players.map((p) => {
    const mine = perPlayer.get(p.id)!;
    const fog = fogOfPlayer(doc, p.id);
    return {
      id: p.id, name: p.name, race: p.race, human: p.isHuman, neutral: p.race === NEUTRAL_RACE,
      ...(p.color ? { color: p.color } : {}),
      ...(mine.capital ? { capital: mine.capital } : {}),
      cities: mine.cities, parties: mine.parties, units: mine.units,
      fog: fog ? { hidden: fogHiddenCount(fog, size), total: size * size } : null,
    };
  });

  let closest: MapPassport["closestCapitals"] = null;
  const seats = players.filter((p) => p.capital && !p.neutral);
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      const a = capitalCentre(seats[i]!.capital!);
      const b = capitalCentre(seats[j]!.capital!);
      // the game moves on a grid with diagonal steps: the distance in steps is the larger offset
      const distance = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      if (!closest || distance < closest.distance) closest = { a: seats[i]!.id, b: seats[j]!.id, distance };
    }
  }

  const header = doc.header;
  return {
    name: header.name, description: header.description, author: header.author, size, cells: size * size,
    ...(header.suggestedLevel !== undefined ? { suggestedLevel: header.suggestedLevel } : {}),
    ...(header.difficulty ? { difficulty: header.difficulty } : {}),
    ...(header.limits ? { limits: header.limits } : {}),
    players, sides: players.filter((p) => !p.neutral).length, closestCapitals: closest,
    objects, terrain,
    scenario: { events: doc.events?.length ?? 0, variables: doc.variables?.length ?? 0, templates: doc.templates?.length ?? 0 },
  };
}
