#!/usr/bin/env node
/**
 * The derived-mod tool. Edit files are local working files (by default under
 * var/mod-edits/<modId>/, which git ignores); a store entry is made from one with
 * tools/asset-pipeline/derive_mod.py, which runs `materialize` below.
 *
 *   init        --parent <modId> --parent-game <dir> --mod-id <id> --name <text> --edits <file>
 *               [--parent-fingerprint <sha256>] [--others <dir>]
 *               A new edit file with an id namespace no id of the parent (tables and Lua)
 *               and no other edit file under --others (default: this repo's var/mod-edits)
 *               uses.
 *   check       --parent-game <dir> --edits <file> [--payloads <dir>] [--json]
 *               Applies the edits in memory and reports conflicts; writes nothing.
 *   materialize --parent-game <dir> --edits <file> --out <dir> [--payloads <dir>]
 *               [--all-archives] [--json]
 *               A game folder for the store builders: the parent's files as hard links, the
 *               edited tables and archives written. --out must not exist.
 *   diff        --parent <modId> --parent-game <dir> --child <dir> --mod-id <id> --name <text>
 *               --edits <file> [--parent-fingerprint <sha256>] [--json]
 *               The table edits that turn the parent's tables into the child's (another
 *               install, or a folder of hand-edited .dbf files), as a one-commit edit file.
 *
 * Exit status: 0 done, 1 conflicts or refused, 2 bad arguments.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { declareKey, registeredKey } from "../keys.js";
import { diffTable, DiffError } from "../diff.js";
import { MOD_EDITS_KIND, newModEdits, parseModEdits, pushCommit, type DbfOp, type KeyDecl, type ModEdits } from "../editFile.js";
import { idsIn, idsInEdits, idsInText, namespacesOf, pickNamespace } from "../ids.js";
import { materialize, type MaterializeReport } from "./materialize.js";
import { luaFiles, readTable, tableFiles } from "./tables.js";

class UsageError extends Error {}

type Args = Record<string, string | true>;

/** The options of each command; a flag takes no value. */
const OPTIONS: Record<string, { values: string[]; flags: string[] }> = {
  init: { values: ["parent", "parent-game", "mod-id", "name", "edits", "parent-fingerprint", "others"], flags: [] },
  check: { values: ["parent-game", "edits", "payloads"], flags: ["json"] },
  materialize: { values: ["parent-game", "edits", "out", "payloads"], flags: ["all-archives", "json"] },
  diff: { values: ["parent", "parent-game", "child", "mod-id", "name", "edits", "parent-fingerprint"], flags: ["json"] },
};

/** This repo's var/mod-edits (dist/node/cli.js is four folders down), where edit files live. */
const REPO_EDITS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "var", "mod-edits");

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command, ...rest] = argv;
  if (!command || command.startsWith("-")) throw new UsageError("usage: mod-edit <init|check|materialize|diff> [options]");
  const spec = OPTIONS[command];
  if (!spec) throw new UsageError(`no command ${command} (init, check, materialize, diff)`);
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (spec.flags.includes(name)) {
      args[name] = true;
      continue;
    }
    if (!spec.values.includes(name)) throw new UsageError(`${command} has no option --${name}`);
    // the next argument is the value, whatever it looks like (a name may start with "--")
    const next = rest[i + 1];
    if (next === undefined) throw new UsageError(`--${name} needs a value`);
    args[name] = next;
    i++;
  }
  return { command, args };
}

function need(args: Args, name: string): string {
  const v = args[name];
  if (typeof v !== "string") throw new UsageError(`--${name} <value> is required`);
  return v;
}

function opt(args: Args, name: string): string | undefined {
  const v = args[name];
  if (v === true) throw new UsageError(`--${name} needs a value`);
  return v;
}

function readEdits(path: string): ModEdits {
  return parseModEdits(JSON.parse(readFileSync(path, "utf8")));
}

function writeEdits(path: string, e: ModEdits) {
  if (existsSync(path)) throw new UsageError(`${path} exists; not overwriting an edit file`);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(e, null, 2) + "\n", { flag: "wx" });
}

