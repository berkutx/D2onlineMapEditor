/**
 * Every table of every mod on this machine (test-helpers/modRoots.ts), Globals, Scens and
 * Interf: it reads and writes back to the same bytes, every cell decodes, every C and N cell
 * encodes back to its own bytes, and setting every cell to the value it reads as changes
 * nothing. Skipped without installs (CI has none).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DbfTable, decodeCell, encodeCell } from "../src/index";
import { filesWithExtension, modFolder, modRoots } from "../../../test-helpers/modRoots";

const TABLES = modRoots().flatMap(({ modId, root }) =>
  ["Globals", "Scens", "Interf"].flatMap((folder) => {
    const dir = modFolder(root, folder);
    return dir ? filesWithExtension(dir, ".dbf").map((path) => ({ modId, folder, path })) : [];
  }),
);

describe.skipIf(TABLES.length === 0)(`the tables of the mods here (${TABLES.length})`, () => {
  it("write back to their own bytes, and every cell survives being encoded and set to its value", () => {
    const failures: string[] = [];
    const cells = { C: 0, N: 0, L: 0, otherL: 0 };
    for (const { modId, folder, path } of TABLES) {
      const label = `${modId}/${folder}/${basename(path)}`;
      // a Node Buffer on purpose: read() must copy it
      const bytes = readFileSync(path);
      try {
        const t = DbfTable.read(bytes, label);
        if (!equal(t.toBytes(), bytes)) failures.push(`${label}: read + write differs`);
        let bad = 0;
        for (let r = 0; r < t.rowCount; r++) {
          for (const f of t.fields) {
            const raw = t.raw(r, f.name);
            const value = decodeCell(f, raw);
            if (f.type === "L") {
              cells.L++;
              if (raw[0] !== 0x54 && raw[0] !== 0x46) cells.otherL++;
              else if (!equal(encodeCell(f, value), raw)) bad++;
            } else {
              cells[f.type === "N" ? "N" : "C"]++;
              if (!equal(encodeCell(f, value), raw)) bad++;
            }
            t.set(r, f.name, value);
          }
        }
        if (bad) failures.push(`${label}: ${bad} cells encode to other bytes`);
        if (t.modified || !equal(t.toBytes(), bytes)) failures.push(`${label}: setting cells to their values changed the table`);
      } catch (e) {
        failures.push(`${label}: ${(e as Error).message}`);
      }
    }
    console.log(`cells: ${JSON.stringify(cells)}`);
    expect(failures).toEqual([]);
    expect(cells.C + cells.N).toBeGreaterThan(0);
  }, 180_000);
});

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
