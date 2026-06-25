/**
 * Camera — pan / cursor-anchored zoom / clamp over a `world` Container, plus a
 * throttled snapshot callback so a host (e.g. a Vue minimap) can react to view
 * changes without a per-frame flood.
 *
 * Touches `pixi.js` (`Container`) -> COMPILE-ONLY under vitest. The transform math
 * is, however, plain arithmetic and could be unit-tested if extracted; it is kept
 * here next to the Container it mutates for clarity.
 *
 * Model: the world Container is positioned in SCREEN space and uniformly scaled by
 * `zoom`. A world-space point `w` maps to screen `s = w * zoom + offset`, where
 * `offset = (world.position.x, world.position.y)`. Zooming about a screen anchor
 * keeps the world point under the cursor fixed by adjusting the offset.
 */
import type { Container } from "pixi.js";
import {
  mapWorldBounds,
  type WorldBounds,
  type WorldPoint,
} from "./iso.js";

/** A throttled view snapshot in WORLD space (what {@link Culler} consumes). */
export interface CameraSnapshot {
  /** world-space x of the screen's top-left */
  x: number;
  /** world-space y of the screen's top-left */
  y: number;
  /** world-space width of the viewport (screenW / zoom) */
  width: number;
  /** world-space height of the viewport (screenH / zoom) */
  height: number;
  zoom: number;
}

export interface CameraOptions {
  minZoom?: number;
  maxZoom?: number;
  /** ms between throttled snapshot callbacks (default ~60ms). */
  snapshotThrottleMs?: number;
  /** extra world px of pan slack beyond the map bounds (default 256). */
  panMargin?: number;
}

export class Camera {
  private readonly world: Container;
  private bounds: WorldBounds;
  private screenW = 1;
  private screenH = 1;

  private zoomValue = 1;
  private readonly minZoom: number;
  private readonly maxZoom: number;
  private readonly panMargin: number;

  private onSnapshot?: (s: CameraSnapshot) => void;
  private readonly throttleMs: number;
  private lastSnapshotAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(world: Container, mapSize: number, options: CameraOptions = {}) {
    this.world = world;
    this.bounds = mapWorldBounds(mapSize);
    this.minZoom = options.minZoom ?? 0.25;
    this.maxZoom = options.maxZoom ?? 4;
    this.panMargin = options.panMargin ?? 256;
    this.throttleMs = options.snapshotThrottleMs ?? 60;
  }

  /** Update the map bounds (call after loading a new map). */
  setMapSize(mapSize: number): void {
    this.bounds = mapWorldBounds(mapSize);
    this.clamp();
  }

  /** Tell the camera the drawing surface size (call on init + resize). */
  setScreenSize(w: number, h: number): void {
    this.screenW = Math.max(1, w);
    this.screenH = Math.max(1, h);
    this.clamp();
    this.emit();
  }

  /** Register the throttled snapshot listener. */
  setSnapshotListener(cb: (s: CameraSnapshot) => void): void {
    this.onSnapshot = cb;
  }

  get zoom(): number {
    return this.zoomValue;
  }

  /** Current world-space top-left offset (screen origin in world units). */
  private screenOriginWorld(): WorldPoint {
    return {
      x: -this.world.position.x / this.zoomValue,
      y: -this.world.position.y / this.zoomValue,
    };
  }

  /** Convert a screen point to world coordinates under the current transform. */
  screenToWorld(sx: number, sy: number): WorldPoint {
    return {
      x: (sx - this.world.position.x) / this.zoomValue,
      y: (sy - this.world.position.y) / this.zoomValue,
    };
  }

  /** Pan by a screen-space delta (e.g. drag deltas). */
  panBy(dxScreen: number, dyScreen: number): void {
    this.world.position.set(
      this.world.position.x + dxScreen,
      this.world.position.y + dyScreen,
    );
    this.clamp();
    this.emit();
  }

