/**
 * The row keys and the table diff on the mods of this machine (test-helpers/modRoots.ts):
 * every registered key names one live row in every mod that has the table; a table's diff
 * with itself is empty; and the diff from semga to semga-2, applied to semga, gives
 * semga-2's live rows over the columns both have. Skipped without installs (CI has none).
 */
import { describe, it, expect } from "vitest";
import { basename } from "node:path";
import { DbfTable, type DbfValue } from "@d2/dbf";
import { applyTableEdits, declareKey, diffTable, DiffError, duplicateKeys, foldEdits, indexLiveRows, keyString, missingKeyColumns, registeredKey, rowKeyOf } from "../src/index";
import { readTable, tableFiles } from "../src/node/index";
import { modRoots } from "../../../test-helpers/modRoots";

const MODS = modRoots();
const byId = (id: string) => MODS.find((m) => m.modId === id);

describe.skipIf(MODS.length === 0)(`row keys on the mods here (${MODS.map((m) => m.modId).join(", ")})`, () => {
  it("name one live row each, and every other table gets a key", () => {
    const failures: string[] = [];
    let keyed = 0;
    for (const { modId, root } of MODS) {
      for (const [name, path] of tableFiles(root)) {
        const t = readTable(path, `${modId}/${basename(path)}`);
        const key = registeredKey(name);
        if (!key) {
          declareKey(name, t);
          continue;
        }
        keyed++;
        const missing = missingKeyColumns(t, key);
        if (missing.length) failures.push(`${modId}/${name}: no column ${missing.join(", ")}`);
        else if (duplicateKeys(t, key).length) failures.push(`${modId}/${name}: ${duplicateKeys(t, key).length} keys name two live rows`);
      }
    }
    console.log(`${keyed} keyed tables checked`);
    expect(failures).toEqual([]);
  }, 180_000);
});

const PAIR = byId("semga") && byId("semga-2") ? { parent: byId("semga")!, child: byId("semga-2")! } : undefined;

describe.skipIf(!PAIR)("the diff from semga to semga-2", () => {
  it("is empty for a table and itself, and applied to semga gives semga-2", () => {
    const parents = tableFiles(PAIR!.parent.root);
    const children = new Map([...tableFiles(PAIR!.child.root)].map(([n, p]) => [n.toLowerCase(), p]));
    const failures: string[] = [];
    const counts = { tables: 0, ops: 0, skipped: 0, refused: [] as string[] };
    for (const [name, path] of parents) {
      const childPath = children.get(name.toLowerCase());
      if (!childPath) continue;
      const parent = readTable(path, `semga/${name}`);
      const child = readTable(childPath, `semga-2/${name}`);
      const key = registeredKey(name) ?? declareKey(name, parent);
      if (diffTable(name, parent, parent, key).ops.length) failures.push(`${name}: the diff with itself is not empty`);
      let d;
      try {
        d = diffTable(name, parent, child, key);
      } catch (e) {
        if (!(e instanceof DiffError)) throw e;
        if (key.kind !== "row") failures.push(`${name}: ${e.message}`);
        counts.refused.push(name);
        continue;
      }
      counts.tables++;
      counts.ops += d.ops.length;
      counts.skipped += d.skipped.length;
      if (!d.ops.length) continue;
      const applied = DbfTable.read(parent.toBytes(), name);
      const res = applyTableEdits(applied, foldEdits(d.ops, { tables: { [name]: key } }).tables[name.toLowerCase()]!);
      if (res.conflicts.length) {
        failures.push(`${name}: ${res.conflicts.length} conflicts, e.g. ${res.conflicts[0]!.detail}`);
        continue;
      }
      const after = DbfTable.read(applied.toBytes(), name);
      const skipped = new Set(d.skipped.map((s) => `${keyString(s.key)}|${s.field.toLowerCase()}`));
      const common = parent.fields.filter((f) => child.field(f.name)?.type === f.type).map((f) => f.name);
      const a = indexLiveRows(after, key);
      const c = indexLiveRows(child, key);
      const missingKeys = [...c.keys()].filter((k) => !a.has(k) && !d.skipped.some((s) => keyString(s.key) === k));
      const extraKeys = [...a.keys()].filter((k) => !c.has(k));
      if (missingKeys.length || extraKeys.length) failures.push(`${name}: ${missingKeys.length} rows missing, ${extraKeys.length} extra`);
      let differ = 0;
      for (const [k, cr] of c) {
        const ar = a.get(k);
        if (ar === undefined) continue;
        for (const f of common) {
          if (skipped.has(`${k}|${f.toLowerCase()}`)) continue;
          const av: DbfValue = after.get(ar, f);
          const cv: DbfValue = child.get(cr, f);
          if (av !== cv) differ++;
        }
      }
      if (differ) failures.push(`${name}: ${differ} cells differ after applying`);
      // rows the diff did not touch keep their place
      const firstKey = (t: DbfTable) => keyString(rowKeyOf(t, 0, key));
      if (parent.rowCount && after.rowCount && firstKey(after) !== firstKey(parent)) failures.push(`${name}: the first row moved`);
    }
    console.log(`semga → semga-2: ${counts.tables} tables, ${counts.ops} ops, ${counts.skipped} values not carried, refused: ${counts.refused.join(", ") || "none"}`);
    expect(failures).toEqual([]);
  }, 300_000);
});
