/**
 * A game folder for a derived mod, made from its parent's install and its edit file, for the
 * store builders to read (tools/asset-pipeline/derive_mod.py runs build_mod.py over it).
 *
 * Every file of Globals, Scripts, Imgs and Interf and the .exe/.dll at the root is a HARD
 * LINK to the parent's file (no disk space, the same bytes); only the files the edits change
 * are written, as new files that are never links ('wx': a write cannot go through a link into
 * the parent's install). Archives the store build does not read (BatUnits, Events, …) are not
 * written: their ops are reported as carried, and applied in memory all the same, so that
 * their conflicts are found. On any conflict nothing is left behind.
 */
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DbfTable } from "@d2/dbf";
import { FfArchive } from "@d2/ff";
import { activeOps, type FfOp, type ModEdits } from "../editFile.js";
import { foldEdits } from "../fold.js";
import { applyTableEdits, type ApplyResult, type Conflict } from "../applyTable.js";
import { applyArchiveEdits } from "../applyArchive.js";

/** The archives build_mod.py reads (its FINGERPRINT_ARCHIVES), all in Imgs. */
export const STORE_BUILD_ARCHIVES: readonly string[] = [
  "IsoTerrn.ff", "IsoStill.ff", "IsoCmon.ff", "City.ff", "Capital.ff", "IsoAnim.ff",
  "IsoUnit.ff", "Ground.ff", "GrBorder.ff", "IconItem.ff", "IconSpel.ff", "Lords.ff",
  "Faces.ff",
];

/** The parts of an install a derived folder takes from its parent. */
export const LINKED_FOLDERS: readonly string[] = ["Globals", "Scripts", "Imgs", "Interf"];

export interface MaterializeOptions {
  /** The parent's game folder (the one with Globals, Imgs, Scripts). */
  parentGame: string;
  edits: ModEdits;
  /** Where ff.putRecord payload files are, as <sha256>.bin. */
  payloadDir?: string;
  /** The folder to make; must not exist. Omit to only check the edits. */
  out?: string;
  /** Write every edited archive, not only the ones the store build reads. */
  allArchives?: boolean;
}

