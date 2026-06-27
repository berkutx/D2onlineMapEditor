/**
 * Scene — the framework-agnostic entry point that wires the PixiJS application,
 * the world camera, and the terrain / object / animation layers together.
 *
 * Touches `pixi.js` heavily -> COMPILE-ONLY under vitest; a browser host drives it:
 *
 * ```ts
 * const scene = new Scene();
 * await scene.init(document.getElementById("stage")!);
 * const assets = new AssetStore({ baseUrl: "/assets" });
 * await assets.load(manifest);
 * await scene.buildScene(mapDoc, manifest, assets);
 * scene.setAnimationEnabled(true);
 * // ... later
 * scene.destroy();
 * ```
 *
 * Layer order (back to front): terrain tilemap, then the z-sorted object layer.
 * Both live under a single `world` Container that the {@link Camera} pans/zooms.
 */
import { Application, Container } from "pixi.js";
import type { MapDocument } from "@d2/map-schema";
import type { AssetManifest } from "@d2/asset-manifest";

import { AssetStore } from "./AssetStore.js";
import { TerrainTilemapLayer } from "./TerrainTilemapLayer.js";
import { GridLayer } from "./GridLayer.js";
import { ObjectLayer } from "./ObjectLayer.js";
import { LocationLayer } from "./LocationLayer.js";
import { OverlayLayer, type OverlayTint, type CellRef } from "./OverlayLayer.js";
import type { LandmarkFootprints } from "./objectSprite.js";
import { AnimationManager } from "./AnimationManager.js";
import { Camera, type CameraSnapshot } from "./Camera.js";

/** Extra game-data tables the renderer needs for placement (objectdata.json). */
export interface ObjectData {
  landmarkFootprints?: LandmarkFootprints;
  /** Grace race index -> 2-letter fort code (Grace.RACE_TYPE -> Lrace), for
   *  capital/village sprites. The object's `race` is the OWNER player's Grace index. */
  graceFortCodes?: Record<number, string>;
  /** Grace race index -> Lrace key (RACE_TYPE int), for the rod sprite. */
  graceRaceType?: Record<number, number>;
  /** Lterrain id -> 2-letter terrain code (forest/tree sprite key). */
  terrainCodes?: Record<number, string>;
  /** leader impl id -> boat race (Lrace key); only boat-eligible leaders (not
   *  water_only, not flying). Drives the stack-on-water boat sprite. */
  unitBoat?: Record<string, number>;
  /** UPPER landmark ids flagged GLmark.mountain (terraforming overlay). */
  landmarkMountain?: string[];
  /** GVars.GU_RANGE: guard overlay radius source ((gu_range-1)/2). */
  guardRange?: number;
}

/** Live performance / engine numbers for the debug HUD. */
export interface DebugStats {
  /** Renders in the last second (0 when idle — rendering is on-demand). */
  fps: number;
  /** CPU time to ISSUE the last frame's draw calls (ms). */
  cpuMs: number;
  /** GPU-synced frame time, sampled ~1×/s via gl.finish (ms), null until sampled. */
  gpuMs: number | null;
  /** World zoom (renderer = world.scale). */
  zoom: number;
  /** World container offset (px). */
  world: { x: number; y: number };
  /** Drawn object sprites + how many are animating. */
  objects: number;
  animActive: number;
  /** Backbuffer + screen + density. */
  screen: { w: number; h: number };
  drawingBuffer: { w: number; h: number };
  resolution: number;
  dpr: number;
  /** Static GPU caps (cached). */
  gpu: string;
  maxTexture: number;
  rendererType: string;
  /** Estimated GPU texture memory (MB) of the terrain + object atlases + count. */
  texMB: number;
  texCount: number;
  /** JS heap (Chrome `performance.memory`; null elsewhere) — used / limit, MB. */
  jsHeapMB: number | null;
  jsHeapLimitMB: number | null;
  /** Bytes pulled this session: over-the-wire vs decoded (resource timing), MB. */
  netMB: number;
  assetsMB: number;
}

