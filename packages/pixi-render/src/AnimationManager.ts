/**
 * AnimationManager — one shared `Ticker` drives every visible `AnimatedSprite`.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 *
 * D2's animation clock is a uniform 42ms/frame (verified in CLAUDE.md). PixiJS
 * advances an AnimatedSprite by `animationSpeed` units of `deltaTime` per tick,
 * where `deltaTime` is normalized to 60fps; so the correct per-sprite speed is
 *   animationSpeed = fps / 60     with fps = 1000 / 42 ≈ 23.81.
 *
 * Rather than let each sprite own a Ticker listener, we register them here and
 * advance them all from ONE callback. AnimatedSprites are created with
 * `autoUpdate = false` by the ObjectLayer (we call `.update(ticker)` ourselves),
 * so enabling/disabling animation is a single ticker start/stop and culling is a
 * cheap `visible` check. A small pool recycles AnimatedSprite shells to avoid
 * per-rebuild allocation churn.
 */
import { Ticker, AnimatedSprite, type Texture } from "pixi.js";

/** D2 uniform frame clock in ms (Contract B `D2_TICK_MS`). */
export const D2_FRAME_MS = 42;
/** Derived sprite speed: fps/60 where fps = 1000 / 42. */
export const D2_ANIMATION_SPEED = 1000 / D2_FRAME_MS / 60;

export interface AnimationManagerOptions {
  /** ms per animation frame (default 42). */
  frameMs?: number;
  /** start ticking immediately (default true). */
  autoStart?: boolean;
}

export class AnimationManager {
  private readonly ticker: Ticker;
  private readonly speed: number;
  private readonly active = new Set<AnimatedSprite>();
  /** Recyclable AnimatedSprite shells (texture list swapped on reuse). */
  private readonly pool: AnimatedSprite[] = [];
  private enabled = true;
  private destroyed = false;

  constructor(options: AnimationManagerOptions = {}) {
    const frameMs = options.frameMs ?? D2_FRAME_MS;
    this.speed = 1000 / frameMs / 60;

    this.ticker = new Ticker();
    this.ticker.autoStart = false;
    this.ticker.add(this.advance, this);

    if (options.autoStart ?? true) {
      this.enabled = true;
      this.ticker.start();
    } else {
      this.enabled = false;
    }
  }

  /** Per-tick: advance only the visible registered sprites. */
  private advance = (ticker: Ticker): void => {
    if (!this.enabled) return;
    for (const sprite of this.active) {
      // Cull: don't burn time updating off-screen sprites. `visible` is toggled
      // by the Camera/Culler integration in Scene.
      if (!sprite.visible) continue;
      sprite.update(ticker);
    }
  };

  /**
   * Acquire an AnimatedSprite for the given frame list, configured at the D2
   * cadence with manual updates. Pulls from the pool when possible.
   */
  acquire(frames: Texture[]): AnimatedSprite {
    let sprite = this.pool.pop();
    if (sprite) {
      sprite.textures = frames;
      sprite.gotoAndStop(0);
    } else {
      // autoUpdate=false: this manager drives updates, not Ticker.shared.
      sprite = new AnimatedSprite(frames, false);
    }
    sprite.animationSpeed = this.speed;
    sprite.loop = true;
    sprite.visible = true;
    sprite.play();
    this.register(sprite);
    return sprite;
  }

  /** Return a sprite to the pool (does NOT destroy it). */
  release(sprite: AnimatedSprite): void {
    this.unregister(sprite);
    sprite.stop();
    sprite.visible = false;
    if (sprite.parent) sprite.parent.removeChild(sprite);
    if (!this.destroyed) this.pool.push(sprite);
  }

  /** Register an externally-created AnimatedSprite to be advanced each tick. */
  register(sprite: AnimatedSprite): void {
    sprite.animationSpeed = this.speed;
    this.active.add(sprite);
  }

  /** Stop advancing a sprite (it is no longer in the active set). */
  unregister(sprite: AnimatedSprite): void {
    this.active.delete(sprite);
  }

  /** Enable/disable all animation with a single ticker start/stop. */
  setEnabled(on: boolean): void {
    if (this.destroyed) return;
    this.enabled = on;
    if (on) {
      if (!this.ticker.started) this.ticker.start();
      for (const s of this.active) s.play();
    } else {
      this.ticker.stop();
      for (const s of this.active) s.stop();
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Number of currently-advanced sprites (for diagnostics/tests via host). */
  get activeCount(): number {
    return this.active.size;
  }

  destroy(): void {
    this.destroyed = true;
    this.ticker.stop();
    this.ticker.destroy();
    for (const s of this.pool) s.destroy();
    this.pool.length = 0;
    this.active.clear();
  }
}