/** Namespaces of every edit file under a folder (recursively), and the ids they name. */
function otherEdits(dir: string | undefined): { namespaces: Set<string>; ids: Set<string> } {
  const namespaces = new Set<string>();
  const ids = new Set<string>();
  if (!dir) return { namespaces, ids };
  if (!existsSync(dir)) throw new UsageError(`--others ${dir} does not exist`);
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.json$/i.test(e.name)) {
        let json: unknown;
        try {
          json = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
        } catch (err) {
          // an edit file that does not read would hide its namespace
          throw new UsageError(`${p} is not JSON (${(err as Error).message}); fix or move it before init`);
        }
        if ((json as { kind?: unknown })?.kind !== MOD_EDITS_KIND) continue;
        const edits = parseModEdits(json);
        if (edits.ids) namespaces.add(edits.ids.namespace);
        for (const id of idsInEdits(edits)) ids.add(id);
      }
    }
  };
  walk(dir);
  return { namespaces, ids };
}

/** The tables of a game folder; refuses a folder that has none (the wrong level, a typo). */
function tablesOf(game: string, what: string): Map<string, string> {
  if (!existsSync(game)) throw new UsageError(`${what} ${game} does not exist`);
  const files = tableFiles(game);
  if (!files.size) throw new UsageError(`${what} ${game} has no tables (no Globals folder, no .dbf files)`);
  return files;
}

function init(args: Args) {
  const game = need(args, "parent-game");
  const out = need(args, "edits");
  const taken = new Set<string>();
  const tables = [...tablesOf(game, "--parent-game")].map(([name, path]) => readTable(path, name));
  for (const id of idsIn(tables)) taken.add(id);
  for (const lua of luaFiles(game)) idsInText(readFileSync(lua, "latin1"), taken);
  const others = otherEdits(opt(args, "others") ?? (existsSync(REPO_EDITS) ? REPO_EDITS : undefined));
  for (const id of others.ids) taken.add(id);
  const namespace = pickNamespace([...namespacesOf(taken), ...others.namespaces]);
  const fingerprint = opt(args, "parent-fingerprint");
  const edits = newModEdits({
    modId: need(args, "mod-id"),
    name: need(args, "name"),
    parent: { modId: need(args, "parent"), ...(fingerprint ? { contentFingerprint: fingerprint } : {}) },
    namespace,
  });
  writeEdits(out, edits);
  console.log(`${out}: a derived mod of ${edits.parent.modId}, new ids in namespace ${namespace} (G${namespace}UU0001)`);
  return 0;
}

function printReport(r: MaterializeReport, json: boolean) {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  for (const [file, c] of Object.entries(r.applied)) {
    console.log(`${file}: ${c.deleted} deleted, ${c.set} set, ${c.added} added, ${c.unchanged} already so`);
  }
  for (const c of r.carried) console.log(`${c.archive}: ${c.ops} op(s) carried (the store build does not read it)`);
  for (const c of r.conflicts) console.log(`CONFLICT ${c.file} ${c.reason}: ${c.detail}`);
  if (r.out) console.log(`${r.out}: ${r.linked} files linked, ${r.written.length} written`);
}

function run(args: Args, out: string | undefined) {
  const edits = readEdits(need(args, "edits"));
  const payloadDir = opt(args, "payloads") ?? join(dirname(resolve(need(args, "edits"))), "payloads");
  const report = materialize({
    parentGame: need(args, "parent-game"),
    edits,
    payloadDir,
    ...(out ? { out } : {}),
    ...(args["all-archives"] ? { allArchives: true } : {}),
  });
  printReport(report, !!args.json);
  return report.conflicts.length ? 1 : 0;
}

