/**
 * The geometry of a fog veil, free of Pixi (unit-tested): a fog is drawn as horizontal
 * runs of hidden cells — one quad per run, not per cell — so a fully hidden 144×144 map
 * is 144 quads.
 */

/** A `size`×`size` grid, row by row; a non-zero cell is hidden. */
export interface FogVisual {
  size: number;
  hidden: Uint8Array;
}

export interface FogRun {
  y: number;
  /** first hidden cell of the run */
  x0: number;
  /** one past its last hidden cell */
  x1: number;
}

/** The horizontal runs of hidden cells, line by line. */
export function fogRuns(fog: FogVisual): FogRun[] {
  const runs: FogRun[] = [];
  const { size, hidden } = fog;
  for (let y = 0; y < size; y++) {
    let start = -1;
    for (let x = 0; x <= size; x++) {
      const on = x < size && hidden[y * size + x] !== 0;
      if (on && start < 0) start = x;
      else if (!on && start >= 0) {
        runs.push({ y, x0: start, x1: x });
        start = -1;
      }
    }
  }
  return runs;
}
