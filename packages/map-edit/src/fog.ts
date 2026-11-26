/**
 * A player's fog of war as the map file stores it: one MidgardMapFog block per player
 * (PlayerInfo.fogId → satellites.fogs), a bit mask per map line.
 *
 * VERIFIED on the installed maps and saves (240 scenario files, 344 player fogs that are
 * neither empty nor full): a SET bit means the cell is HIDDEN; cell x is bit `x & 7` of byte
 * `x >> 3` (least significant bit first). The game's own editor writes the fog it computes —
 * everything hidden, then opened around the player's cities and parties — and a file nobody
 * computed it for (a generated map) has all zeros.
 *
 * What the game does with it: when a NEW game starts, the game recomputes the fog of every
 * playable race (hides everything, then opens around its own cities and parties) and opens
 * the whole map for the neutral player. A fog drawn here therefore reaches the player only
 * where nothing recomputes it — a saved game, or an engine that chooses to honour it. To open
 * part of the map at the start of the original game, use the event effect «Туман войны в зоне».
 */
import type { MapDocument, FogInfo } from "@d2/map-schema";
import type { EditOp } from "@d2/socket-contract";

/** The fog block of a player, or undefined when the map has none for it. */
export function fogOfPlayer(doc: MapDocument, playerId: string): FogInfo | undefined {
  const fogId = doc.players.find((p) => p.id === playerId)?.fogId;
  if (!fogId) return undefined;
  return doc.satellites?.fogs.find((f) => f.id === fogId);
}

/** Is the cell hidden in this fog? Cells the mask does not cover count as open. */
export function isFogged(fog: FogInfo, x: number, y: number): boolean {
  const row = fog.rows.find((r) => r.y === y);
  if (!row) return false;
  return (((row.mask[x >> 3] ?? 0) >> (x & 7)) & 1) === 1;
}

/** How many cells of a `size`×`size` map this fog hides. */
export function fogHiddenCount(fog: FogInfo, size: number): number {
  let hidden = 0;
  for (const row of fog.rows) {
    if (row.y < 0 || row.y >= size) continue;
    for (let x = 0; x < size; x++) hidden += ((row.mask[x >> 3] ?? 0) >> (x & 7)) & 1;
  }
  return hidden;
}

/** The fog as a flat `size`×`size` array, 1 = hidden (for drawing). */
export function fogGrid(fog: FogInfo, size: number): Uint8Array {
  const grid = new Uint8Array(size * size);
  for (const row of fog.rows) {
    if (row.y < 0 || row.y >= size) continue;
    for (let x = 0; x < size; x++) grid[row.y * size + x] = ((row.mask[x >> 3] ?? 0) >> (x & 7)) & 1;
  }
  return grid;
}

function sameMask(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Hide or open `cells` in a fog: ONE setFog op carrying only the lines that change
 * (an empty list when nothing does). Cells outside the map are ignored.
 */
export function fogPaintOps(
  doc: MapDocument,
  fogId: string,
  cells: Iterable<{ x: number; y: number }>,
  hidden: boolean,
): EditOp[] {
  const fog = doc.satellites?.fogs.find((f) => f.id === fogId);
  if (!fog) return [];
  const touched = new Map<number, number[]>();
  for (const { x, y } of cells) {
    if (x < 0 || y < 0 || x >= doc.size || y >= doc.size) continue;
    let mask = touched.get(y);
    if (!mask) {
      const row = fog.rows.find((r) => r.y === y);
      if (!row) continue;
      mask = row.mask.slice();
      touched.set(y, mask);
    }
    const byte = x >> 3;
    if (byte >= mask.length) continue;
    const bit = 1 << (x & 7);
    mask[byte] = hidden ? mask[byte]! | bit : mask[byte]! & ~bit & 0xff;
  }
  const rows: { y: number; mask: number[] }[] = [];
  for (const [y, mask] of touched) {
    const before = fog.rows.find((r) => r.y === y)!.mask;
    if (!sameMask(before, mask)) rows.push({ y, mask });
  }
  if (rows.length === 0) return [];
  rows.sort((a, b) => a.y - b.y);
  return [{ kind: "setFog", id: fogId, rows }];
}

/** Hide (or open) the whole map in a fog; an empty list when it already is. */
export function fogFillOps(doc: MapDocument, fogId: string, hidden: boolean): EditOp[] {
  const fog = doc.satellites?.fogs.find((f) => f.id === fogId);
  if (!fog) return [];
  const rows: { y: number; mask: number[] }[] = [];
  for (const row of fog.rows) {
    const mask = row.mask.map((_, i) => {
      if (!hidden) return 0;
      const cellsInByte = Math.max(0, Math.min(8, doc.size - i * 8)); // never set bits past the map edge
      return cellsInByte === 8 ? 0xff : (1 << cellsInByte) - 1;
    });
    if (!sameMask(row.mask, mask)) rows.push({ y: row.y, mask });
  }
  return rows.length ? [{ kind: "setFog", id: fogId, rows }] : [];
}

/** The square of side 2·radius+1 around a cell — the shape the game opens around an object. */
export function fogSquare(cx: number, cy: number, radius: number): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let y = cy - radius; y <= cy + radius; y++) for (let x = cx - radius; x <= cx + radius; x++) cells.push({ x, y });
  return cells;
}

