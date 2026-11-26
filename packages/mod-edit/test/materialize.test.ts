/** A derived game folder made in a temp folder from a small fake install. */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbfTable } from "@d2/dbf";
import { FfArchive } from "@d2/ff";
import { newModEdits, pushCommit, type KeyDecl, type ModEditOp, type ModEdits } from "../src/index";
import { materialize } from "../src/node/index";
import { main } from "../src/node/cli";
import { pictureArchive, sha256, units } from "./helpers";

let root: string;
let game: string;
const UNIT: KeyDecl = { kind: "columns", columns: ["UNIT_ID"] };
const file = (...p: string[]) => join(game, ...p);
const sameFile = (a: string, b: string) => statSync(a, { bigint: true }).ino === statSync(b, { bigint: true }).ino;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mod-edit-"));
  game = join(root, "parent");
  for (const d of ["Globals", "Imgs", "Interf", "Scripts/Modif", "Campaign"]) mkdirSync(file(d), { recursive: true });
  writeFileSync(file("Globals", "GUnits.dbf"), units().toBytes());
  writeFileSync(file("Globals", "Tglobal.dbf"), DbfTable.create("Tglobal", [{ name: "TXT_ID", type: "C", length: 10 }, { name: "TEXT", type: "C", length: 20 }]).toBytes());
  writeFileSync(file("Imgs", "IsoUnit.ff"), pictureArchive("IsoUnit.ff").toBytes());
  writeFileSync(file("Imgs", "BatUnits.ff"), pictureArchive("BatUnits.ff").toBytes());
  writeFileSync(file("Interf", "TApp.dbf"), DbfTable.create("TApp", [{ name: "TXT_ID", type: "C", length: 10 }]).toBytes());
  writeFileSync(file("Scripts", "Modif", "a.lua"), "return 'g000uu0001'\n");
  writeFileSync(file("Discipl2.exe"), "MZ");
  writeFileSync(file("mss32.dll"), "MZ");
  writeFileSync(file("readme.txt"), "not a game file");
  writeFileSync(file("Campaign", "a.sg"), "D2EESFISIG");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function edits(ops: ModEditOp[]): ModEdits {
  const e = newModEdits({ modId: "fake-test", name: "Test", parent: { modId: "fake" }, namespace: "230" });
  return pushCommit(e, ops, { keys: { Gunits: UNIT } });
}

const levelUp: ModEditOp = { op: "dbf.set", table: "Gunits", key: ["G000UU0001"], field: "LEVEL", value: 9, was: 1 };

