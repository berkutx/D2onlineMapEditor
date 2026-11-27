/** diffMods on small mods built here (test/helpers.ts). */
import { describe, it, expect } from "vitest";
import { DbfTable } from "@d2/dbf";
import { diffMods, parseCapitalDat, SECTIONS, type EntityChange, type ModDiff, type SectionId, type SpriteManifest } from "../src/index";
import { decodeRow, decodeTable } from "../src/side";
import { A1, A2, baseRows, blob, hash, M1, M2, mod, RACE, rowOf, table, TEMPLE, U1, U2, U3, type ModRows } from "./helpers";

function diff(edit: (b: ModRows) => void, extraA = {}, extraB = {}): ModDiff {
  const b = baseRows();
  edit(b);
  return diffMods(mod("a", baseRows(), extraA), mod("b", b, extraB));
}

const ids = (d: ModDiff, section: SectionId) => d.sections[section].map((e) => e.id);
const entity = (d: ModDiff, section: SectionId, id: string): EntityChange => {
  const e = d.sections[section].find((x) => x.id === id);
  if (!e) throw new Error(`${section} ${id} is not in the diff`);
  return e;
};

describe("diffMods", () => {
  it("finds nothing between a mod and itself", () => {
    const d = diff(() => {});
    expect(d.summary.tables.ops).toBe(0);
    expect(d.summary.tables.differ).toBe(0);
    for (const s of SECTIONS) expect(d.sections[s]).toEqual([]);
    expect(d.races.map((r) => r.status)).toEqual([null]);
    expect(d.summary.races).toEqual({ changed: [], redesigned: [] });
  });

  it("puts a unit's own rows and its owned rows under the unit", () => {
    const d = diff((b) => {
      rowOf(b.Gunits!, "UNIT_ID", U1).HIT_POINT = 120;
      b.Gimmu![0]!.IMMUNECAT = 3; // U1, immunity 1
      b.Gimmu!.push({ UNIT_ID: U1, IMMUNITY: 5, IMMUNECAT: 2 });
    });
    expect(ids(d, "units")).toEqual([U1]);
    const u = entity(d, "units", U1);
    expect(u).toMatchObject({ uid: `units:Gunits:${U1}`, table: "Gunits", status: "changed", nameA: "Squire", nameB: "Squire" });
    expect(u.fields).toEqual([{ table: "Gunits", field: "HIT_POINT", a: 100, b: 120 }]);
    const owned = Object.fromEntries(u.owned.map((r) => [r.keyText, r]));
    expect(owned[`["${U1}",1]`]).toMatchObject({ table: "Gimmu", change: "changed", fields: [{ table: "Gimmu", field: "IMMUNECAT", a: 2, b: 3 }] });
    expect(owned[`["${U1}",5]`]).toMatchObject({ table: "Gimmu", change: "added", rowB: { UNIT_ID: U1, IMMUNITY: 5, IMMUNECAT: 2 } });
    expect(u.ops).toHaveLength(3);
    expect(u.group).toMatchObject({ race: RACE, level: 1 });
    expect(u.groupText).toMatchObject({ race: "Empire" });
    const gimmu = d.tables.find((t) => t.name === "Gimmu")!;
    expect(gimmu.counts).toEqual({ set: 1, add: 1, delete: 0 });
    expect(gimmu.ops.every((op) => op.owners.length === 1 && op.owners[0]!.id === U1)).toBe(true);
    expect(d.summary).toMatchObject({ unassignedOps: 0, assignedOps: 3, tableOnlyOps: 0 });
    expect(d.summary.tables.differ).toBe(2);
  });

  it("shows a shared attack's change under every unit that uses it, as via-shared", () => {
    const d = diff((b) => {
      rowOf(b.Gattacks!, "ATT_ID", A1).POWER = 35;
    });
    const a = entity(d, "attacks", A1);
    expect(a.status).toBe("changed");
    expect(a.fields).toEqual([{ table: "Gattacks", field: "POWER", a: 25, b: 35 }]);
    expect(a.usedBy).toEqual(
      expect.arrayContaining([
        { via: "Gunits.ATTACK_ID", section: "units", id: U1, name: "Squire", side: "both" },
        { via: "Gunits.ATTACK_ID", section: "units", id: U2, name: "Archer", side: "both" },
      ]),
    );
    expect(ids(d, "units")).toEqual([U1, U2]);
    for (const id of [U1, U2]) {
      const u = entity(d, "units", id);
      expect(u.status).toBe("via-shared");
      expect(u.fields).toEqual([]);
      expect(u.shared).toEqual([{ via: "Gunits.ATTACK_ID", section: "attacks", id: A1, name: "Strike", status: "changed" }]);
    }
    expect(d.summary.sections.units).toMatchObject({ viaShared: 2, changed: 0, total: 2 });
  });

  it("lists every owner of a changed text, with the style tag stripped", () => {
    const d = diff((b) => {
      rowOf(b.Tglobal!, "TXT_ID", "x000tg0001").TEXT = "\\fNormal;Knight";
    });
    // the same text named by two units and an attack, on both sides
    const both = (rows: ModRows) => {
      rowOf(rows.Gunits!, "UNIT_ID", U2).NAME_TXT = "X000TG0001";
      rowOf(rows.Gattacks!, "ATT_ID", A2).NAME_TXT = "x000tg0001";
    };
    const a = baseRows();
    const b = baseRows();
    both(a);
    both(b);
    rowOf(b.Tglobal!, "TXT_ID", "x000tg0001").TEXT = "\\fNormal;Knight";
    const d2 = diffMods(mod("a", a), mod("b", b));
    expect(entity(d, "texts", "X000TG0001")).toMatchObject({ table: "Tglobal", status: "changed", nameA: "Squire", nameB: "Knight", group: { kind: "TG" } });

    const t = entity(d2, "texts", "X000TG0001");
    expect(t.usedBy).toEqual(
      expect.arrayContaining([
        { via: "Gunits.NAME_TXT", section: "units", id: U1, name: "Knight", side: "both" },
        { via: "Gunits.NAME_TXT", section: "units", id: U2, name: "Knight", side: "both" },
        { via: "Gattacks.NAME_TXT", section: "attacks", id: A2, name: "Knight", side: "both" },
      ]),
    );
    expect(t.usedBy).toHaveLength(3);
    for (const [section, id, via] of [
      ["units", U1, "Gunits.NAME_TXT"],
      ["units", U2, "Gunits.NAME_TXT"],
      ["attacks", A2, "Gattacks.NAME_TXT"],
    ] as const) {
      const e = entity(d2, section, id);
      expect(e.status).toBe("changed");
      expect(e.texts).toEqual([{ via, id: "X000TG0001", a: "Squire", b: "Knight" }]);
      expect(e.nameA).toBe("Squire");
      expect(e.nameB).toBe("Knight");
    }
  });

  it("shows a race slot change on the race", () => {
    const d = diff((b) => {
      b.Grace![0]!.GUARDIAN = U2;
    });
    expect(d.races).toHaveLength(1);
    const r = d.races[0]!;
    expect(r).toMatchObject({ id: RACE, nameA: "Empire", nameB: "Empire", presence: "both", status: "changed", raceType: 0, lrace: "L_HUMAN", capitalSection: "HUMAN", code: "HU" });
    const changed = r.slots.filter((s) => s.changed);
    expect(changed).toEqual([{ slot: "GUARDIAN", a: U1, b: U2, aText: "Squire", bText: "Archer", changed: true }]);
    expect(r.slots.map((s) => s.slot)).toEqual(["GUARDIAN", "NOBLE", "LEADER_1", "LEADER_2", "LEADER_3", "LEADER_4", "SOLDIER_1", "SOLDIER_2", "SOLDIER_3", "SOLDIER_4", "SOLDIER_5", "SOLDIER_6", "SOLDIER_7", "SCOUT", "REGEN_H", "INCOME", "PROTECTION"]);
    expect(r.redesign.parts.slots).toBe(Math.round((1 / 17) * 1000) / 1000);
    expect(r.redesign.redesigned).toBe(false);
    expect(entity(d, "races", RACE).fields).toEqual([{ table: "Grace", field: "GUARDIAN", a: U1, b: U2, aText: "Squire", bText: "Archer" }]);
    expect(d.summary.races.changed).toEqual([RACE]);
  });

  it("counts the units a race gains and loses, and gives the new unit its owned rows", () => {
    const d = diff((b) => {
      b.Gunits!.push({ UNIT_ID: U3, RACE_ID: RACE, NAME_TXT: "X000TG0002", LEVEL: 2, HIT_POINT: 90, ATTACK_ID: A2, ATTACK2_ID: "" });
      b.Gimmu!.push({ UNIT_ID: U3, IMMUNITY: 1, IMMUNECAT: 1 });
      b.Gunits = b.Gunits!.filter((u) => u.UNIT_ID !== U2);
      b.Gimmu = b.Gimmu!.filter((u) => u.UNIT_ID !== U2);
      b.GUmodif = [];
    });
    expect(entity(d, "units", U3)).toMatchObject({ status: "added", nameA: null, nameB: "Archer" });
    expect(entity(d, "units", U3).owned).toMatchObject([{ table: "Gimmu", change: "added" }]);
    const gone = entity(d, "units", U2);
    expect(gone).toMatchObject({ status: "removed", nameA: "Archer", nameB: null });
    expect(gone.owned.map((o) => o.change)).toEqual(["removed"]);
    expect(gone.lists).toMatchObject([{ table: "GUmodif", ownerColumn: "UNIT_ID", owner: U2, removed: [{ UNIT_ID: U2, MODIF_1: M1 }], added: [] }]);
    const r = d.races[0]!;
    expect(r.units).toMatchObject({ countA: 2, countB: 2, added: [{ section: "units", id: U3, name: "Archer" }], removed: [{ section: "units", id: U2, name: "Archer" }] });
    expect(r.units.copies).toEqual([]);
    expect(r.redesign.parts.units).toBe(0.5); // 1 of B's 2 units is new; the cut one does not count
    expect(d.summary.unassignedOps).toBe(0);
  });

  it("does not count a unit under a new id with the picture of a unit of A as new", () => {
    const icon = (n: number) => `blobs/aa/${String(n).repeat(64).slice(0, 64)}.png`;
    const edit = (b: ModRows) => {
      b.Gunits!.push({ UNIT_ID: U3, RACE_ID: RACE, NAME_TXT: "X000TG0002", LEVEL: 2, HIT_POINT: 90, ATTACK_ID: A2, ATTACK2_ID: "" });
      b.Gunits = b.Gunits!.filter((u) => u.UNIT_ID !== U2);
    };
    // U3 shows U2's picture: the unit was renumbered, not made anew
    const renumbered = diff(edit, { files: { "uniticons/g000uu0001.png": icon(1), "uniticons/g000uu0002.png": icon(2) } }, { files: { "uniticons/g000uu0001.png": icon(1), "uniticons/g000uu0003.png": icon(2) } });
    const r = renumbered.races[0]!;
    expect(r.units.copies).toEqual([{ section: "units", id: U3, name: "Archer", of: { section: "units", id: U2, name: "Archer" } }]);
    expect(r.redesign.parts.units).toBe(0);
    // with its own picture it is new
    const own = diff(edit, { files: { "uniticons/g000uu0002.png": icon(2) } }, { files: { "uniticons/g000uu0003.png": icon(3) } });
    expect(own.races[0]!.units.copies).toEqual([]);
    expect(own.races[0]!.redesign.parts.units).toBe(0.5);
  });

  it("adds a capital.dat layer to the race and to its building", () => {
    const capA = ["[HUMAN]", "LayerInfoCount=1", "LAYERINFO_00=1,G000BB0001,", "LayerCount=2", "LAYER_000=,BACKGROUND,0,0,800,600", "LAYER_100=G000BB0001,TEMPLE1,0,0,10,10", ""].join("\r\n");
    const capB = capA.replace("LayerCount=2", "LayerCount=3") + "LAYER_110=G000BB0001,TEMPLE1A,5,5,20,20\r\n";
    const d = diff(() => {}, { capitalDat: capA }, { capitalDat: capB });
    const r = d.races[0]!;
    expect(r.capital).toMatchObject({ name: "HUMAN", presence: "both", layersA: 2, layersB: 3, infoAdded: [], infoRemoved: [] });
    expect(r.capital!.layers).toEqual([
      { key: "G000BB0001|TEMPLE1A", build: TEMPLE, picture: "TEMPLE1A", change: "added", b: { z: "110", build: TEMPLE, picture: "TEMPLE1A", values: ["5", "5", "20", "20"], rect: [5, 5, 20, 20] } },
    ]);
    expect(r.capital!.buildings).toMatchObject([{ build: TEMPLE, nameA: "Temple", nameB: "Temple", added: 1, removed: 0, changed: 0 }]);
    expect(r.redesign.parts.capital).toBe(0.333); // 1 of B's 3 layers is new
    const t = entity(d, "buildings", TEMPLE);
    expect(t.status).toBe("art-only");
    expect(t.pictures).toMatchObject([{ kind: "capital-layer", name: "HUMAN/LAYER_110", archive: "capital.dat", change: "added" }]);
    expect(d.summary.races.changed).toEqual([RACE]);
    expect(d.capitalOther).toEqual([]);
  });

  it("parses capital.dat sections, building lists and layers", () => {
    const [s] = parseCapitalDat("[DWARF]\nLayerInfoCount=1\nLAYERINFO_00=1,g000bb0007,\nLAYER_200=g000bb0007,smithy,1,2,3,4\nLAYER_010=,SKY,0,0,-1,-1\n");
    expect(s).toEqual({
      name: "DWARF",
      infos: [{ n: "00", flag: "1", build: "G000BB0007" }],
      layers: [
        { z: "200", build: "G000BB0007", picture: "SMITHY", values: ["1", "2", "3", "4"], rect: [1, 2, 3, 4] },
        { z: "010", build: null, picture: "SKY", values: ["0", "0", "-1", "-1"], rect: [0, 0, -1, -1] },
      ],
      other: { LayerInfoCount: "1" },
    });
  });

  it("groups a GmodifL effect change under its modifier, and shows it under the units that carry it", () => {
    const d = diff((b) => {
      b.GmodifL![1]!.PERCENT = 15; // M1's second effect
    });
    expect(ids(d, "modifiers")).toEqual([M1]);
    const m = entity(d, "modifiers", M1);
    expect(m).toMatchObject({ status: "changed", nameA: "Mod one", fields: [], owned: [] });
    expect(m.lists).toHaveLength(1);
    const l = m.lists[0]!;
    expect(l).toMatchObject({ table: "GmodifL", ownerColumn: "BELONGS_TO", owner: M1 });
    expect(l.a.map((r) => r.PERCENT)).toEqual([10, 5]);
    expect(l.b.map((r) => r.PERCENT)).toEqual([10, 15]);
    expect(l.removed).toEqual([{ BELONGS_TO: M1, TYPE: 2, PERCENT: 5, DESC: "" }]);
    expect(l.added).toEqual([{ BELONGS_TO: M1, TYPE: 2, PERCENT: 15, DESC: "" }]);
    expect(l.ops).toHaveLength(2);
    expect(d.tables.find((t) => t.name === "GmodifL")!.counts).toEqual({ set: 0, add: 1, delete: 1 });
    // U2 carries M1 through GUmodif
    expect(entity(d, "units", U2)).toMatchObject({ status: "via-shared", shared: [{ via: "GUmodif.MODIF_1", section: "modifiers", id: M1, name: "Mod one", status: "changed" }] });
    expect(ids(d, "units")).toEqual([U2]);
  });

  it("compares pictures by sheet blob and rectangle, never by sheet index", () => {
    const X = blob("1");
    const Y = blob("2");
    const Z = blob("3");
    const r1 = [0, 0, 10, 10, 0, 0, 10, 10];
    const r2 = [10, 0, 10, 10, 0, 0, 10, 10];
    const manifestA: SpriteManifest = {
      spritesheets: [
        { id: "IsoUnit-0", ff: "IsoUnit.ff", image: X },
        { id: "IsoUnit-1", ff: "IsoUnit.ff", image: Y },
      ],
      frames: { G000UU0001STOP0: [1, ...r1], G000UU0002STOP0: [0, ...r1], G000UU0001MOVE0: [0, ...r2] },
      animations: [{ id: "G000UU0001STOP", frames: ["G000UU0001STOP0"] }],
    };
    // the sheets renumbered: Y is now sheet 0; U2's sheet is a new blob; U1MOVE0 keeps index 0, now on Y
    const manifestB: SpriteManifest = {
      spritesheets: [
        { id: "IsoUnit-0", ff: "IsoUnit.ff", image: Y },
        { id: "IsoUnit-1", ff: "IsoUnit.ff", image: Z },
      ],
      frames: { G000UU0001STOP0: [0, ...r1], G000UU0002STOP0: [1, ...r1], G000UU0001MOVE0: [0, ...r2] },
      animations: [{ id: "G000UU0001STOP", frames: ["G000UU0001STOP0"] }],
    };
    const icons = (digit: string) => ({ "uniticons/G000UU0002.png": blob(digit) });
    const d = diff(() => {}, { manifest: manifestA, files: icons("4") }, { manifest: manifestB, files: icons("5") });
    expect(d.pictures.frames).toEqual({ same: 1, added: 0, removed: 0, changed: 2 });
    expect(d.pictures.animations).toEqual({ same: 1, added: 0, removed: 0, changed: 0 });
    expect(d.pictures.icons).toEqual({ same: 0, added: 0, removed: 0, changed: 1 });
    expect(d.pictures.changes.map((c) => c.name).sort()).toEqual(["G000UU0001MOVE0", "G000UU0002STOP0", "uniticons/G000UU0002.png"]);
    const u1 = entity(d, "units", U1);
    expect(u1.status).toBe("art-only");
    expect(u1.pictures).toMatchObject([{ kind: "frame", name: "G000UU0001MOVE0", archive: "IsoUnit.ff", change: "changed", a: { sha256: hash("1"), rect: r2 }, b: { sha256: hash("2"), rect: r2 } }]);
    const u2 = entity(d, "units", U2);
    expect(u2.status).toBe("art-only");
    expect(u2.pictures.map((p) => [p.kind, p.a?.sha256, p.b?.sha256])).toEqual(
      expect.arrayContaining([
        ["frame", hash("1"), hash("3")],
        ["icon", hash("4"), hash("5")],
      ]),
    );
    expect(d.summary.sections.units.artOnly).toBe(2);

    // only renumbered: nothing changed
    const swapped: SpriteManifest = {
      spritesheets: [manifestA.spritesheets[1]!, manifestA.spritesheets[0]!],
      frames: Object.fromEntries(Object.entries(manifestA.frames!).map(([k, v]) => [k, [1 - v[0]!, ...v.slice(1)]])),
      animations: manifestA.animations,
    };
    const same = diff(() => {}, { manifest: manifestA }, { manifest: swapped });
    expect(same.pictures.frames).toEqual({ same: 3, added: 0, removed: 0, changed: 0 });
    expect(same.pictures.changes).toEqual([]);
    expect(same.sections.units).toEqual([]);
  });

  it("compares modscripts by hash and names the modifiers whose SCRIPT is the file", () => {
    const d = diff(
      () => {},
      { files: { "modscripts/drawing/x.lua": blob("6", "lua") } },
      { files: { "modscripts/drawing/x.lua": blob("7", "lua"), "modscripts/new.lua": blob("8", "lua") } },
    );
    expect(d.scripts).toEqual([
      { path: "modscripts/drawing/x.lua", change: "changed", a: hash("6"), b: hash("7"), modifiers: [{ section: "modifiers", id: M2, name: "Mod two" }] },
      { path: "modscripts/new.lua", change: "added", b: hash("8"), modifiers: [] },
    ]);
    expect(entity(d, "modifiers", M2)).toMatchObject({ status: "changed", scripts: [{ path: "modscripts/drawing/x.lua", change: "changed" }] });
    expect(d.summary.scripts).toEqual({ added: 1, changed: 1, removed: 0 });
  });

  it("keeps the ops of a table no entity covers under the table, with the old values", () => {
    const d = diff((b) => {
      rowOf(b.LAttR!, "ID", 2).TEXT = "All";
    });
    const t = d.tables.find((x) => x.name === "LAttR")!;
    expect(t).toMatchObject({ presence: "both", coverage: "table", rowsA: 2, rowsB: 2, keyColumns: ["ID"], counts: { set: 1, add: 0, delete: 0 } });
    expect(t.ops).toEqual([{ op: "dbf.set", key: [2], keyText: "[2]", field: "TEXT", was: "Any", value: "All", owners: [] }]);
    expect(d.summary).toMatchObject({ unassignedOps: 0, assignedOps: 0, tableOnlyOps: 1 });
    for (const s of SECTIONS) expect(d.sections[s]).toEqual([]);
  });

  it("counts no change where one mod leaves an id cell empty and the other writes G000000000", () => {
    const ra = baseRows();
    const rb = baseRows();
    rowOf(ra.Gunits!, "UNIT_ID", U1).ATTACK2_ID = "";
    rowOf(rb.Gunits!, "UNIT_ID", U1).ATTACK2_ID = "g000000000";
    // a whole-row table: there the spelling would be a deleted row and an added one
    ra.GUmodif!.push({ UNIT_ID: U1, MODIF_1: "" });
    rb.GUmodif!.push({ UNIT_ID: U1, MODIF_1: "G000000000" });
    const d = diffMods(mod("a", ra), mod("b", rb));
    for (const s of SECTIONS) expect(d.sections[s]).toEqual([]);
    expect(d.summary.tables).toMatchObject({ ops: 0, differ: 0, noIdSpellings: 2 });
    for (const name of ["Gunits", "GUmodif"]) {
      expect(d.tables.find((t) => t.name === name)).toMatchObject({ ops: [], counts: { set: 0, add: 0, delete: 0 }, noIdSpellings: 1 });
    }
  });

  it("still counts an id written where the other mod has an empty cell", () => {
    const ra = baseRows();
    const rb = baseRows();
    rowOf(ra.Gunits!, "UNIT_ID", U1).ATTACK2_ID = "";
    rowOf(rb.Gunits!, "UNIT_ID", U1).ATTACK2_ID = A2;
    ra.GUmodif!.push({ UNIT_ID: U1, MODIF_1: "" });
    rb.GUmodif!.push({ UNIT_ID: U1, MODIF_1: M2 });
    const d = diffMods(mod("a", ra), mod("b", rb));
    expect(entity(d, "units", U1).fields.map((f) => f.field)).toEqual(["ATTACK2_ID"]);
    expect(d.tables.find((t) => t.name === "Gunits")).toMatchObject({ counts: { set: 1, add: 0, delete: 0 }, noIdSpellings: 0 });
    expect(d.tables.find((t) => t.name === "GUmodif")).toMatchObject({ counts: { set: 0, add: 1, delete: 1 }, noIdSpellings: 0 });
    expect(d.summary.tables.noIdSpellings).toBe(0);
  });

  describe("texts", () => {
    const RU: Record<string, string> = { x000tg0001: "Сквайр", x000tg0002: "Лучник", x000tg0003: "Удар", x000tg0004: "Выстрел", x000tg0005: "Империя", x000tg0006: "Храм", x000tg0007: "Мод один", x000tg0008: "Мод два" };
    /** B in Russian, with one stat changed and one text added. */
    const russian = (b: ModRows) => {
      for (const r of b.Tglobal!) r.TEXT = RU[r.TXT_ID as string]!;
      b.Tglobal!.push({ TXT_ID: "x000tg0009", TEXT: "Новый текст" });
      rowOf(b.Gunits!, "UNIT_ID", U1).HIT_POINT = 120;
    };
    const run = (texts?: "compare" | "skip" | "auto") => {
      const b = baseRows();
      russian(b);
      return diffMods(mod("a", baseRows()), mod("b", b), texts ? { texts } : {});
    };

    it("compares the wording by default", () => {
      const d = run();
      expect(d.texts).toEqual({ a: "latin", b: "cyrillic", skipped: false });
      expect(d.tables.find((t) => t.name === "Tglobal")).toMatchObject({ counts: { set: 8, add: 1, delete: 0 }, translations: 0 });
      expect(entity(d, "units", U1).texts.map((t) => t.b)).toEqual(["Сквайр"]);
    });

    it("with skip, counts a reworded text and keeps the rest", () => {
      const d = run("skip");
      expect(d.texts.skipped).toBe(true);
      const t = d.tables.find((x) => x.name === "Tglobal")!;
      expect(t).toMatchObject({ counts: { set: 0, add: 1, delete: 0 }, translations: 8 });
      expect(t.ops.map((o) => o.keyText)).toEqual(['["X000TG0009"]']);
      expect(d.summary.tables.translations).toBe(8);
      const u = entity(d, "units", U1);
      expect(u.fields).toEqual([{ table: "Gunits", field: "HIT_POINT", a: 100, b: 120 }]);
      expect(u.texts).toEqual([]);
      expect(ids(d, "attacks")).toEqual([]);
    });

    it("with auto, skips when the two mods write in different scripts", () => {
      expect(run("auto").texts.skipped).toBe(true);
      const b = baseRows();
      rowOf(b.Tglobal!, "TXT_ID", "x000tg0001").TEXT = "Knight";
      const same = diffMods(mod("a", baseRows()), mod("b", b), { texts: "auto" });
      expect(same.texts).toEqual({ a: "latin", b: "latin", skipped: false });
      expect(same.summary.tables.translations).toBe(0);
      expect(entity(same, "units", U1).texts.map((t) => t.b)).toEqual(["Knight"]);
    });
  });

  it("reports a table only one mod has", () => {
    const b = baseRows();
    delete b.LAttR;
    const d = diffMods(mod("a", baseRows()), mod("b", b));
    expect(d.tables.find((x) => x.name === "LAttR")).toMatchObject({ presence: "onlyA", rowsA: 2, rowsB: null, ops: [] });
    expect(d.summary.tables.onlyA).toEqual(["LAttR"]);
  });
});

