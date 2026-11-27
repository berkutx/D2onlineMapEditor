/**
 * The races block of the overview: which races it lists and in what order. Pure.
 */
import type { RaceChange, RaceMembers } from "@d2/mod-diff";

/** Members that changed by their own rows (not only through a row they share with others). */
export function ownChanged(m: RaceMembers): number {
  return m.changed.filter((x) => x.status !== "via-shared").length;
}

/** Changed layers of the race's capital screen. */
export function capitalLayersChanged(r: RaceChange): number {
  return r.capital ? r.capital.layers.length : 0;
}

/** How much of a race changed in all: units and buildings added, removed or changed, capital
 *  layers, pictures. */
export function raceChangeCount(r: RaceChange): number {
  const m = (x: RaceMembers) => x.added.length + x.removed.length + ownChanged(x);
  return m(r.units) + m(r.buildings) + capitalLayersChanged(r) + r.pictures.length;
}

/**
 * Every race the Races tile counts (`changedIds`, the diff's summary.races.changed), also one
 * whose units only changed — its "how new" score is then 0 — plus a race only one mod has.
 * The most rebuilt first, then the most changed.
 */
export function overviewRaces(races: readonly RaceChange[], changedIds: readonly string[]): RaceChange[] {
  const changed = new Set(changedIds);
  return races
    .filter((r) => changed.has(r.id) || r.redesign.score > 0 || r.presence !== "both")
    .sort((x, y) => y.redesign.score - x.redesign.score || raceChangeCount(y) - raceChangeCount(x));
}