describe("materialize", () => {
  it("links every file it does not change and writes the ones it does", () => {
    const parentUnits = readFileSync(file("Globals", "GUnits.dbf"));
    const out = join(root, "child-1");
    const r = materialize({
      parentGame: game,
      out,
      edits: edits([
        levelUp,
        { op: "ff.setAnimation", archive: "isounit.ff", name: "A_ATTACK", frames: ["A_FRAME0"] },
        { op: "ff.deleteIndexEntry", archive: "BatUnits.ff", name: "A_MOVE" },
      ]),
    });
    expect(r.conflicts).toEqual([]);
    expect(r.out).toBe(out);
    expect(r.written.map((w) => w.path).sort()).toEqual(["Globals/GUnits.dbf", "Imgs/IsoUnit.ff"]);
    expect(r.carried).toEqual([{ archive: "BatUnits.ff", ops: 1 }]);
    expect(r.linked).toBe(6); // Tglobal, BatUnits, TApp, a.lua, the exe and the dll

    expect(readFileSync(file("Globals", "GUnits.dbf"))).toEqual(parentUnits);
    expect(sameFile(join(out, "Globals", "GUnits.dbf"), file("Globals", "GUnits.dbf"))).toBe(false);
    expect(DbfTable.read(readFileSync(join(out, "Globals", "GUnits.dbf"))).get(0, "LEVEL")).toBe(9);
    const written = r.written.find((w) => w.path === "Imgs/IsoUnit.ff")!;
    expect(sha256(readFileSync(join(out, "Imgs", "IsoUnit.ff")))).toBe(written.sha256);
    expect(FfArchive.read(readFileSync(join(out, "Imgs", "IsoUnit.ff"))).idByName("-INDEX.OPT")).toBeDefined();

    for (const p of [["Globals", "Tglobal.dbf"], ["Imgs", "BatUnits.ff"], ["Interf", "TApp.dbf"], ["Scripts", "Modif", "a.lua"], ["Discipl2.exe"], ["mss32.dll"]]) {
      expect(sameFile(join(out, ...p), file(...p)), p.join("/")).toBe(true);
    }
    expect(existsSync(join(out, "readme.txt"))).toBe(false);
    expect(existsSync(join(out, "Campaign"))).toBe(false);
  });

  it("writes every edited archive when asked", () => {
    const r = materialize({ parentGame: game, out: join(root, "child-2"), allArchives: true, edits: edits([{ op: "ff.deleteIndexEntry", archive: "BatUnits.ff", name: "A_MOVE" }]) });
    expect(r.carried).toEqual([]);
    expect(r.written.map((w) => w.path)).toEqual(["Imgs/BatUnits.ff"]);
  });

  it("links everything for an empty edit file", () => {
    const r = materialize({ parentGame: game, out: join(root, "child-3"), edits: edits([]) });
    expect(r).toMatchObject({ linked: 8, written: [], conflicts: [] });
  });

  it("leaves nothing behind on a conflict, and never writes into a folder that exists", () => {
    const out = join(root, "child-4");
    const r = materialize({ parentGame: game, out, edits: edits([{ ...levelUp, was: 5 }]) });
    expect(r.conflicts.map((c) => c.reason)).toEqual(["parent-changed"]);
    expect(r.out).toBeNull();
    expect(existsSync(out)).toBe(false);
    const late = materialize({ parentGame: game, out, edits: edits([levelUp, { op: "ff.setAnimation", archive: "IsoUnit.ff", name: "A_X", frames: ["NOPE"] }]) });
    expect(late.conflicts.map((c) => c.reason)).toEqual(["unknown-frame"]);
    expect(existsSync(out)).toBe(false);
    expect(() => materialize({ parentGame: game, out: join(root, "child-1"), edits: edits([levelUp]) })).toThrow(/exists/);
    const missing = materialize({ parentGame: game, out, edits: edits([{ op: "ff.deleteRecord", archive: "Faces.ff", name: "X" }]) });
    expect(missing.conflicts.map((c) => c.reason)).toEqual(["no-archive"]);
  });

  it("finds the conflicts of an archive it carries", () => {
    const out = join(root, "child-5");
    const r = materialize({ parentGame: game, out, edits: edits([levelUp, { op: "ff.deleteIndexEntry", archive: "BatUnits.ff", name: "A_FRAME0" }]) });
    expect(r.conflicts.map((c) => [c.file, c.reason])).toEqual([["BatUnits.ff", "picture-in-use"]]);
    expect(existsSync(out)).toBe(false);
  });

  it("checks without writing when there is no out folder", () => {
    const r = materialize({ parentGame: game, edits: edits([levelUp, { op: "ff.setAnimation", archive: "IsoUnit.ff", name: "A_X", frames: ["NOPE"] }]) });
    expect(r.out).toBeNull();
    expect(r.conflicts.map((c) => c.reason)).toEqual(["unknown-frame"]);
    expect(r.applied.Gunits).toEqual({ deleted: 0, set: 1, added: 0, unchanged: 0 });
  });
});

