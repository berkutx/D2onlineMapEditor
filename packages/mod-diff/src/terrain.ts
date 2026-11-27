/**
 * Terrain by its two-letter code. The game has six terrains and water, fixed in the exe; a
 * "new terrain" in a mod is new art for one of them: forests `<code>F####`, mountains
 * `MOMNE####` / `MOM<code>...`, ground textures (`<code>_nn`, or the store's composed tiles
 * `T<terrainId>_...`, `TW_...`), borders (`NE_xx_yy`, `WA_xx_yy`, composed `E_<id>_...`, `WF_...`),
 * plus the GTileDBI tile counts of the code.
 */
import type { FrameInfo } from "./pictures.js";
import type { ModSide } from "./side.js";
import type { PictureChange } from "./types.js";

export type TerrainKind = "forests" | "mountains" | "ground" | "borders";

export interface TerrainCodes {
  /** code -> { Lterrain ID, TEXT } (WA has no row). */
  codes: Map<string, { id: number | null; name: string | null }>;
  /** Lterrain ID -> code */
  byId: Map<number, string>;
}

export const WATER = "WA";

export function terrainCodes(sides: ModSide[]): TerrainCodes {
  const codes = new Map<string, { id: number | null; name: string | null }>();
  const byId = new Map<number, string>();
  for (const s of sides) {
    for (const row of s.liveRows("lterrain")) {
      if (typeof row.ID !== "number" || typeof row.TEXT !== "string") continue;
      const code = row.TEXT.replace(/^L_/i, "").toUpperCase();
      if (!/^[A-Z]{2}$/.test(code)) continue;
      if (!codes.has(code)) codes.set(code, { id: row.ID, name: row.TEXT });
      if (!byId.has(row.ID)) byId.set(row.ID, code);
    }
  }
  if (!codes.has(WATER)) codes.set(WATER, { id: null, name: null });
  return { codes, byId };
}

/** The terrain code and kind of a picture name, "other" for IsoTerrn art of no code, else undefined. */
export function terrainOf(name: string, archive: string | null, tc: TerrainCodes): { code: string; kind: TerrainKind } | "other" | undefined {
  const has = (c: string) => tc.codes.has(c);
  let m = /^([A-Z]{2})F\d{4}$/.exec(name);
  if (m && has(m[1]!)) return { code: m[1]!, kind: "forests" };
  m = /^MOM_?([A-Z]{2})_?\d+$/.exec(name);
  if (m && has(m[1]!)) return { code: m[1]!, kind: "mountains" };
  m = /^T(\d+)_\d+_\d+_\d+$/.exec(name);
  if (m) {
    const code = tc.byId.get(Number(m[1]));
    if (code) return { code, kind: "ground" };
  }
  if (/^TW_\d+_\d+$/.test(name)) return { code: WATER, kind: "ground" };
  m = /^([A-Z]{2})_\d{2}$/.exec(name);
  if (m && has(m[1]!)) return { code: m[1]!, kind: "ground" };
  m = /^E_(\d+)_/.exec(name);
  if (m) {
    const code = tc.byId.get(Number(m[1]));
    if (code) return { code, kind: "borders" };
  }
  if (/^WF_/.test(name)) return { code: WATER, kind: "borders" };
  m = /^([A-Z]{2})_\d{2}_\d{2}$/.exec(name);
  if (m && has(m[1]!)) return { code: m[1]!, kind: "borders" };
  if (archive && /^isoterrn\.ff$/i.test(archive)) return "other";
  return undefined;
}

export function countTerrainArt(frames: Map<string, FrameInfo>, tc: TerrainCodes): Map<string, { forests: number; mountains: number }> {
  const out = new Map<string, { forests: number; mountains: number }>();
  for (const [name, f] of frames) {
    const t = terrainOf(name, f.archive, tc);
    if (!t || t === "other" || (t.kind !== "forests" && t.kind !== "mountains")) continue;
    const n = out.get(t.code) ?? { forests: 0, mountains: 0 };
    n[t.kind]++;
    out.set(t.code, n);
  }
  return out;
}

export function terrainPictures(changes: PictureChange[], tc: TerrainCodes): { byCode: Map<string, Record<TerrainKind, PictureChange[]>>; other: PictureChange[] } {
  const byCode = new Map<string, Record<TerrainKind, PictureChange[]>>();
  const other: PictureChange[] = [];
  for (const c of changes) {
    if (c.kind !== "frame" && c.kind !== "animation") continue;
    const t = terrainOf(c.name, c.archive, tc);
    if (!t) continue;
    if (t === "other") {
      other.push(c);
      continue;
    }
    let rec = byCode.get(t.code);
    if (!rec) byCode.set(t.code, (rec = { forests: [], mountains: [], ground: [], borders: [] }));
    rec[t.kind].push(c);
  }
  return { byCode, other };
}
