import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT,
  PIX_ONLY_A,
  PIX_ONLY_B,
  PIX_RECOLOURED,
  PIX_SAME,
  changedShare,
  cropRaster,
  diffRasters,
  fitZoom,
  growBox,
  highlightRaster,
  padRaster,
  sizeChanged,
  type Raster,
} from "../src/mods/pixelDiff";

/** A raster from rows of pixels; a pixel is [r, g, b, a]. */
function raster(rows: number[][][]): Raster {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) => row.forEach((px, x) => data.set(px, (y * width + x) * 4)));
  return { width, height, data };
}
const R = [200, 10, 10, 255];
const G = [10, 200, 10, 255];
const T = [0, 0, 0, 0];
const T2 = [255, 0, 255, 0]; // transparent, another colour underneath

describe("pixels of two pictures", () => {
  it("finds nothing in equal pictures", () => {
    const a = raster([[R, G], [T, R]]);
    const d = diffRasters(a, raster([[R, G], [T, R]]));
    expect(d.changed).toBe(0);
    expect(d.visible).toBe(3);
    expect(d.bbox).toBeNull();
    expect(changedShare(d)).toBe(0);
    expect(sizeChanged(d)).toBe(false);
  });

  it("takes two transparent pixels for equal whatever colour they hide", () => {
    const d = diffRasters(raster([[T, R]]), raster([[T2, R]]));
    expect(d.changed).toBe(0);
    expect(d.visible).toBe(1);
  });

  it("tells a recoloured pixel from an erased and a drawn one, and boxes them", () => {
    const a = raster([
      [R, R, T],
      [R, G, T],
    ]);
    const b = raster([
      [R, G, G],
      [T, G, T],
    ]);
    const d = diffRasters(a, b);
    expect([...d.mask]).toEqual([PIX_SAME, PIX_RECOLOURED, PIX_ONLY_B, PIX_ONLY_A, PIX_SAME, PIX_SAME]);
    expect(d).toMatchObject({ changed: 3, recoloured: 1, onlyA: 1, onlyB: 1, visible: 5 });
    expect(d.bbox).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect(changedShare(d)).toBeCloseTo(3 / 5);
  });

  it("boxes what is visible in either picture, without the transparent margins", () => {
    const a = raster([
      [T, T, T, T],
      [T, R, T, T],
      [T, T, T, T],
    ]);
    const b = raster([
      [T, T, T, T],
      [T, T, G, T],
      [T, T, G, T],
    ]);
    const d = diffRasters(a, b);
    expect(d.content).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    expect(diffRasters(raster([[T]]), raster([[T2]])).content).toBeNull();
  });

  it("counts a change of alpha alone", () => {
    const d = diffRasters(raster([[[1, 2, 3, 255]]]), raster([[[1, 2, 3, 128]]]));
    expect(d.recoloured).toBe(1);
  });

  it("aligns pictures of different sizes at the top-left corner", () => {
    const a = raster([[R]]);
    const b = raster([
      [R, G],
      [T, G],
    ]);
    const d = diffRasters(a, b);
    expect(d.width).toBe(2);
    expect(d.height).toBe(2);
    expect(d.onlyB).toBe(2);
    expect(d.bbox).toEqual({ x: 1, y: 0, w: 1, h: 2 });
    expect(sizeChanged(d)).toBe(true);
    expect(d.sizeA).toEqual([1, 1]);
    expect(d.sizeB).toEqual([2, 2]);
  });

  it("takes every visible pixel of a picture as new when the other side has none", () => {
    const d = diffRasters(null, raster([[R, T]]));
    expect(d.onlyB).toBe(1);
    expect(d.sizeA).toBeNull();
    expect(sizeChanged(d)).toBe(false);
  });
});

describe("the differences picture", () => {
  it("paints differing pixels in their colour and the rest as a faint grey ghost", () => {
    const a = raster([[R, R, T]]);
    const b = raster([[R, G, G]]);
    const d = diffRasters(a, b);
    const h = highlightRaster(d, a, b);
    expect(h.width).toBe(3);
    const px = (x: number) => [...h.data.subarray(x * 4, x * 4 + 4)];
    // pixel 0 is unchanged: grey, faint
    const [r0, g0, b0, a0] = px(0);
    expect(r0).toBe(g0);
    expect(g0).toBe(b0);
    expect(a0).toBeGreaterThan(0);
    expect(a0).toBeLessThan(255);
    expect(px(1)).toEqual([...HIGHLIGHT[PIX_RECOLOURED], 255]);
    expect(px(2)).toEqual([...HIGHLIGHT[PIX_ONLY_B], 255]);
  });

  it("shows A's pixels where B has none", () => {
    const a = raster([[R, R]]);
    const b = raster([[T, R]]);
    const h = highlightRaster(diffRasters(a, b), a, b);
    expect([...h.data.subarray(0, 4)]).toEqual([...HIGHLIGHT[PIX_ONLY_A], 255]);
  });

  it("leaves transparent what both leave transparent", () => {
    const a = raster([[T]]);
    const h = highlightRaster(diffRasters(a, a), a, a);
    expect([...h.data]).toEqual([0, 0, 0, 0]);
  });
});

describe("crops, padding and zoom", () => {
  const r = raster([
    [R, G, R],
    [G, R, G],
  ]);
  it("crops a box and clips it to the picture", () => {
    const c = cropRaster(r, { x: 1, y: 0, w: 5, h: 1 });
    expect(c.width).toBe(2);
    expect(c.height).toBe(1);
    expect([...c.data]).toEqual([...G, ...R]);
  });
  it("pads to a larger size with transparent pixels", () => {
    const p = padRaster(raster([[R]]), 2, 2);
    expect([...p.data]).toEqual([...R, ...T, ...T, ...T]);
    expect(padRaster(r, 3, 2)).toBe(r);
  });
  it("grows a box within the picture", () => {
    expect(growBox({ x: 1, y: 1, w: 1, h: 1 }, 4, 10, 3)).toEqual({ x: 0, y: 0, w: 6, h: 3 });
  });
  it("picks the largest zoom that fits", () => {
    expect(fitZoom(64, 64, 1060, 540, 3)).toBe(4);
    expect(fitZoom(64, 64, 1060, 540, 1)).toBe(8);
    expect(fitZoom(2000, 2000, 1060, 540, 3)).toBe(1);
    expect(fitZoom(10, 10, 1060, 540, 1)).toBe(16);
  });
});