describe("the command", () => {
  const quiet = (argv: string[]) => {
    const log = console.log;
    const err = console.error;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    console.error = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      return { code: main(argv), lines };
    } finally {
      console.log = log;
      console.error = err;
    }
  };

  it("starts an edit file in a namespace nobody uses", () => {
    const path = join(root, "edits", "a", "edits.json");
    mkdirSync(join(root, "edits", "b"), { recursive: true });
    writeFileSync(join(root, "edits", "b", "edits.json"), JSON.stringify(newModEdits({ modId: "b-test", name: "B", parent: { modId: "fake" }, namespace: "230" })));
    const r = quiet(["init", "--parent", "fake", "--parent-game", game, "--mod-id", "a-test", "--name", "A", "--edits", path, "--others", join(root, "edits")]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).ids).toEqual({ namespace: "231" });
    expect(quiet(["init", "--parent", "fake", "--parent-game", game, "--mod-id", "a-test", "--name", "A", "--edits", path]).code).toBe(2);
  });

  it("diffs a hand-edited copy of the tables into a one-commit edit file", () => {
    const copy = join(root, "copy");
    mkdirSync(copy);
    const t = units();
    t.set(0, "NAME_TXT", "Renamed");
    writeFileSync(join(copy, "GUnits.dbf"), t.toBytes());
    const path = join(root, "diff.json");
    const r = quiet(["diff", "--parent", "fake", "--parent-game", game, "--child", copy, "--mod-id", "c-test", "--name", "C", "--edits", path]);
    expect(r.code).toBe(0);
    const e = JSON.parse(readFileSync(path, "utf8")) as ModEdits;
    expect(e.cursor).toBe(1);
    expect(e.journal[0]!.ops).toEqual([{ op: "dbf.set", table: "GUnits", key: ["G000UU0001"], field: "NAME_TXT", value: "Renamed", was: "Squire" }]);
    expect(e.tables).toEqual({ GUnits: UNIT });
    expect(r.lines.join("\n")).toMatch(/only the parent has: Tglobal, TApp/);
    expect(quiet(["check", "--parent-game", game, "--edits", path]).code).toBe(0);
    expect(quiet(["materialize", "--parent-game", game, "--edits", path]).code).toBe(2);
  });

  it("writes no edit file when a table is refused", () => {
    const copy = join(root, "copy-2");
    mkdirSync(copy);
    // a list table whose columns differ from the parent's cannot be diffed by whole rows
    writeFileSync(file("Globals", "GmodifL.dbf"), DbfTable.create("GmodifL", [{ name: "BELONGS_TO", type: "C", length: 10 }]).toBytes());
    writeFileSync(join(copy, "GmodifL.dbf"), DbfTable.create("GmodifL", [{ name: "BELONGS_TO", type: "C", length: 10 }, { name: "TYPE", type: "N", length: 2 }]).toBytes());
    const path = join(root, "refused.json");
    try {
      const r = quiet(["diff", "--parent", "fake", "--parent-game", game, "--child", copy, "--mod-id", "d-test", "--name", "D", "--edits", path]);
      expect(r.code).toBe(1);
      expect(r.lines.join("\n")).toMatch(/REFUSED GmodifL/);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(file("Globals", "GmodifL.dbf"));
    }
  });

  it("refuses options it does not take, folders without tables, and a missing --others", () => {
    const base = ["init", "--parent", "fake", "--mod-id", "e-test", "--name", "E", "--edits", join(root, "e.json")];
    expect(quiet([...base, "--parent-game", game, "--other", join(root, "edits")]).lines.join()).toMatch(/no option --other/);
    expect(quiet([...base, "--parent-game", join(game, "Imgs")]).code).toBe(2);
    expect(quiet([...base, "--parent-game", game, "--others", join(root, "nowhere")]).code).toBe(2);
    expect(quiet(["check", "--parent-game", game, "--edits"]).code).toBe(2);
    expect(existsSync(join(root, "e.json"))).toBe(false);
    // a value that starts with "--" is still the value
    const dashed = join(root, "f.json");
    expect(quiet(["init", "--parent", "fake", "--parent-game", game, "--mod-id", "f-test", "--name", "--F--", "--edits", dashed, "--others", join(root, "edits")]).code).toBe(0);
    expect(JSON.parse(readFileSync(dashed, "utf8")).name).toBe("--F--");
  });
});
