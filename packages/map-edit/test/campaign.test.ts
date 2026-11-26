import { describe, expect, it } from "vitest";
import { createBlankMap, parseScenario } from "@d2/sg-parser";
import { campaignHumanPlayer, campaignMissionIssues, campaignRaceOfPlayer } from "../src/campaign.js";

const doc = parseScenario(createBlankMap({ size: 48, name: "x", races: ["empire", "undead"] }));

describe("a scenario as a mission of a saga", () => {
  it("seats the human at the first player of the saga's race", () => {
    // a blank map also carries the game's neutral player
    expect(doc.players.map(campaignRaceOfPlayer)).toEqual(["neutral", "empire", "undead"]);
    expect(campaignHumanPlayer(doc, "undead")?.raceId?.toUpperCase()).toBe("G000RR0003");
    expect(campaignHumanPlayer(doc, "elves")).toBeUndefined();
    expect(campaignMissionIssues(doc, "elves", 0)).toEqual(["no-seat"]);
    expect(campaignMissionIssues(doc, "empire", 0)).toEqual([]);
    expect(campaignMissionIssues(doc, null, 3)).toEqual([]);
  });

  it("wants a stack in the human capital from the second mission on", () => {
    expect(campaignMissionIssues(doc, "empire", 1)).toEqual([]);
    const bare = { ...doc, objects: doc.objects.filter((o) => o.type !== "stack") };
    expect(campaignMissionIssues(bare, "empire", 0)).toEqual([]);
    expect(campaignMissionIssues(bare, "empire", 1)).toEqual(["no-capital-stack"]);
    const noCapital = { ...doc, objects: doc.objects.filter((o) => o.type !== "capital") };
    expect(campaignMissionIssues(noCapital, "undead", 2)).toEqual(["no-capital-stack"]);
  });
});
