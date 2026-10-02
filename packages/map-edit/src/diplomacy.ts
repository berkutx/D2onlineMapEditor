/** Editor operations on the SG MidDiplomacy packed RELATION word.
 * Selected EXE 0x5f8d50: the meter occupies bits 1..7; bit30 locks updates.
 * The editor owns list creation. Existing order, duplicates and other bits survive.
 */
import type { DiplomacyEntry, PlayerInfo } from "@d2/map-schema";
import { RACES, RACE_KEYS } from "@d2/sg-parser";

function word(value: number): number {
  if (!Number.isInteger(value) || value < -2147483648 || value > 4294967295) throw new RangeError("RELATION must contain 32 bits");
  return value | 0;
}
function race(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError("Diplomacy race category must fit uint8");
  return value;
}
export function decodeDiplomacyRelation(relation: number) {
  const raw = word(relation);
  return { current: (raw >>> 1) & 127, previous: (raw >>> 8) & 127,
    alliance: (raw & 1) !== 0, alwaysWar: (raw & 0x40000000) !== 0,
    unbreakable: (raw & 0x80000000) !== 0 };
}
/** First undirected pair, as stored. A missing pair reads the native zero word. */
export function findDiplomacyEntry(entries: readonly DiplomacyEntry[], race1: number, race2: number): DiplomacyEntry | undefined {
  race(race1); race(race2);
  return entries.find(e => (e.race1 === race1 && e.race2 === race2) || (e.race1 === race2 && e.race2 === race1));
}
export function readDiplomacyRelation(entries: readonly DiplomacyEntry[], race1: number, race2: number) {
  return decodeDiplomacyRelation(findDiplomacyEntry(entries, race1, race2)?.relation ?? 0);
}
/** Immutable change, with original array identity for locked/no-op updates.
 * Values outside the editable native 0..100 interval are rejected, never clamped.
 */
export function setDiplomacyCurrent(entries: readonly DiplomacyEntry[], race1: number, race2: number, current: number): readonly DiplomacyEntry[] {
  race(race1); race(race2);
  if (!Number.isInteger(current) || current < 0 || current > 100) throw new RangeError("Diplomacy meter must be an integer from 0 to 100");
  const first = findDiplomacyEntry(entries, race1, race2);
  if (!first) return [...entries, { race1, race2, relation: current << 1 }];
  const raw = word(first.relation);
  if ((raw & 0x40000000) !== 0 || ((raw >>> 1) & 127) === current) return entries;
  const result = entries.slice(), index = entries.indexOf(first);
  result[index] = { ...first, relation: ((raw & 0xffffff01) | (current << 1)) | 0 };
  return result;
}
const RACE_CATEGORIES = new Map<string, number>([
  ["G000RR0004", 4], ...RACE_KEYS.map(key => [RACES[key].raceId, RACES[key].raceType] as [string, number]),
]);
/** PlayerInfo.race is a Grace record index, not the diplomacy category.
 * Reuse the editor's explicit supported-faction table; unknown records stay unknown.
 */
export function diplomacyRaceCategory(player: Pick<PlayerInfo, "raceId">): number | null {
  return RACE_CATEGORIES.get(player.raceId?.toUpperCase() ?? "") ?? null;
}
