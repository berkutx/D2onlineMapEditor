/**
 * Terrain grid assembly: unpack MidgardMapBlock chunks into a row-major cell array.
 *
 * VERIFIED (CLAUDE.md / spikes):
 *  - Each MidgardMapBlock carries BLOCKDATA = int32 byteLen (128) + 32 int32 cells.
 *  - A chunk is 8 cols x 4 rows = 32 cells, row-major within the chunk.
 *  - Chunk origin comes from the block uid low word: the compound id's 4-hex index;
 *    bx = index & 0xFF, by = (index >> 8) & 0xFF, and the real cell origin is
 *    (bx, by) measured in cells (bx is a multiple of 8, by a multiple of 4).
 *  - Cell bit layout: terrain = v & 7, ground = (v >> 3) & 7 (water == 3),
 *    forest = v >>> 26.
 *  - roadType / roadVar default to -1 and are applied later from MidRoad blocks.
 */

import type { MapCell } from "@d2/map-schema";

export const CHUNK_COLS = 8;
export const CHUNK_ROWS = 4;
export const CHUNK_CELLS = CHUNK_COLS * CHUNK_ROWS;

/** One decoded terrain block: its origin (in cells) and 32 raw int32 cell values. */
export interface TerrainBlock {
  bx: number;
  by: number;
  values: number[]; // length 32, row-major within the 8x4 chunk
}

/** Decode the bit-packed fields of a single raw cell int32. */
export function decodeCell(value: number, x: number, y: number): MapCell {
  const terrain = value & 7;
  const ground = (value >> 3) & 7;
  const forest = value >>> 26;
  return {
    x,
    y,
    value,
    terrain,
    ground,
    isWater: ground === 3,
    forest,
    roadType: -1,
    roadVar: -1,
  };
}

/**
 * Build a row-major terrain grid of `size*size` cells from decoded blocks.
 * Cells not covered by any block default to value 0 (neutral land).
 * Index = y * size + x.
 */
export function buildGrid(size: number, blocks: TerrainBlock[]): MapCell[] {
  const cells: MapCell[] = new Array(size * size);
  // initialise every cell so the array is dense and schema-valid
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      cells[y * size + x] = decodeCell(0, x, y);
    }
  }
  for (const block of blocks) {
    for (let i = 0; i < block.values.length; i++) {
      const lx = i % CHUNK_COLS;
      const ly = Math.floor(i / CHUNK_COLS);
      const x = block.bx + lx;
      const y = block.by + ly;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      cells[y * size + x] = decodeCell(block.values[i]!, x, y);
    }
  }
  return cells;
}
