/**
 * Global game-data references of a scenario.
 *
 * A map points into the game's Globals tables by 10-char ids — `G000UU0001` (a unit),
 * `G000IG0006` (an item), `G201UM9378` (a modifier)… — and those tables differ from mod to
 * mod. Which ids a map uses is therefore the one reliable trace of the mod it was made for
 * (a `.sg` carries no mod marker), and the list of ids a mod does NOT define is exactly why
 * the game refuses a map built for another mod.
 *
 * The scan works on the raw bytes, independent of the block parser: it must also work for
 * maps (and block types) the parser does not model.
 */

/** Global ids referenced by a map: table code (`UU`, `IG`, …) → sorted UPPERCASE ids. */
export type GlobalIdRefs = Record<string, string[]>;

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/**
 * Collect every global id the scenario bytes reference, grouped by table code.
 *
 * An id field is stored as a length-prefixed string: `0B 00 00 00` + 10 chars + NUL (the
 * same framing {@link verifyBlockIntegrity} scans for the map's own block ids). A global id
 * is `G` + 3 digits (the data-set prefix: `000` base game, other values for mod packs) +
 * a 2-letter table code + 4 alphanumerics. The all-zero "no object" id `G000000000` has no
 * table code and is not collected. Ids are normalised to UPPERCASE (the Globals tables are
 * matched case-insensitively by the game).
 */
export function collectGlobalIds(bytes: Uint8Array): GlobalIdRefs {
  const sets = new Map<string, Set<string>>();
  const end = bytes.length - 15;
  for (let i = 0; i <= end; i++) {
    if (bytes[i] !== 0x0b || bytes[i + 1] !== 0 || bytes[i + 2] !== 0 || bytes[i + 3] !== 0) continue;
    if (bytes[i + 14] !== 0) continue; // trailing NUL of the 10-char id
    const g = bytes[i + 4]!;
    if (g !== 0x47 && g !== 0x67) continue; // 'G' / 'g'
    if (!isDigit(bytes[i + 5]!) || !isDigit(bytes[i + 6]!) || !isDigit(bytes[i + 7]!)) continue;
    if (!isLetter(bytes[i + 8]!) || !isLetter(bytes[i + 9]!)) continue;
    let ok = true;
    for (let k = 10; k < 14; k++) {
      const c = bytes[i + k]!;
      if (!isDigit(c) && !isLetter(c)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let id = "";
    for (let k = 4; k < 14; k++) id += String.fromCharCode(bytes[i + k]!);
    id = id.toUpperCase();
    const table = id.slice(4, 6);
    let set = sets.get(table);
    if (!set) sets.set(table, (set = new Set()));
    set.add(id);
    i += 14; // skip past this id (the next field starts after its NUL)
  }
  const out: GlobalIdRefs = {};
  for (const table of [...sets.keys()].sort()) out[table] = [...sets.get(table)!].sort();
  return out;
}

/**
 * Global ids quoted inside SCRIPT TEXT embedded in the scenario — e.g. the Lua a generated
 * map carries: `[Id.new('g000uu0019').value] = { 'g070um0218', … }`. They are not id fields
 * (the game does not check them when it loads the map), but the script fails at run time
 * if the mod does not define them, so they are part of what a map needs from its mod.
 *
 * Matches a single- or double-quoted 10-char global id; grouped and normalised exactly like
 * {@link collectGlobalIds}. The two results are disjoint in framing (a quoted id is never
 * preceded by the binary length prefix), not necessarily in content.
 */
export function collectScriptGlobalIds(bytes: Uint8Array): GlobalIdRefs {
  const sets = new Map<string, Set<string>>();
  const end = bytes.length - 12;
  for (let i = 0; i <= end; i++) {
    const q = bytes[i]!;
    if (q !== 0x27 && q !== 0x22) continue; // ' or "
    if (bytes[i + 11] !== q) continue; // matching closing quote right after 10 chars
    const g = bytes[i + 1]!;
    if (g !== 0x47 && g !== 0x67) continue;
    if (!isDigit(bytes[i + 2]!) || !isDigit(bytes[i + 3]!) || !isDigit(bytes[i + 4]!)) continue;
    if (!isLetter(bytes[i + 5]!) || !isLetter(bytes[i + 6]!)) continue;
    let ok = true;
    for (let k = 7; k < 11; k++) {
      const c = bytes[i + k]!;
      if (!isDigit(c) && !isLetter(c)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let id = "";
    for (let k = 1; k < 11; k++) id += String.fromCharCode(bytes[i + k]!);
    id = id.toUpperCase();
    const table = id.slice(4, 6);
    let set = sets.get(table);
    if (!set) sets.set(table, (set = new Set()));
    set.add(id);
    i += 11;
  }
  const out: GlobalIdRefs = {};
  for (const table of [...sets.keys()].sort()) out[table] = [...sets.get(table)!].sort();
  return out;
}

/** Total number of distinct ids in a {@link GlobalIdRefs}. */
export function countGlobalIds(refs: GlobalIdRefs): number {
  let n = 0;
  for (const ids of Object.values(refs)) n += ids.length;
  return n;
}
