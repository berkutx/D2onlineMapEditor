/**
 * Custom sagas (.csg): the writer leaves the layout the game's own saga editor does, the reader
 * reads it back and reads the sagas the mods ship with.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  campaignMissionFileName,
  campaignMissionNameProblem,
  campaignRaceId,
  createBlankMap,
  parseHeaderOnly,
  readCampaign,
  writeCampaign,
} from "../src/index";
import { campaignDir } from "../../../test-helpers/gameDir";

const i32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getInt32(at, true);
const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

function realSaga(name: string): string | undefined {
  try {
    const p = join(campaignDir(), name);
    return existsSync(p) ? p : undefined;
  } catch {
    return undefined; // no game dir on this machine
  }
}

const one = createBlankMap({ size: 48, name: "Первая", races: ["empire", "undead"] });
const two = createBlankMap({ size: 72, name: "Вторая", races: ["empire", "clans"] });

describe("writeCampaign", () => {
  const bytes = writeCampaign({
    header: { name: "Сага", description: "Про Империю", author: "Автор", race: "empire", heroLevel: 3 },
    missions: [
      { name: "Pervaya.sg", bytes: one },
      { name: "Vtoraya.sg", bytes: two },
    ],
  });

  it("reads back what it wrote", () => {
    const c = readCampaign(bytes);
    expect(c.version).toBe(100);
    expect(c.savePackage).toBe(false);
    expect(c.header).toEqual({
      name: "Сага",
      description: "Про Империю",
      author: "Автор",
      race: "empire",
      heroLevel: 3,
    });
    expect(c.missions.map((m) => [m.name, m.format])).toEqual([
      ["Pervaya.sg", "sg"],
      ["Vtoraya.sg", "sg"],
    ]);
    expect([...c.missions[0]!.bytes]).toEqual([...one]);
    expect(parseHeaderOnly(c.missions[1]!.bytes).header.name).toBe("Вторая");
  });

  it("lays the records out the way the game's saga editor does", () => {
    expect(text(bytes, 0, 4)).toBe("MQDB");
    expect(i32(bytes, 8)).toBe(9);
    // MFF first, then the table of contents, its data offset in the file header
    expect(text(bytes, 28, 4)).toBe("MQRC");
    expect(i32(bytes, 28 + 8)).toBe(1);
    expect(text(bytes, 56, 3)).toBe("MFF");
    expect(i32(bytes, 60)).toBe(5);
    expect(i32(bytes, 64 + 8)).toBe(0);
    expect(i32(bytes, 24)).toBe(92);
    expect(i32(bytes, 64 + 12)).toBe(1024);
    // the table lists every record, itself included, in id order
    const n = i32(bytes, 92);
    const ids = Array.from({ length: n }, (_, k) => i32(bytes, 96 + 16 * k));
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // every entry points at a live MQRC header carrying the same id and sizes
    for (let k = 0; k < n; k++) {
      const e = 96 + 16 * k;
      const at = i32(bytes, e + 12);
      expect(text(bytes, at, 4)).toBe("MQRC");
      expect(i32(bytes, at + 8)).toBe(i32(bytes, e));
      expect(i32(bytes, at + 12)).toBe(i32(bytes, e + 4));
      expect(i32(bytes, at + 20)).toBe(1);
    }
    // the header record is 340 bytes; the race is the global id G000RR0000
    const head = i32(bytes, 96 + 16 * 3 + 12);
    expect(i32(bytes, head + 12)).toBe(340);
    expect(i32(bytes, head + 28 + 328)).toBe(0x0003_0000);
    expect(campaignRaceId("undead")).toBe("G000RR0003");
    // the name table (record 2) comes last and names the records upper-cased
    const table = i32(bytes, 96 + 16 * 2 + 12);
    expect(table + 28 + i32(bytes, table + 12)).toBe(bytes.length);
    expect(text(bytes, table + 28 + 4 + 260 * 2, 10)).toBe("PERVAYA.SG");
  });

  it("refuses what the game could not open", () => {
    const header = { name: "С", description: "", author: "", race: "elves" as const, heroLevel: 1 };
    expect(() => writeCampaign({ header, missions: [] })).toThrow(/at least one/);
    expect(() => writeCampaign({ header, missions: [{ name: "Карта.sg", bytes: one }] })).toThrow(/ASCII/);
    expect(() =>
      writeCampaign({ header, missions: [{ name: "a.sg", bytes: one }, { name: "A.SG", bytes: two }] }),
    ).toThrow(/two missions/);
    expect(() => writeCampaign({ header, missions: [{ name: "a.sg", bytes: new Uint8Array(20) }] })).toThrow(
      /D2EESFISIG/,
    );
    expect(() =>
      writeCampaign({ header: { ...header, name: "x".repeat(33) }, missions: [{ name: "a.sg", bytes: one }] }),
    ).toThrow(/name/);
  });
});

describe("campaignMissionFileName", () => {
  it("makes an ASCII file name from a mission's title, one per mission", () => {
    const taken = new Set<string>();
    expect(campaignMissionFileName("Империя 1", taken)).toBe("Imperiya_1.sg");
    expect(campaignMissionFileName("империя 1", taken)).toBe("imperiya_1_2.sg");
    expect(campaignMissionFileName("Riders", taken)).toBe("Riders.sg");
    expect(campaignMissionFileName("???", taken)).toBe("mission.sg");
    expect(campaignMissionFileName("D2CC_Current", taken)).toBe("D2CC_Current_2.sg");
    for (const n of taken) expect(campaignMissionNameProblem(n)).toBeNull();
  });
});

describe("readCampaign on the sagas a mod ships with", () => {
  const eldunari = realSaga("The Power of Eldunari-v1-2.csg");
  it.skipIf(!eldunari)("reads the header and the missions in play order", () => {
    const c = readCampaign(new Uint8Array(readFileSync(eldunari!)));
    expect(c.version).toBe(100);
    expect(c.header.name).toBe("The Power of Eldunari");
    expect(c.header.race).toBe("undead");
    expect(c.header.heroLevel).toBe(4);
    expect(c.missions.map((m) => m.name)).toEqual([
      "Riders.sg",
      "The Formation of Mordred.sg",
      "The Barren Lands.sg",
      "Dragon's teeth.sg",
    ]);
    expect(c.missions.every((m) => m.format === "sg")).toBe(true);
    expect(parseHeaderOnly(c.missions[0]!.bytes).size).toBe(72);
  });

  it.skipIf(!eldunari)("writes it again into a saga that reads the same", () => {
    const c = readCampaign(new Uint8Array(readFileSync(eldunari!)));
    const again = readCampaign(
      writeCampaign({
        header: { ...c.header, race: c.header.race! },
        missions: c.missions.map((m) => ({ name: m.name, bytes: m.bytes })),
      }),
    );
    expect(again.header).toEqual(c.header);
    expect(again.missions.map((m) => m.name)).toEqual(c.missions.map((m) => m.name));
    again.missions.forEach((m, k) => expect(Buffer.from(m.bytes).equals(Buffer.from(c.missions[k]!.bytes))).toBe(true));
  });

  const damned = realSaga("Путь Проклятых.csg");
  it.skipIf(!damned)("tells the older MidFile missions apart", () => {
    const c = readCampaign(new Uint8Array(readFileSync(damned!)));
    expect(c.version).toBe(1);
    expect(c.header.race).toBe("legions");
    expect(c.missions.map((m) => m.format)).toEqual(["midfile", "midfile", "midfile"]);
  });
});