/** How a fog stands in the file: nobody set it (every cell open), all hidden, or drawn. */
export type FogState = "unset" | "hidden" | "drawn";

export function fogState(fog: FogInfo, size: number): FogState {
  const hidden = fogHiddenCount(fog, size);
  return hidden === 0 ? "unset" : hidden === size * size ? "hidden" : "drawn";
}

/**
 * Make a fog equal to `grid` (a `size`×`size` array, non-zero = hidden): ONE setFog op with
 * the lines that differ, or an empty list when the fog already is that.
 */
export function fogGridOps(doc: MapDocument, fogId: string, grid: Uint8Array): EditOp[] {
  const fog = doc.satellites?.fogs.find((f) => f.id === fogId);
  if (!fog) return [];
  const size = doc.size;
  const rows: { y: number; mask: number[] }[] = [];
  for (const row of fog.rows) {
    if (row.y < 0 || row.y >= size) continue;
    const mask = new Array<number>(row.mask.length).fill(0);
    for (let x = 0; x < size && x >> 3 < mask.length; x++) if (grid[row.y * size + x]) mask[x >> 3]! |= 1 << (x & 7);
    if (!sameMask(row.mask, mask)) rows.push({ y: row.y, mask });
  }
  if (rows.length === 0) return [];
  rows.sort((a, b) => a.y - b.y);
  return [{ kind: "setFog", id: fogId, rows }];
}

/** Give one player the fog of another (the same cells hidden). */
export function fogCopyOps(doc: MapDocument, fromFogId: string, toFogId: string): EditOp[] {
  const from = doc.satellites?.fogs.find((f) => f.id === fromFogId);
  if (!from || fromFogId === toFogId) return [];
  return fogGridOps(doc, toFogId, fogGrid(from, doc.size));
}

/** Footprint side of what a player can own on the map (a capital is 5×5, a city 4×4). */
const OWNED_SIDE: Record<string, number> = { capital: 5, village: 4, stack: 1, rod: 1 };

/**
 * The fog a player would have if only the surroundings of what it owns were open: everything
 * hidden, then a square with cut corners — the shape the game opens — `radius` cells around
 * each of the player's capitals, cities and parties.
 *
 * This is the map maker's preset, not the game's own computation: the game opens each object
 * by ITS scouting range (a leader's, a city's), which the editor does not know. On the
 * installed maps a capital opens 6 cells around its walls.
 */
export function fogAroundOwnedOps(doc: MapDocument, playerId: string, radius: number): EditOp[] {
  const fog = fogOfPlayer(doc, playerId);
  if (!fog) return [];
  const size = doc.size;
  const grid = new Uint8Array(size * size).fill(1);
  const r = Math.max(0, Math.floor(radius));
  for (const o of doc.objects) {
    const side = OWNED_SIDE[o.type];
    if (!side || (o as { owner?: string }).owner !== playerId) continue;
    const x0 = o.pos.x - r, y0 = o.pos.y - r, x1 = o.pos.x + side - 1 + r, y1 = o.pos.y + side - 1 + r;
    for (let y = Math.max(0, y0); y <= Math.min(size - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(size - 1, x1); x++) {
        const corner = r > 0 && (x === x0 || x === x1) && (y === y0 || y === y1);
        if (!corner) grid[y * size + x] = 0;
      }
    }
  }
  return fogGridOps(doc, fog.id, grid);
}
