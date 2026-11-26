/**
 * What the game needs of a scenario that is a mission of a saga (`.csg`). Shared by the server
 * (the listing checks the stored missions) and the editor (the open mission, with its edits).
 *
 *  - The human plays the first player of the saga's race; a mission without one has no place
 *    for them (`no-seat`).
 *  - From the second mission on, the hero of the previous mission is carried over as the leader
 *    of the stack in the human capital. A mission whose human capital holds no stack crashes
 *    the game at that moment (`no-capital-stack`).
 */
import type { MapDocument } from "@d2/map-schema";
import type { CampaignMissionIssue, CampaignRaceKey } from "@d2/socket-contract";
import { CAMPAIGN_RACES, campaignRaceId } from "@d2/sg-parser";

/** The races a saga can be played for (a neutral saga has no human seat). */
export const PLAYABLE_CAMPAIGN_RACES: readonly CampaignRaceKey[] = ["empire", "clans", "legions", "undead", "elves"];

/** The saga race of a player (by its Grace id), or null for a race outside the six. */
export function campaignRaceOfPlayer(p: MapDocument["players"][number]): CampaignRaceKey | null {
  const m = /^G000RR000(\d)$/i.exec(p.raceId ?? "");
  return m ? (CAMPAIGN_RACES[Number(m[1])] ?? null) : null;
}

/** The player the human plays in a mission of a saga of `race`. */
export function campaignHumanPlayer(doc: MapDocument, race: CampaignRaceKey): MapDocument["players"][number] | undefined {
  const raceId = campaignRaceId(race);
  const raceIndex = CAMPAIGN_RACES.indexOf(race);
  return doc.players.find((p) => (p.raceId ? p.raceId.toUpperCase() === raceId : p.race === raceIndex));
}

/** What would break mission `index` (0-based) of a saga played for `race`. */
export function campaignMissionIssues(
  doc: MapDocument,
  race: CampaignRaceKey | null,
  index: number,
): CampaignMissionIssue[] {
  if (!race) return [];
  const human = campaignHumanPlayer(doc, race);
  if (!human) return ["no-seat"];
  if (index === 0) return [];
  // an object's id ends with its own 6-digit part; a reference may carry another map prefix
  const tail = (s: string): string => s.slice(-6).toUpperCase();
  const capital = doc.objects.find((o) => o.type === "capital" && o.owner === human.id);
  if (!capital || capital.type !== "capital") return ["no-capital-stack"];
  const ref = capital.stackRef;
  const holds = doc.objects.some(
    (o) =>
      o.type === "stack" &&
      ((ref !== undefined && tail(o.id) === tail(ref)) || (o.inside !== undefined && tail(o.inside) === tail(capital.id))),
  );
  return holds ? [] : ["no-capital-stack"];
}