/** Which logical layers can be toggled by the host. */
export type LayerName = "terrain" | "grid" | "objects" | "locations" | "overlay";

export interface SceneInitOptions {
  /** canvas background color (default transparent). */
  background?: string | number;
  /** enable antialiasing (default true). */
  antialias?: boolean;
  /** device pixel ratio override (default `window.devicePixelRatio`). */
  resolution?: number;
  /** auto-resize the renderer to the parent element (default true). */
  autoResize?: boolean;
}

export interface SceneEventHandlers {
  /** Throttled camera snapshot (for a minimap / store sync). */
  onCameraChange?: (s: CameraSnapshot) => void;
}

export class Scene {
  private app?: Application;
  private parent?: HTMLElement;

  /** The pannable/zoomable world root that holds every layer. */
  private world?: Container;
  private terrain?: TerrainTilemapLayer;
  private grid?: GridLayer;
  private objects?: ObjectLayer;
  private locations?: LocationLayer;
  private overlay?: OverlayLayer;
  private anim?: AnimationManager;
  private camera?: Camera;

  private handlers: SceneEventHandlers = {};
  private resizeObserver?: ResizeObserver;
  /** render-on-demand state */
  private renderScheduled = false;
  private rafId?: number;
  private animContinuous = false;
  private wheelHandler?: (e: WheelEvent) => void;
  private pointerState: { dragging: boolean; lastX: number; lastY: number } = {
    dragging: false,
    lastX: 0,
    lastY: 0,
  };
  /** debug instrumentation (every renderer.render is timed; see instrumentRender) */
  private renderTimes: number[] = [];
  private lastCpuMs = 0;
  private gpuMs: number | null = null;
  private sampleGpuNext = false;
  private gpuInfo?: { gpu: string; maxTexture: number };

  /** Install host event handlers (camera change, etc.). */
  on(handlers: SceneEventHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
    if (this.camera && handlers.onCameraChange) {
      this.camera.setSnapshotListener(handlers.onCameraChange);
    }
  }

  /** The underlying canvas, once {@link init} has run (for advanced hosts). */
  get canvas(): HTMLCanvasElement | undefined {
    return this.app?.canvas as HTMLCanvasElement | undefined;
  }

  /**
   * Boot the PixiJS application and attach its canvas to `parent`. Must be called
   * (and awaited) before {@link buildScene}.
   */
  async init(
    parent: HTMLElement,
    options: SceneInitOptions = {},
  ): Promise<void> {
    this.parent = parent;
    const app = new Application();
    await app.init({
      background: options.background ?? 0x101418,
      backgroundAlpha: 1,
      // pixel-art iso tiles: antialiasing only blurs them and costs fill rate.
      antialias: options.antialias ?? false,
      resolution: options.resolution ?? globalThis.devicePixelRatio ?? 1,
      autoDensity: true,
      resizeTo: options.autoResize === false ? undefined : parent,
      width: parent.clientWidth || 800,
      height: parent.clientHeight || 600,
    });
    this.app = app;
    this.instrumentRender(app);

    parent.appendChild(app.canvas);

    this.world = new Container();
    this.world.label = "world";
    app.stage.addChild(this.world);

    this.attachInput();

    // Render ON DEMAND: stop Pixi's continuous render loop. We render once per
    // change (camera / scene / layer toggle), and run the loop continuously only
    // while animations are actually playing (see updateRenderMode). A static map
    // then costs ~0 GPU instead of re-rendering 60x/second forever.
    app.ticker.stop();
    this.requestRender();
  }

