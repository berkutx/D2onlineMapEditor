/**
 * A small mod store for the compare page's tests: the REST routes the page calls
 * (/api/mods, /api/mods/:id, /api/mods/:id/files) and the files under each mod's assetBase.
 * Every request is logged, so a test can count downloads.
 */
import { createHash } from "node:crypto";
import { DbfTable, type DbfFieldSpec, type DbfValue } from "@d2/dbf";

const c = (name: string, length = 10): DbfFieldSpec => ({ name, type: "C", length });
const n = (name: string, length = 4): DbfFieldSpec => ({ name, type: "N", length });

const SPECS: Record<string, DbfFieldSpec[]> = {
  Tglobal: [c("TXT_ID"), c("TEXT", 40)],
  Gunits: [c("UNIT_ID"), c("RACE_ID"), c("NAME_TXT"), n("LEVEL", 2), n("HIT_POINT"), c("ATTACK_ID")],
  Gattacks: [c("ATT_ID"), c("NAME_TXT"), n("POWER", 3)],
};

/** The bytes of a table file (the same rows give the same bytes). */
export function dbf(name: string, rows: Record<string, DbfValue>[]): Uint8Array {
  const t = DbfTable.create(name, SPECS[name]!);
  for (const r of rows) t.appendRow(r);
  return t.toBytes();
}

export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const text = (s: string) => new TextEncoder().encode(s);

export const U1 = "G000UU0001";
export const U2 = "G000UU0002";
export const U3 = "G000UU0003";
export const A1 = "G000AA0001";
const RACE = "G000RR0000";

export interface FakeMod {
  id: string;
  name: string;
  family: string;
  familyOrder: number;
  parent?: string;
  /** The unmodded game (ModInfo.reference). */
  reference?: boolean;
  /** Left out of /api/mods (a closed mod), still served by id. */
  hidden?: boolean;
  files: Record<string, Uint8Array>;
}

const texts = dbf("Tglobal", [
  { TXT_ID: "x000tg0001", TEXT: "Squire" },
  { TXT_ID: "x000tg0002", TEXT: "Archer" },
  { TXT_ID: "x000tg0003", TEXT: "Strike" },
  { TXT_ID: "x000tg0004", TEXT: "Knight" },
]);
const attacks = dbf("Gattacks", [{ ATT_ID: A1, NAME_TXT: "X000TG0003", POWER: 25 }]);
const unit = (id: string, name: string, hp: number) => ({ UNIT_ID: id, RACE_ID: RACE, NAME_TXT: name, LEVEL: 1, HIT_POINT: hp, ATTACK_ID: A1 });

/**
 * semga (default) and semga-2 (derived from it): Tglobal and Gattacks are the same file,
 * Gunits differs (U1 has more hit points, U3 is new), the unit icon and a script differ.
 * "closed" has pictures and scripts but no tables.
 */
export function sampleMods(): FakeMod[] {
  return [
    {
      id: "semga",
      name: "Semga",
      family: "semga",
      familyOrder: 1,
      files: {
        "tables/Tglobal.dbf": texts,
        "tables/Gattacks.dbf": attacks,
        "tables/Gunits.dbf": dbf("Gunits", [unit(U1, "X000TG0001", 100), unit(U2, "X000TG0002", 80)]),
        "uniticons/g000uu0001.png": new Uint8Array([1, 2, 3]),
        "modscripts/a.lua": text("local x = 1\nreturn x\n"),
      },
    },
    {
      id: "semga-2",
      name: "Semga 2",
      family: "semga",
      familyOrder: 2,
      parent: "semga",
      files: {
        "tables/Tglobal.dbf": texts,
        "tables/Gattacks.dbf": attacks,
        "tables/Gunits.dbf": dbf("Gunits", [unit(U1, "X000TG0001", 120), unit(U2, "X000TG0002", 80), unit(U3, "X000TG0004", 150)]),
        "uniticons/g000uu0001.png": new Uint8Array([4, 5, 6]),
        "modscripts/a.lua": text("local x = 2\nreturn x\n"),
      },
    },
    {
      id: "closed",
      name: "Closed",
      family: "closed",
      familyOrder: 1,
      hidden: true,
      files: {
        "uniticons/g000uu0001.png": new Uint8Array([7, 8, 9]),
        "modscripts/a.lua": text("return 3\n"),
      },
    },
  ];
}

/**
 * The sample mods plus the unmodded game, "vanilla" (reference), whose texts are in English
 * like semga's, and "semga-ru": semga's units with the texts in Russian.
 */
export function referenceMods(): FakeMod[] {
  const mods = sampleMods();
  const semga = mods.find((m) => m.id === "semga")!;
  mods.unshift({ id: "vanilla", name: "Vanilla", family: "vanilla", familyOrder: 0, reference: true, files: { ...semga.files } });
  mods.push({
    id: "semga-ru",
    name: "Semga RU",
    family: "semga-ru",
    familyOrder: 1,
    files: {
      ...semga.files,
      "tables/Tglobal.dbf": dbf("Tglobal", [
        { TXT_ID: "x000tg0001", TEXT: "Сквайр" },
        { TXT_ID: "x000tg0002", TEXT: "Лучник" },
        { TXT_ID: "x000tg0003", TEXT: "Удар" },
        { TXT_ID: "x000tg0004", TEXT: "Рыцарь" },
      ]),
      "tables/Gunits.dbf": dbf("Gunits", [unit(U1, "X000TG0001", 120), unit(U2, "X000TG0002", 80)]),
    },
  });
  return mods;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeServer(mods: FakeMod[], defaultModId: string) {
  const calls: string[] = [];
  const info = (m: FakeMod) => ({ id: m.id, name: m.name, family: m.family, familyOrder: m.familyOrder, status: "ready", rev: "r1", assetBase: `/assets/mods/${m.id}`, ...(m.reference ? { reference: true } : {}) });
  const byId = (id: string) => mods.find((m) => m.id === id);
  const fetchFn = async (url: string): Promise<Response> => {
    calls.push(url);
    const u = new URL(url, "http://test");
    const path = decodeURIComponent(u.pathname);
    if (path === "/api/mods") return json({ defaultModId, mods: mods.filter((m) => !m.hidden).map(info) });
    let hit = /^\/api\/mods\/([^/]+)$/.exec(path);
    if (hit) {
      const m = byId(hit[1]!);
      return m ? json({ ...info(m), ...(m.parent ? { parent: { modId: m.parent, contentFingerprint: "fp" } } : {}) }) : json({ error: "no mod" }, 404);
    }
    hit = /^\/api\/mods\/([^/]+)\/files$/.exec(path);
    if (hit) {
      const m = byId(hit[1]!);
      if (!m) return json({ error: "no mod" }, 404);
      const prefix = u.searchParams.get("prefix") ?? "";
      const files: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(m.files)) if (name.startsWith(prefix)) files[name] = sha256(bytes);
      return json({ files });
    }
    hit = /^\/assets\/mods\/([^/]+)\/(.+)$/.exec(path);
    if (hit) {
      const bytes = byId(hit[1]!)?.files[hit[2]!];
      return bytes ? new Response(bytes.slice()) : new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  };
  /** How many requests asked for a path ending in `tail`. */
  const count = (tail: string) => calls.filter((c) => new URL(c, "http://test").pathname.endsWith(tail)).length;
  return { fetchFn, calls, count };
}
