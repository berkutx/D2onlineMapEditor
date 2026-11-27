/**
 * Two pictures compared pixel by pixel — pure functions over RGBA rasters, no DOM, so they
 * run in tests as they are. The pictures are aligned at their top-left corner over the
 * union of their sizes; a pixel one of them does not cover is transparent there.
 *
 * Each pixel of the union falls in one of four classes:
 *  - same: both transparent, or both the same colour and alpha;
 *  - recoloured: visible in both, with another colour or alpha;
 *  - only in A: visible in A, transparent (or outside) in B — the mod erased it;
 *  - only in B: transparent (or outside) in A, visible in B — the mod drew it.
 */

/** An RGBA picture, four bytes a pixel, row after row (the layout of canvas ImageData). */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PIX_SAME = 0;
export const PIX_RECOLOURED = 1;
export const PIX_ONLY_A = 2;
export const PIX_ONLY_B = 3;

export interface PixelDiff {
  /** The union of the two sizes. */
  width: number;
  height: number;
  /** One PIX_* class a pixel of the union. */
  mask: Uint8Array;
  /** Every differing pixel: recoloured + only in A + only in B. */
  changed: number;
  recoloured: number;
  onlyA: number;
  onlyB: number;
  /** Pixels visible in A or in B — what the share of changed pixels is counted against. */
  visible: number;
  /** The smallest box holding every differing pixel; null when none differs. */
  bbox: Box | null;
  /** The smallest box holding every pixel visible in A or B; null when both are empty. */
  content: Box | null;
  sizeA: [number, number] | null;
  sizeB: [number, number] | null;
}

/** Compare two pictures (either may be missing: then every visible pixel of the other differs). */
export function diffRasters(a: Raster | null, b: Raster | null): PixelDiff {
  const width = Math.max(a?.width ?? 0, b?.width ?? 0);
  const height = Math.max(a?.height ?? 0, b?.height ?? 0);
  const mask = new Uint8Array(width * height);
  let recoloured = 0;
  let onlyA = 0;
  let onlyB = 0;
  let visible = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let cx0 = width;
  let cy0 = height;
  let cx1 = -1;
  let cy1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ia = a && x < a.width && y < a.height ? (y * a.width + x) * 4 : -1;
      const ib = b && x < b.width && y < b.height ? (y * b.width + x) * 4 : -1;
      const alphaA = ia >= 0 ? a!.data[ia + 3]! : 0;
      const alphaB = ib >= 0 ? b!.data[ib + 3]! : 0;
      if (alphaA === 0 && alphaB === 0) continue;
      visible++;
      if (x < cx0) cx0 = x;
      if (y < cy0) cy0 = y;
      if (x > cx1) cx1 = x;
      if (y > cy1) cy1 = y;
      let cls = PIX_SAME;
      if (alphaB === 0) cls = PIX_ONLY_A;
      else if (alphaA === 0) cls = PIX_ONLY_B;
      else {
        const da = a!.data;
        const db = b!.data;
        if (alphaA !== alphaB || da[ia] !== db[ib] || da[ia + 1] !== db[ib + 1] || da[ia + 2] !== db[ib + 2]) cls = PIX_RECOLOURED;
      }
      if (cls === PIX_SAME) continue;
      mask[y * width + x] = cls;
      if (cls === PIX_RECOLOURED) recoloured++;
      else if (cls === PIX_ONLY_A) onlyA++;
      else onlyB++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return {
    width,
    height,
    mask,
    changed: recoloured + onlyA + onlyB,
    recoloured,
    onlyA,
    onlyB,
    visible,
    bbox: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
    content: cx1 < 0 ? null : { x: cx0, y: cy0, w: cx1 - cx0 + 1, h: cy1 - cy0 + 1 },
    sizeA: a ? [a.width, a.height] : null,
    sizeB: b ? [b.width, b.height] : null,
  };
}