  /**
   * Build (or rebuild) the visible scene from a document + manifest. The
   * {@link AssetStore} must already be loaded (`await assets.load(manifest)`).
   */
  async buildScene(
    map: MapDocument,
    manifest: AssetManifest,
    assets: AssetStore,
    objectTypes?: ReadonlySet<string>,
    objectData?: ObjectData,
  ): Promise<void> {
    if (!this.app || !this.world) {
      throw new Error("Scene.buildScene called before init()");
    }

    // tear down any previous content
    this.teardownLayers();

    this.anim = new AnimationManager({ autoStart: true });

    // terrain composited at runtime from the shared tile atlas (no per-map PNG)
    this.terrain = new TerrainTilemapLayer();
    this.terrain.build(map, assets, objectData?.terrainCodes);
    this.world.addChild(this.terrain.view);

    // iso grid overlay, above terrain and below objects
    this.grid = new GridLayer();
    this.grid.build(map.size);
    this.world.addChild(this.grid.view);

    // Lazily pull in just THIS map's unit (leader) sprites before placing objects —
    // unit atlases are per-impl chunks not loaded upfront (AssetStore.ensureLoaded).
    const unitKeys: string[] = [];
    for (const o of map.objects) {
      if (o.type === "stack" && o.garrisoned !== true && o.leaderImage) {
        unitKeys.push(`${o.leaderImage}STOP${o.facing ?? 0}`);
      }
    }
    await assets.ensureLoaded(unitKeys);

    this.objects = new ObjectLayer();
    this.objects.build(map, assets, this.anim, objectTypes, {
      landmarks: objectData?.landmarkFootprints,
      graceFortCodes: objectData?.graceFortCodes,
      graceRaceType: objectData?.graceRaceType,
      unitBoat: objectData?.unitBoat,
    });
    this.world.addChild(this.objects.view);

    // event-location highlights, drawn on top of everything (editor getZ ~1300)
    this.locations = new LocationLayer();
    this.locations.build(map.objects);
    this.world.addChild(this.locations.view);

    // editor-assist overlays (tints / hover outline / cursor) on top of everything
    this.overlay = new OverlayLayer();
    this.overlay.build(
      map,
      assets,
      objectData?.landmarkFootprints,
      objectData?.landmarkMountain,
      objectData?.guardRange,
    );
    this.world.addChild(this.overlay.view);

    // camera centered on the map
    this.camera = new Camera(this.world, map.size);
    const screen = this.app.screen;
    this.camera.setScreenSize(screen.width, screen.height);
    if (this.handlers.onCameraChange) {
      this.camera.setSnapshotListener(this.handlers.onCameraChange);
    }
    this.camera.fitToScreen();

    this.updateRenderMode();
    this.requestRender();
  }

  /** Toggle a logical layer's visibility. */
  setLayerVisibility(layer: LayerName, visible: boolean): void {
    if (layer === "terrain") this.terrain?.setVisible(visible);
    else if (layer === "grid") this.grid?.setVisible(visible);
    else if (layer === "objects") this.objects?.setVisible(visible);
    else if (layer === "locations") this.locations?.setVisible(visible);
    else if (layer === "overlay") this.overlay?.setVisible(visible);
    this.requestRender();
  }

  /** Toggle an editor-assist tint category (passable/danger/terraform/forest/roads). */
  setOverlayTint(cat: OverlayTint, on: boolean): void {
    this.overlay?.setTint(cat, on);
    this.requestRender();
  }

  /** Move the cursor-tile highlight + hovered-object outline (null = clear). */
  setCursorCell(cell: CellRef | null): void {
    this.overlay?.setCursorCell(cell);
    this.requestRender();
  }

  /** Fit the whole map into the viewport and re-render (camera "home"). */
  fitView(): void {
    this.camera?.fitToScreen();
    this.requestRender();
  }

  /** Start/stop all sprite animation (single shared ticker). */
  setAnimationEnabled(on: boolean): void {
    this.anim?.setEnabled(on);
    this.updateRenderMode();
  }

  /** Programmatic camera access for hosts (minimap clicks, etc.). */
  getCamera(): Camera | undefined {
    return this.camera;
  }