function diff(args: Args) {
  const parentGame = need(args, "parent-game");
  const childGame = need(args, "child");
  const out = need(args, "edits");
  const parentTables = tablesOf(parentGame, "--parent-game");
  const childTables = tablesOf(childGame, "--child");
  const byLower = (m: Map<string, string>) => new Map([...m].map(([k, v]) => [k.toLowerCase(), { name: k, path: v }]));
  const p = byLower(parentTables);
  const c = byLower(childTables);

  const ops: DbfOp[] = [];
  const keys: Record<string, KeyDecl> = {};
  const report = {
    tables: {} as Record<string, { deleted: number; set: number; added: number }>,
    onlyParent: [] as string[],
    onlyChild: [] as string[],
    newColumns: {} as Record<string, string[]>,
    /** Columns both have with another type: their values are not carried. */
    otherType: {} as Record<string, string[]>,
    skipped: {} as Record<string, number>,
    refused: {} as Record<string, string>,
  };
  for (const [lower, pt] of p) {
    const ct = c.get(lower);
    if (!ct) {
      report.onlyParent.push(pt.name);
      continue;
    }
    const parent = readTable(pt.path, pt.name);
    const child = readTable(ct.path, ct.name);
    const key = registeredKey(pt.name) ?? declareKey(pt.name, parent);
    let d;
    try {
      d = diffTable(pt.name, parent, child, key);
    } catch (e) {
      if (!(e instanceof DiffError)) throw e;
      report.refused[pt.name] = e.message;
      continue;
    }
    if (d.schema.added.length) report.newColumns[pt.name] = d.schema.added.map((f) => f.name);
    const otherType = d.schema.changed.filter((x) => x.from.type !== x.to.type);
    if (otherType.length) report.otherType[pt.name] = otherType.map((x) => `${x.name} (${x.from.type} in the parent, ${x.to.type} in the child)`);
    if (d.skipped.length) report.skipped[pt.name] = d.skipped.length;
    if (!d.ops.length) continue;
    keys[pt.name] = key;
    ops.push(...d.ops);
    report.tables[pt.name] = {
      deleted: d.ops.filter((o) => o.op === "dbf.delete").length,
      set: d.ops.filter((o) => o.op === "dbf.set").length,
      added: d.ops.filter((o) => o.op === "dbf.add").length,
    };
  }
  for (const [lower, ct] of c) if (!p.has(lower)) report.onlyChild.push(ct.name);

  const refused = Object.keys(report.refused).length > 0;
  const fingerprint = opt(args, "parent-fingerprint");
  let edits = newModEdits({
    modId: need(args, "mod-id"),
    name: need(args, "name"),
    parent: { modId: need(args, "parent"), ...(fingerprint ? { contentFingerprint: fingerprint } : {}) },
  });
  edits = pushCommit(edits, ops, { note: `diff of ${resolve(childGame)}`, keys });
  // an edit file without a refused table's changes would read as the whole difference
  if (!refused) writeEdits(out, edits);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const [t, n] of Object.entries(report.tables)) console.log(`${t}: ${n.deleted} deleted, ${n.set} set, ${n.added} added`);
    for (const [t, cols] of Object.entries(report.newColumns)) console.log(`${t}: the child's columns ${cols.join(", ")} are not carried`);
    for (const [t, cols] of Object.entries(report.otherType)) console.log(`${t}: the columns ${cols.join(", ")} are not carried`);
    for (const [t, n] of Object.entries(report.skipped)) console.log(`${t}: ${n} value(s) not carried (the parent's column cannot hold them, or a key cell differs in case)`);
    for (const [t, why] of Object.entries(report.refused)) console.log(`REFUSED ${t}: ${why}`);
    if (report.onlyChild.length) console.log(`only the child has: ${report.onlyChild.join(", ")} (not carried)`);
    if (report.onlyParent.length) console.log(`only the parent has: ${report.onlyParent.join(", ")} (kept)`);
    console.log(refused ? `${out} not written: ${Object.keys(report.refused).length} table(s) refused` : `${out}: ${ops.length} op(s) in ${Object.keys(report.tables).length} table(s)`);
  }
  return refused ? 1 : 0;
}

export function main(argv: string[]): number {
  try {
    const { command, args } = parseArgs(argv);
    switch (command) {
      case "init":
        return init(args);
      case "check":
        return run(args, undefined);
      case "materialize":
        return run(args, need(args, "out"));
      default:
        return diff(args);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

// run when node starts this file, not when a test or node/index.ts imports it
const self = fileURLToPath(import.meta.url).toLowerCase();
const started = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (started === self || `${started}.js` === self) process.exitCode = main(process.argv.slice(2));