/** True when the two pictures differ in size. */
export function sizeChanged(d: PixelDiff): boolean {
  return !!d.sizeA && !!d.sizeB && (d.sizeA[0] !== d.sizeB[0] || d.sizeA[1] !== d.sizeB[1]);
}

/** Highlight colours, RGB: recoloured (the «changed» orange), erased (red), drawn (green). */
export const HIGHLIGHT: Record<1 | 2 | 3, [number, number, number]> = {
  [PIX_RECOLOURED]: [255, 140, 0],
  [PIX_ONLY_A]: [239, 68, 68],
  [PIX_ONLY_B]: [34, 197, 94],
};

/**
 * The «differences» picture: B (where B has nothing, A) as a faint grey ghost, every differing
 * pixel in its class colour at full strength.
 */
export function highlightRaster(d: PixelDiff, a: Raster | null, b: Raster | null): Raster {
  const { width, height, mask } = d;
  const data = new Uint8ClampedArray(width * height * 4);
  const pick = (r: Raster | null, x: number, y: number): number => (r && x < r.width && y < r.height && r.data[(y * r.width + x) * 4 + 3]! > 0 ? (y * r.width + x) * 4 : -1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const cls = mask[y * width + x]!;
      if (cls !== PIX_SAME) {
        const c = HIGHLIGHT[cls as 1 | 2 | 3];
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
        data[o + 3] = 255;
        continue;
      }
      let src: Raster | null = b;
      let i = pick(b, x, y);
      if (i < 0) {
        src = a;
        i = pick(a, x, y);
      }
      if (i < 0 || !src) continue;
      const s = src.data;
      const lum = 0.299 * s[i]! + 0.587 * s[i + 1]! + 0.114 * s[i + 2]!;
      const grey = Math.round(128 + (lum - 128) * 0.45);
      data[o] = grey;
      data[o + 1] = grey;
      data[o + 2] = grey;
      data[o + 3] = Math.round(s[i + 3]! * 0.45);
    }
  }
  return { width, height, data };
}

/** A part of a raster; the box is clipped to it. */
export function cropRaster(r: Raster, box: Box): Raster {
  const x0 = Math.max(0, Math.min(r.width, box.x));
  const y0 = Math.max(0, Math.min(r.height, box.y));
  const w = Math.max(0, Math.min(r.width, box.x + box.w) - x0);
  const h = Math.max(0, Math.min(r.height, box.y + box.h) - y0);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * r.width + x0) * 4;
    data.set(r.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

/** A raster grown to `width`×`height` with transparent pixels (right and bottom). */
export function padRaster(r: Raster, width: number, height: number): Raster {
  if (r.width === width && r.height === height) return r;
  const data = new Uint8ClampedArray(width * height * 4);
  const w = Math.min(r.width, width);
  for (let y = 0; y < Math.min(r.height, height); y++) {
    data.set(r.data.subarray(y * r.width * 4, (y * r.width + w) * 4), y * width * 4);
  }
  return { width, height, data };
}

/** A box grown by `margin` on every side and clipped to `width`×`height`. */
export function growBox(box: Box, margin: number, width: number, height: number): Box {
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  return { x, y, w: Math.min(width, box.x + box.w + margin) - x, h: Math.min(height, box.y + box.h + margin) - y };
}

/** The largest of `steps` at which `count` pictures `w`×`h` side by side fit in `maxW`×`maxH`. */
export function fitZoom(w: number, h: number, maxW: number, maxH: number, count = 1, steps: readonly number[] = [1, 2, 4, 8, 16]): number {
  let best = steps[0] ?? 1;
  for (const s of steps) if (w * s * count <= maxW && h * s <= maxH) best = s;
  return best;
}

/** Share of the visible pixels that differ, 0..1 (0 when nothing is visible). */
export function changedShare(d: PixelDiff): number {
  return d.visible ? d.changed / d.visible : 0;
}