  /** Schedule a single render on the next frame. No-op while the animation loop
   *  is already running (it renders every frame) or a render is already queued. */
  requestRender(): void {
    if (!this.app || this.animContinuous || this.renderScheduled) return;
    this.renderScheduled = true;
    this.rafId = requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.app?.render();
    });
  }

  /**
   * Render IMMEDIATELY, bypassing requestAnimationFrame. Used during active pan/zoom:
   * a single frame is cheap (<2 ms here), but rAF gets throttled in background /
   * embedded / unfocused contexts, which makes on-demand panning feel laggy even
   * though the GPU is idle. Rendering straight from the input handler keeps dragging
   * responsive regardless of rAF cadence. No-op while the continuous loop is running.
   */
  private renderNow(): void {
    if (!this.app || this.animContinuous) return;
    if (this.rafId !== undefined) {
      cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
    }
    this.renderScheduled = false;
    this.app.render();
  }

  /** Wrap the renderer so EVERY frame (ticker, rAF, or renderNow) is timed for the
   *  debug HUD. `sampleGpuNext` triggers a one-off gl.finish so we get a real
   *  GPU-synced frame time roughly once per second without stalling every frame. */
  private instrumentRender(app: Application): void {
    const r = app.renderer as unknown as {
      render: (...a: unknown[]) => unknown;
      gl?: WebGLRenderingContext;
    };
    const orig = r.render.bind(r);
    r.render = (...args: unknown[]) => {
      const t0 = performance.now();
      const out = orig(...args);
      this.lastCpuMs = performance.now() - t0;
      this.renderTimes.push(t0);
      if (this.sampleGpuNext && r.gl) {
        this.sampleGpuNext = false;
        const g0 = performance.now();
        r.gl.finish();
        this.gpuMs = performance.now() - g0 + this.lastCpuMs;
      }
      return out;
    };
  }

  /** Snapshot live perf/engine numbers for the debug overlay. Cheap; call ~4×/s. */
  getDebugStats(): DebugStats | undefined {
    if (!this.app) return undefined;
    const now = performance.now();
    let cut = 0;
    while (cut < this.renderTimes.length && now - (this.renderTimes[cut] as number) > 1000) {
      cut++;
    }
    if (cut > 0) this.renderTimes.splice(0, cut);
    this.sampleGpuNext = true; // ask the next real render to gl.finish-time itself
    const r = this.app.renderer;
    const gl = (r as unknown as { gl?: WebGLRenderingContext }).gl;
    if (!this.gpuInfo) {
      let gpu = "n/a";
      let maxTexture = 0;
      if (gl) {
        maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        gpu = dbg
          ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string)
          : (gl.getParameter(gl.RENDERER) as string);
      }
      this.gpuInfo = { gpu, maxTexture };
    }
    // estimate texture VRAM from the distinct sources actually on screen
    const sources = new Map<number, { width: number; height: number }>();
    const addTex = (c: unknown): void => {
      const src = (c as { texture?: { source?: { uid: number; pixelWidth?: number; pixelHeight?: number; width: number; height: number } } }).texture?.source;
      if (src) sources.set(src.uid, { width: src.pixelWidth ?? src.width, height: src.pixelHeight ?? src.height });
    };
    this.terrain?.view.children.forEach(addTex);
    this.objects?.view.children.forEach(addTex);
    let texBytes = 0;
    sources.forEach((s) => (texBytes += s.width * s.height * 4));
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    let net = 0;
    let assets = 0;
    for (const e of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
      net += e.transferSize || 0;
      assets += e.decodedBodySize || 0;
    }
    const MB = 1048576;
    return {
      fps: this.renderTimes.length,
      cpuMs: this.lastCpuMs,
      gpuMs: this.gpuMs,
      zoom: this.world?.scale.x ?? 1,
      world: { x: this.world?.x ?? 0, y: this.world?.y ?? 0 },
      objects: this.objects?.view.children.length ?? 0,
      animActive: this.anim?.activeCount ?? 0,
      screen: { w: r.screen.width, h: r.screen.height },
      drawingBuffer: {
        w: gl?.drawingBufferWidth ?? 0,
        h: gl?.drawingBufferHeight ?? 0,
      },
      resolution: r.resolution,
      dpr: globalThis.devicePixelRatio ?? 1,
      gpu: this.gpuInfo.gpu,
      maxTexture: this.gpuInfo.maxTexture,
      rendererType: r.type === 1 ? "WebGL" : String(r.type),
      texMB: texBytes / MB,
      texCount: sources.size,
      jsHeapMB: mem ? mem.usedJSHeapSize / MB : null,
      jsHeapLimitMB: mem ? mem.jsHeapSizeLimit / MB : null,
      netMB: net / MB,
      assetsMB: assets / MB,
    };
  }

  /** Run Pixi's continuous render loop only while animations are actually playing;
   *  otherwise stay idle and render on demand. */
  private updateRenderMode(): void {
    if (!this.app) return;
    const shouldRun = !!this.anim && this.anim.isEnabled && this.anim.activeCount > 0;
    if (shouldRun && !this.animContinuous) {
      this.animContinuous = true;
      this.app.ticker.start();
    } else if (!shouldRun && this.animContinuous) {
      this.animContinuous = false;
      this.app.ticker.stop();
      this.requestRender();
    } else if (!shouldRun) {
      this.requestRender();
    }
  }

  // --- input wiring (browser only; no-ops if APIs absent) ---

  private attachInput(): void {
    const app = this.app;
    if (!app) return;
    const canvas = app.canvas as HTMLCanvasElement;

    // wheel zoom (cursor-anchored)
    this.wheelHandler = (e: WheelEvent) => {
      if (!this.camera) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const ax = e.clientX - rect.left;
      const ay = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.camera.zoomAt(factor, ax, ay);
      this.renderNow();
    };
    canvas.addEventListener("wheel", this.wheelHandler, { passive: false });

    // drag pan via Pixi's pointer events on the stage
    app.stage.eventMode = "static";
    app.stage.hitArea = app.screen;
    app.stage.on("pointerdown", (e) => {
      this.pointerState.dragging = true;
      this.pointerState.lastX = e.global.x;
      this.pointerState.lastY = e.global.y;
    });
    app.stage.on("pointerup", () => (this.pointerState.dragging = false));
    app.stage.on("pointerupoutside", () => (this.pointerState.dragging = false));
    app.stage.on("pointermove", (e) => {
      if (!this.pointerState.dragging || !this.camera) return;
      const dx = e.global.x - this.pointerState.lastX;
      const dy = e.global.y - this.pointerState.lastY;
      this.pointerState.lastX = e.global.x;
      this.pointerState.lastY = e.global.y;
      this.camera.panBy(dx, dy);
      this.renderNow();
    });

    // keep the camera's screen size in sync with the parent element
    if (typeof ResizeObserver !== "undefined" && this.parent) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.camera && this.app) {
          this.camera.setScreenSize(
            this.app.screen.width,
            this.app.screen.height,
          );
          this.requestRender();
        }
      });
      this.resizeObserver.observe(this.parent);
    }
  }

  private teardownLayers(): void {
    if (this.objects && this.anim) this.objects.destroy(this.anim);
    this.overlay?.destroy();
    this.locations?.destroy();
    this.grid?.destroy();
    this.terrain?.destroy();
    this.anim?.destroy();
    this.camera?.destroy();
    this.objects = undefined;
    this.overlay = undefined;
    this.locations = undefined;
    this.grid = undefined;
    this.terrain = undefined;
    this.anim = undefined;
    this.camera = undefined;
  }

  /** Tear everything down and release GPU + DOM resources. */
  destroy(): void {
    if (this.wheelHandler && this.app) {
      (this.app.canvas as HTMLCanvasElement).removeEventListener(
        "wheel",
        this.wheelHandler,
      );
    }
    this.wheelHandler = undefined;
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
    this.rafId = undefined;
    this.renderScheduled = false;
    this.animContinuous = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;

    this.teardownLayers();

    if (this.world) {
      this.world.destroy({ children: true });
      this.world = undefined;
    }
    if (this.app) {
      this.app.destroy({ removeView: true }, { children: true });
      this.app = undefined;
    }
    this.parent = undefined;
  }
}