describe("decodeTable", () => {
  it("reads every cell as @d2/dbf does", () => {
    const t0 = DbfTable.create("T", [
      { name: "ID", type: "C", length: 10 },
      { name: "TEXT", type: "C", length: 20 },
      { name: "NUM", type: "N", length: 6, decimals: 2 },
      { name: "INT", type: "N", length: 4 },
      { name: "FLAG", type: "L", length: 1 },
    ]);
    t0.appendRow({ ID: "g000uu0001", TEXT: "Оруженосец  ", NUM: 1.5, INT: -3, FLAG: true });
    t0.appendRow({ ID: "x", TEXT: "", NUM: null, INT: null, FLAG: false });
    t0.appendRow({ ID: "gone", TEXT: "\\fNormal;Тест", NUM: 0, INT: 0, FLAG: true });
    t0.setDeleted(2, true);
    const t = DbfTable.read(t0.toBytes(), "T");
    const fast = decodeTable(t);
    const slow = Array.from({ length: t.rowCount }, (_, r) => (t.isDeleted(r) ? null : decodeRow(t, r)));
    expect(fast).toEqual(slow);
    expect(fast[0]).toEqual({ ID: "g000uu0001", TEXT: "Оруженосец", NUM: 1.5, INT: -3, FLAG: true });
    expect(fast[2]).toBeNull();
  });

  it("matches on a built table", () => {
    const t = table("Gunits", [{ name: "UNIT_ID", type: "C", length: 10 }], [{ UNIT_ID: U1 }]);
    expect(decodeTable(t)).toEqual([{ UNIT_ID: U1 }]);
  });
});