  /** Center the view on a world point. */
  centerOn(worldX: number, worldY: number): void {
    this.world.position.set(
      this.screenW / 2 - worldX * this.zoomValue,
      this.screenH / 2 - worldY * this.zoomValue,
    );
    this.clamp();
    this.emit();
  }

  /**
   * Zoom by a multiplicative factor about a screen anchor (cursor position), so
   * the world point under the cursor stays put. `factor > 1` zooms in.
   */
  zoomAt(factor: number, anchorX: number, anchorY: number): void {
    const next = clampNumber(
      this.zoomValue * factor,
      this.minZoom,
      this.maxZoom,
    );
    if (next === this.zoomValue) return;

    // world point currently under the anchor
    const before = this.screenToWorld(anchorX, anchorY);
    this.zoomValue = next;
    this.world.scale.set(next, next);
    // reposition so `before` lands back under the anchor
    this.world.position.set(
      anchorX - before.x * next,
      anchorY - before.y * next,
    );
    this.clamp();
    this.emit();
  }

  /** Fit the whole map into the viewport and center it. */
  fitToScreen(): void {
    const zx = this.screenW / Math.max(1, this.bounds.width);
    const zy = this.screenH / Math.max(1, this.bounds.height);
    this.zoomValue = clampNumber(Math.min(zx, zy), this.minZoom, this.maxZoom);
    this.world.scale.set(this.zoomValue, this.zoomValue);
    const cx = (this.bounds.minX + this.bounds.maxX) / 2;
    const cy = (this.bounds.minY + this.bounds.maxY) / 2;
    this.centerOn(cx, cy);
  }

  /** Clamp the pan offset so the map cannot be dragged completely off-screen. */
  private clamp(): void {
    const z = this.zoomValue;
    const m = this.panMargin;
    // world-space extents in screen px
    const worldLeft = this.bounds.minX * z;
    const worldRight = this.bounds.maxX * z;
    const worldTop = this.bounds.minY * z;
    const worldBottom = this.bounds.maxY * z;

    let px = this.world.position.x;
    let py = this.world.position.y;

    const contentW = worldRight - worldLeft;
    const contentH = worldBottom - worldTop;

    if (contentW <= this.screenW) {
      // center horizontally when the map is narrower than the screen
      px = (this.screenW - (worldLeft + worldRight)) / 2;
    } else {
      const minPx = this.screenW - worldRight - m;
      const maxPx = -worldLeft + m;
      px = clampNumber(px, minPx, maxPx);
    }

    if (contentH <= this.screenH) {
      py = (this.screenH - (worldTop + worldBottom)) / 2;
    } else {
      const minPy = this.screenH - worldBottom - m;
      const maxPy = -worldTop + m;
      py = clampNumber(py, minPy, maxPy);
    }

    this.world.position.set(px, py);
  }

  /** The current view as a world-space snapshot. */
  snapshot(): CameraSnapshot {
    const origin = this.screenOriginWorld();
    return {
      x: origin.x,
      y: origin.y,
      width: this.screenW / this.zoomValue,
      height: this.screenH / this.zoomValue,
      zoom: this.zoomValue,
    };
  }

  /** Throttled emit: at most one callback per `throttleMs`, trailing-edged. */
  private emit(): void {
    if (!this.onSnapshot) return;
    const now = Date.now();
    const since = now - this.lastSnapshotAt;
    if (since >= this.throttleMs) {
      this.lastSnapshotAt = now;
      this.onSnapshot(this.snapshot());
      return;
    }
    if (this.snapshotTimer === null) {
      this.snapshotTimer = setTimeout(() => {
        this.snapshotTimer = null;
        this.lastSnapshotAt = Date.now();
        this.onSnapshot?.(this.snapshot());
      }, this.throttleMs - since);
    }
  }

  destroy(): void {
    if (this.snapshotTimer !== null) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.onSnapshot = undefined;
  }
}

function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
