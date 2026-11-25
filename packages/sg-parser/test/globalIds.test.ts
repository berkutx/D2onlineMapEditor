/**
 * collectGlobalIds / collectScriptGlobalIds — the byte-level scan for the Globals ids a map
 * references (the input of mod detection). Synthetic buffers pin the framing rules; the
 * real-map block (skipped without a game install) checks that the two scans together miss
 * nothing a loose regex over the whole file would find.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { collectGlobalIds, collectScriptGlobalIds, countGlobalIds } from "../src/index";

const enc = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
/** A length-prefixed id field as the game writes it: 0B 00 00 00 + 10 chars + NUL. */
const idField = (id: string): number[] => [0x0b, 0, 0, 0, ...enc(id), 0];
const bytesOf = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? enc(p) : p)));

describe("collectGlobalIds", () => {
  it("collects framed global ids grouped by table code, sorted, deduplicated", () => {
    const refs = collectGlobalIds(
      bytesOf(
        "TYPE", idField("G000UU0002"),
        "TYPE", idField("G000UU0001"),
        "TYPE", idField("G000UU0001"),
        "ITEM", idField("G001IG0800"),
        "MODIF", idField("G201UM9378"),
      ),
    );
    expect(refs).toEqual({
      IG: ["G001IG0800"],
      UM: ["G201UM9378"],
      UU: ["G000UU0001", "G000UU0002"],
    });
    expect(countGlobalIds(refs)).toBe(4);
  });

  it("normalises case", () => {
    expect(collectGlobalIds(bytesOf(idField("g000uu0090"), idField("G000Uu0090")))).toEqual({
      UU: ["G000UU0090"],
    });
  });

  it("ignores the nil id, the map's own block ids and unframed text", () => {
    const refs = collectGlobalIds(
      bytesOf(
        idField("G000000000"), // "no object" sentinel: no table code
        idField("S143KC0001"), // a block of this map, not a global
        "see G000UU7777 in the briefing", // plain text, no length prefix
        [0x0b, 0, 0, 0], "G000UU8888X", // 10 chars but no NUL terminator
        [0x0b, 0, 0, 0], "G00XUU8888", [0], // not 3 digits after G
      ),
    );
    expect(refs).toEqual({});
  });

  it("handles ids at the very start and the very end of the buffer", () => {
    expect(collectGlobalIds(bytesOf(idField("G000SS0001")))).toEqual({ SS: ["G000SS0001"] });
    expect(collectGlobalIds(new Uint8Array(0))).toEqual({});
    expect(collectGlobalIds(new Uint8Array([0x0b, 0, 0, 0, 0x47]))).toEqual({});
  });

  it("finds back-to-back id fields", () => {
    const refs = collectGlobalIds(bytesOf(idField("G000MG0001"), idField("G000MG0002"), idField("G000MG0003")));
    expect(refs).toEqual({ MG: ["G000MG0001", "G000MG0002", "G000MG0003"] });
  });
});

describe("collectScriptGlobalIds", () => {
  it("collects quoted ids from embedded script text only", () => {
    const refs = collectScriptGlobalIds(
      bytesOf(
        "[Id.new('g000uu0019').value] = { 'g070um0218', \"G070UM0150\" }",
        " -- g070um9999 in a comment, unquoted",
        idField("G000IG0006"), // a data field, not script text
      ),
    );
    expect(refs).toEqual({ UM: ["G070UM0150", "G070UM0218"], UU: ["G000UU0019"] });
  });

  it("requires matching quotes right around the 10 characters", () => {
    expect(collectScriptGlobalIds(bytesOf("'g000uu0019\"", " 'g000uu00199' ", "'g000uu001'"))).toEqual({});
  });
});

// --- real maps (the configured game install) ---------------------------------------------
function configuredGameDir(): string | null {
  const env = process.env.D2_GAME_DIR?.trim();
  if (env) return env;
  try {
    const line = readFileSync(join(__dirname, "..", "..", "..", "game-dir.local"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    return line ?? null;
  } catch {
    return null;
  }
}
const game = configuredGameDir();
const riders = game ? join(game, "Game", "Campaign", "The Power of Eldunari-v1-2 maps", "Riders.sg") : "";
const exportsDir = game ? join(game, "Game", "Exports") : "";

describe.skipIf(!riders || !existsSync(riders))("global ids of real maps", () => {
  it("Riders references units, items, spells, landmarks, lords and races", () => {
    const refs = collectGlobalIds(new Uint8Array(readFileSync(riders)));
    for (const table of ["UU", "IG", "SS", "MG", "LR", "RR"]) {
      expect(refs[table]?.length ?? 0, `table ${table}`).toBeGreaterThan(0);
    }
    for (const ids of Object.values(refs)) {
      for (const id of ids) expect(id).toMatch(/^G\d{3}[A-Z]{2}[0-9A-Z]{4}$/);
    }
  });

  it("field scan + script scan together cover every id a loose regex finds", () => {
    const files = [riders];
    if (existsSync(exportsDir)) {
      for (const n of readdirSync(exportsDir)) if (n.toLowerCase().endsWith(".sg")) files.push(join(exportsDir, n));
    }
    for (const file of files) {
      const bytes = new Uint8Array(readFileSync(file));
      const found = new Set([
        ...Object.values(collectGlobalIds(bytes)).flat(),
        ...Object.values(collectScriptGlobalIds(bytes)).flat(),
      ]);
      const loose = new Set<string>();
      for (const m of Buffer.from(bytes).toString("latin1").matchAll(/G\d{3}[A-Za-z]{2}[0-9A-Za-z]{4}/gi)) {
        loose.add(m[0].toUpperCase());
      }
      const missed = [...loose].filter((id) => !found.has(id));
      expect(missed, file).toEqual([]);
    }
  });
});
