import { describe, it, expect } from "vitest";
import { ModFileList, REST } from "../src/index";

describe("ModFileList (GET REST.modFiles)", () => {
  it("has its route next to the passport's", () => {
    expect(REST.modFiles("semga")).toBe("/api/mods/semga/files");
    expect(REST.modFiles("semga").startsWith(REST.mod("semga"))).toBe(true);
  });

  it("maps logical names to sha256 hashes", () => {
    const sha = "ab".repeat(32);
    expect(ModFileList.parse({ files: { "tables/Gunits.dbf": sha, "capital.dat": sha } }).files["capital.dat"]).toBe(sha);
    expect(ModFileList.parse({ files: {} }).files).toEqual({});
    expect(() => ModFileList.parse({ files: { "a.json": "blobs/ab/" + sha + ".json" } })).toThrow();
    expect(() => ModFileList.parse({})).toThrow();
  });
});
