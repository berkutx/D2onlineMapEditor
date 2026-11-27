/**
 * A picture change compared pixel by pixel in the browser: both sides are drawn from their
 * sheets (or icon files) onto canvases and read back as RGBA, then handed to pixelDiff.
 *
 * A frame is drawn where it sits in its SOURCE picture (the manifest's trim offset inside
 * sourceW×sourceH), so a picture the packer trimmed differently still lines up. An
 * animation is compared on its first frame that differs between the mods.
 *
 * Results are cached: the full rasters for the last pictures looked at, the small numbers
 * (how many pixels differ) for every picture compared.
 */
import type { PictureChange, PictureSide, SpriteManifest } from "@d2/mod-diff";
import { frameSide, storeUrl } from "./pictures";
import { changedShare, diffRasters, highlightRaster, type Box, type PixelDiff, type Raster } from "./pixelDiff";

/** Where the two sides' pictures come from. */
export interface CompareSources {
  manifestA?: SpriteManifest | null;
  manifestB?: SpriteManifest | null;
  /** URL of the icon file in A / B (icon changes). */
  iconA?: string | null;
  iconB?: string | null;
}

export interface AnimationFrame {
  /** 0-based index of the compared frame. */
  index: number;
  nameA?: string;
  nameB?: string;
  countA: number;
  countB: number;
}

export interface PictureComparison {
  a: Raster | null;
  b: Raster | null;
  diff: PixelDiff;
  highlight: Raster;
  frame?: AnimationFrame;
}

/** The numbers of a comparison, kept for every picture compared. */
export interface PictureStats {
  changed: number;
  visible: number;
  share: number;
  bbox: Box | null;
  sizeA: [number, number] | null;
  sizeB: [number, number] | null;
}

/** What the compare store offers the comparison (kept narrow so this module needs no store). */
export interface SourceStore {
  side(s: "a" | "b"): { manifest?: SpriteManifest | null } | null;
  fileOf(s: "a" | "b", logical: string): string | null;
}

/** The sources of one change from the compare store. */
export function sourcesFor(store: SourceStore, change: PictureChange): CompareSources {
  const icon = change.kind === "icon";
  return {
    manifestA: store.side("a")?.manifest ?? null,
    manifestB: store.side("b")?.manifest ?? null,
    iconA: icon && change.a ? store.fileOf("a", change.name) : null,
    iconB: icon && change.b ? store.fileOf("b", change.name) : null,
  };
}

/** True for a change that can be compared by pixels (a picture on both sides). */
export function comparable(change: PictureChange): boolean {
  return change.change === "changed" && change.kind !== "capital-layer";
}

// ---------------------------------------------------------------- images

const IMAGE_CACHE = 24;
const images = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  const hit = images.get(url);
  if (hit) {
    images.delete(url);
    images.set(url, hit); // most recently used last
    return hit;
  }
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(url));
    img.src = url;
  });
  images.set(url, p);
  p.catch(() => images.delete(url));
  while (images.size > IMAGE_CACHE) images.delete(images.keys().next().value!);
  return p;
}

function readPixels(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): Raster {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2d");
  ctx.imageSmoothingEnabled = false;
  draw(ctx);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: img.data };
}

/** A sheet frame as its source picture: the cropped pixels at their trim offset. */
async function frameRaster(side: PictureSide | null | undefined): Promise<Raster | null> {
  const r = side?.rect;
  if (!side?.image || !r || r.length < 4) return null;
  const [x = 0, y = 0, w = 0, h = 0, tx = 0, ty = 0, sw = 0, sh = 0] = r;
  if (w <= 0 || h <= 0) return null;
  const img = await loadImage(storeUrl(side.image));
  const width = Math.max(sw > 0 ? sw : w, tx + w);
  const height = Math.max(sh > 0 ? sh : h, ty + h);
  return readPixels(width, height, (ctx) => ctx.drawImage(img, x, y, w, h, tx, ty, w, h));
}

