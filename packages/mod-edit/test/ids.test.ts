/** Ids for new rows: a namespace of the mod's own and a decimal counter. */
import { describe, it, expect } from "vitest";
import { allocateId, idCaseOf, idsIn, idsInEdits, idsInText, namespacesOf, newModEdits, pickNamespace, pushCommit } from "../src/index";
import { table, units } from "./helpers";

describe("ids", () => {
  it("are collected from every text cell, deleted rows too, upper-cased", () => {
    const links = table("Gimmu", [{ name: "UNIT_ID", type: "C", length: 10 }, { name: "NOTE", type: "C", length: 30 }], [
      { UNIT_ID: "g001uu0101", NOTE: "see G002IG0007 and x000tg0001" },
      { UNIT_ID: "short", NOTE: "G0zzUU0001 is not one" },
    ]);
    const ids = idsIn([units(), links]);
    expect([...ids].sort()).toEqual(["G000UU0001", "G000UU0002", "G000UU0003", "G001UU0101", "G002IG0007", "X000TG0001"]);
    expect(namespacesOf(ids)).toEqual(new Set(["000", "001", "002"]));
    expect([...idsInText("unit = 'g230uu0001' -- G231AA0002")]).toEqual(["G230UU0001", "G231AA0002"]);
  });

  it("take the lowest free namespace of 230-254", () => {
    expect(pickNamespace(["000", "221"])).toBe("230");
    expect(pickNamespace(["230", "231", "233"])).toBe("232");
    expect(() => pickNamespace(Array.from({ length: 25 }, (_, i) => String(230 + i)))).toThrow(/every namespace/);
  });

  it("count in decimal past the taken ones, in the table's case", () => {
    const taken = new Set(["G230UU0001", "G230UU0002"]);
    expect(allocateId("UU", "230", taken)).toBe("G230UU0003");
    expect(allocateId("uu", "230", taken, idCaseOf(units(), "UNIT_ID"))).toBe("g230uu0003");
    expect(allocateId("TG", "230", taken)).toBe("X230TG0001");
    expect(allocateId("UU", "230", new Set(["g230uu0001"]))).toBe("G230UU0002"); // taken as stored, any case
    expect(() => allocateId("ZZ", "230", taken)).toThrow(/no id type ZZ/);
    expect(() => allocateId("UU", "23", taken)).toThrow(/3 digits/);
    const full = new Set(Array.from({ length: 9999 }, (_, i) => `G230UU${String(i + 1).padStart(4, "0")}`));
    expect(() => allocateId("UU", "230", full)).toThrow(/no free UU id/);
  });

  it("an edit file names are taken too", () => {
    const e = pushCommit(newModEdits({ modId: "a-test", name: "A", parent: { modId: "semga" }, namespace: "230" }), [{ op: "dbf.add", table: "Gunits", key: ["G230UU0001"], values: { UNIT_ID: "G230UU0001" } }], {
      keys: { Gunits: { kind: "columns", columns: ["UNIT_ID"] } },
    });
    expect(idsInEdits(e)).toEqual(new Set(["G230UU0001"]));
  });
});