export interface WrittenFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface MaterializeReport {
  out: string | null;
  linked: number;
  written: WrittenFile[];
  /** Archive ops kept in the edit file but not applied here. */
  carried: { archive: string; ops: number }[];
  /** Per table or archive: what applying did. */
  applied: Record<string, ApplyResult["counts"]>;
  conflicts: Conflict[];
}

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** An entry of a folder by name, ignoring case. */
export function findEntry(dir: string, name: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const hit = readdirSync(dir).find((n) => n.toLowerCase() === name.toLowerCase());
  return hit === undefined ? undefined : join(dir, hit);
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

interface Target {
  /** Table or archive name as the edits give it. */
  name: string;
  /** Its file in the parent's install. */
  path: string;
}

export function materialize(o: MaterializeOptions): MaterializeReport {
  const report: MaterializeReport = { out: null, linked: 0, written: [], carried: [], applied: {}, conflicts: [] };
  const folded = foldEdits(activeOps(o.edits), o.edits);
  const game = o.parentGame;
  const folder = (name: string) => findEntry(game, name);
  const globals = folder("Globals");
  const interf = folder("Interf");
  const imgs = folder("Imgs");

  // where each edited table and archive is in the parent's install
  const tables: (Target & { key: string })[] = [];
  for (const [key, t] of Object.entries(folded.tables)) {
    const path = (globals && findEntry(globals, `${t.table}.dbf`)) || (interf && findEntry(interf, `${t.table}.dbf`));
    if (!path) report.conflicts.push({ file: t.table, reason: "no-table", detail: `the parent has no ${t.table}.dbf in Globals or Interf` });
    else tables.push({ key, name: t.table, path });
  }
  const archives: (Target & { ops: FfOp[] })[] = [];
  const carried: (Target & { ops: FfOp[] })[] = [];
  for (const ops of Object.values(folded.archives)) {
    const name = ops[0]!.archive;
    const inImgs = imgs && findEntry(imgs, name);
    const path = inImgs || (interf && findEntry(interf, name));
    if (!path) {
      report.conflicts.push({ file: name, reason: "no-archive", detail: `the parent has no ${name} in Imgs or Interf` });
      continue;
    }
    const read = !!inImgs && STORE_BUILD_ARCHIVES.some((a) => a.toLowerCase() === name.toLowerCase());
    if (read || o.allArchives) archives.push({ name, path, ops });
    else {
      carried.push({ name, path, ops });
      report.carried.push({ archive: name, ops: ops.length });
    }
  }

  // tables are small: apply them all before anything is made
  const tableBytes = new Map<string, Uint8Array>();
  for (const t of tables) {
    const table = DbfTable.read(readFileSync(t.path), t.name);
    const res = applyTableEdits(table, folded.tables[t.key]!);
    report.applied[t.name] = res.counts;
    report.conflicts.push(...res.conflicts);
    if (res.changed) tableBytes.set(t.path, table.toBytes());
  }
  const io = {
    sha256,
    payload: (sha: string) => {
      const p = o.payloadDir && join(o.payloadDir, `${sha}.bin`);
      return p && existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined;
    },
  };
  const applyArchive = (t: Target & { ops: FfOp[] }, bytes: boolean): Uint8Array | null => {
    const archive = FfArchive.read(new Uint8Array(readFileSync(t.path)), t.name);
    const res = applyArchiveEdits(archive, t.ops, io);
    report.applied[t.name] = res.counts;
    report.conflicts.push(...res.conflicts);
    return res.conflicts.length || !res.changed || !bytes ? null : archive.toBytes();
  };

  // archives one at a time, in memory only: the carried ones always (their ops stay in the
  // edit file, so they must still apply), the written ones too when only checking
  if (!report.conflicts.length) for (const t of [...carried, ...(o.out ? [] : archives)]) applyArchive(t, false);
  if (!o.out || report.conflicts.length) return report;

  const out = o.out;
  if (existsSync(out)) throw new Error(`${out} exists; a derived game folder is always made fresh`);
  const rewritten = new Set([...tableBytes.keys(), ...archives.map((a) => a.path)].map((p) => p.toLowerCase()));
  try {
    mkdirSync(out, { recursive: true });
    const sources: string[] = [];
    for (const name of LINKED_FOLDERS) {
      const dir = folder(name);
      if (dir && statSync(dir).isDirectory()) sources.push(...filesUnder(dir));
    }
    for (const entry of readdirSync(game, { withFileTypes: true })) {
      if (entry.isFile() && /\.(exe|dll)$/i.test(entry.name)) sources.push(join(game, entry.name));
    }
    for (const src of sources) {
      if (rewritten.has(src.toLowerCase())) continue;
      const dst = join(out, relative(game, src));
      mkdirSync(dirname(dst), { recursive: true });
      linkSync(src, dst);
      report.linked++;
    }
    const write = (src: string, bytes: Uint8Array) => {
      const dst = join(out, relative(game, src));
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, bytes, { flag: "wx" });
      report.written.push({ path: relative(out, dst).replace(/\\/g, "/"), bytes: bytes.length, sha256: sha256(bytes) });
    };
    for (const [src, bytes] of tableBytes) write(src, bytes);
    for (const t of archives) {
      const bytes = applyArchive(t, true);
      if (report.conflicts.length) throw new Error("conflicts");
      if (bytes) write(t.path, bytes);
      else {
        // nothing changed after all: take the parent's file
        const dst = join(out, relative(game, t.path));
        mkdirSync(dirname(dst), { recursive: true });
        linkSync(t.path, dst);
        report.linked++;
      }
    }
    report.out = out;
    return report;
  } catch (e) {
    rmSync(out, { recursive: true, force: true });
    if (report.conflicts.length) return { ...report, linked: 0, written: [] };
    throw e;
  }
}