async function iconRaster(url: string | null | undefined): Promise<Raster | null> {
  if (!url) return null;
  const img = await loadImage(url);
  return readPixels(img.naturalWidth, img.naturalHeight, (ctx) => ctx.drawImage(img, 0, 0));
}

const sideKey = (s: PictureSide | null): string => (s ? `${s.sha256 ?? s.image}|${(s.rect ?? []).join(",")}` : "");

/** The frames of an animation to compare: the first pair that differs (else the first pair). */
function animationPair(change: PictureChange, src: CompareSources): { a: PictureSide | null; b: PictureSide | null; frame: AnimationFrame } {
  const la = change.a?.frames ?? [];
  const lb = change.b?.frames ?? [];
  const n = Math.max(la.length, lb.length);
  let pick = -1;
  for (let i = 0; i < n && pick < 0; i++) {
    const fa = la[i] !== undefined ? frameSide(src.manifestA, la[i]!) : null;
    const fb = lb[i] !== undefined ? frameSide(src.manifestB, lb[i]!) : null;
    if (fa && fb && sideKey(fa) !== sideKey(fb)) pick = i;
  }
  const i = pick < 0 ? 0 : pick;
  return {
    a: la[i] !== undefined ? frameSide(src.manifestA, la[i]!) : null,
    b: lb[i] !== undefined ? frameSide(src.manifestB, lb[i]!) : null,
    frame: { index: i, nameA: la[i], nameB: lb[i], countA: la.length, countB: lb.length },
  };
}

async function compute(change: PictureChange, src: CompareSources): Promise<PictureComparison> {
  let a: Raster | null;
  let b: Raster | null;
  let frame: AnimationFrame | undefined;
  if (change.kind === "icon") {
    [a, b] = await Promise.all([iconRaster(src.iconA), iconRaster(src.iconB)]);
  } else if (change.kind === "animation") {
    const pair = animationPair(change, src);
    frame = pair.frame;
    [a, b] = await Promise.all([frameRaster(pair.a), frameRaster(pair.b)]);
  } else {
    [a, b] = await Promise.all([frameRaster(change.a), frameRaster(change.b)]);
  }
  const diff = diffRasters(a, b);
  return { a, b, diff, highlight: highlightRaster(diff, a, b), ...(frame ? { frame } : {}) };
}

// ---------------------------------------------------------------- caches and a queue

const FULL_CACHE = 120;
const full = new Map<PictureChange, Promise<PictureComparison>>();
const stats = new WeakMap<PictureChange, PictureStats>();

const PARALLEL = 4;
let active = 0;
const waiting: (() => void)[] = [];

async function queued<T>(job: () => Promise<T>): Promise<T> {
  if (active >= PARALLEL) await new Promise<void>((go) => waiting.push(go));
  active++;
  try {
    return await job();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function statsOf(c: PictureComparison): PictureStats {
  const d = c.diff;
  return { changed: d.changed, visible: d.visible, share: changedShare(d), bbox: d.bbox, sizeA: d.sizeA, sizeB: d.sizeB };
}

/** The full comparison of one picture change (rasters included), cached for the latest ones. */
export function comparePicture(change: PictureChange, src: CompareSources): Promise<PictureComparison> {
  const hit = full.get(change);
  if (hit) {
    full.delete(change);
    full.set(change, hit);
    return hit;
  }
  const p = queued(() => compute(change, src)).then((c) => {
    stats.set(change, statsOf(c));
    return c;
  });
  full.set(change, p);
  p.catch(() => full.delete(change));
  while (full.size > FULL_CACHE) full.delete(full.keys().next().value!);
  return p;
}

/** The numbers of one picture change, computed once and kept (no rasters). */
export async function pictureStats(change: PictureChange, src: CompareSources): Promise<PictureStats> {
  const known = stats.get(change);
  if (known) return known;
  const inFull = full.get(change);
  const c = inFull ? await inFull : await queued(() => compute(change, src));
  const s = statsOf(c);
  stats.set(change, s);
  return s;
}

/** The numbers of a picture change when it was compared already. */
export function knownStats(change: PictureChange): PictureStats | undefined {
  return stats.get(change);
}
