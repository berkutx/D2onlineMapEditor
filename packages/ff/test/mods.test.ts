/**
 * Every archive of every mod on this machine (test-helpers/modRoots.ts), Imgs and Interf:
 * it writes back to its own bytes, its picture tables encode back to theirs, and an edit
 * leaves every other record as it was. Skipped without installs (CI has none).
 *
 * The archives are about 1.1 GB per mod; those over 64 MB (BatUnits, IsoUnit, …) are read
 * only with D2_FULL=1.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { decodeAnimationBlock, decodeImageBlock, decodeIndex, directorySize, encodeAnimationBlock, encodeImageBlock, encodeIndex, FfArchive, PictureTables } from "../src/index";
import { filesWithExtension, modFolder, modRoots } from "../../../test-helpers/modRoots";

const FULL = process.env.D2_FULL === "1";
const LIMIT = 64 * 1024 * 1024;

const ALL = modRoots().flatMap(({ modId, root }) =>
  ["Imgs", "Interf"].flatMap((folder) => {
    const dir = modFolder(root, folder);
    return dir ? filesWithExtension(dir, ".ff").map((path) => ({ modId, folder, path, size: statSync(path).size })) : [];
  }),
);
const ARCHIVES = FULL ? ALL : ALL.filter((a) => a.size <= LIMIT);
const label = (a: { modId: string; folder: string; path: string }) => `${a.modId}/${a.folder}/${basename(a.path)}`;

function same(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

describe.skipIf(ARCHIVES.length === 0)(`the archives of the mods here (${ARCHIVES.length} of ${ALL.length}${FULL ? "" : ", D2_FULL=1 for all"})`, () => {
  it("write back to their own bytes, picture tables included", () => {
    const failures: string[] = [];
    for (const a of ARCHIVES) {
      const bytes = new Uint8Array(readFileSync(a.path));
      try {
        const archive = FfArchive.read(bytes, label(a));
        if (!same(archive.toBytes(), bytes)) failures.push(`${label(a)}: read + write differs`);
        const tables = PictureTables.of(archive);
        if (!tables) continue;
        if (!tables.sorted) failures.push(`${label(a)}: -INDEX.OPT is not in byte order`);
        const indexBytes = archive.get(archive.idByName("-INDEX.OPT")!)!;
        if (!same(encodeIndex(decodeIndex(indexBytes)), indexBytes)) failures.push(`${label(a)}: -INDEX.OPT differs`);
        const seen = new Set<string>();
        for (const e of tables.entries) {
          const key = `${e.uid === -1 ? "a" : "i"}:${e.offset}:${e.size}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const block = tables.blockBytes(e);
          const back = e.uid === -1 ? encodeAnimationBlock(decodeAnimationBlock(block)) : encodeImageBlock(decodeImageBlock(block));
          if (!same(back, block)) failures.push(`${label(a)}: the block of ${e.name} differs`);
        }
      } catch (e) {
        failures.push(`${label(a)}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);

  it("an edit leaves every other record as it was", () => {
    const small = ARCHIVES.filter((a) => a.size < 8 * 1024 * 1024).slice(0, 6);
    for (const a of small) {
      const before = FfArchive.read(new Uint8Array(readFileSync(a.path)), label(a));
      const ids = before.ids();
      const victim = ids.find((id) => id > 2)!;
      const edited = FfArchive.read(before.toBytes(), label(a));
      const added = edited.nextId();
      edited.put(added, Uint8Array.of(1, 2, 3));
      edited.setName(added, "ADDED.PNG");
      edited.put(victim, new Uint8Array(edited.get(victim)!.length + 17).fill(0xab));
      const out = edited.toBytes();
      const after = FfArchive.read(out, label(a));
      // the rebuilt directory has the game's size for its live and free entries
      const dirAt = new DataView(out.buffer, out.byteOffset).getInt32(24, true);
      const dv = new DataView(out.buffer, out.byteOffset);
      const live = dv.getInt32(dirAt, true);
      const free = dv.getInt32(dirAt + 4 + live * 16, true);
      expect(live).toBe(ids.length + 2);
      expect(free).toBe(before.records().filter((r) => !r.live).length);
      expect(dv.getInt32(dirAt - 28 + 16, true)).toBe(directorySize(live + free));
      expect(after.ids()).toEqual([...ids, added]);
      expect(after.idByName("added.png")).toBe(added);
      expect(after.get(victim)!.length).toBe(before.get(victim)!.length + 17);
      for (const id of ids) if (id !== victim && id !== 2) expect(same(after.get(id)!, before.get(id)!)).toBe(true);
    }
  }, 120_000);
});
