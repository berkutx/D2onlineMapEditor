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
import { Application, Container, type Texture } from "pixi.js";
import type { MapDocument } from "@d2/map-schema";
import type { AssetManifest } from "@d2/asset-manifest";

import { AssetStore } from "./AssetStore.js";
import { TerrainLayer, type TerrainMeta } from "./TerrainLayer.js";
import { GridLayer } from "./GridLayer.js";
import { ObjectLayer } from "./ObjectLayer.js";
import { AnimationManager } from "./AnimationManager.js";
import { Camera, type CameraSnapshot } from "./Camera.js";

/** Which logical layers can be toggled by the host. */
export type LayerName = "terrain" | "grid" | "objects";

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
  private terrain?: TerrainLayer;
  private grid?: GridLayer;
  private objects?: ObjectLayer;
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
    terrain: { texture: Texture; meta: TerrainMeta },
    objectTypes?: ReadonlySet<string>,
  ): Promise<void> {
    if (!this.app || !this.world) {
      throw new Error("Scene.buildScene called before init()");
    }

    // tear down any previous content
    this.teardownLayers();

    this.anim = new AnimationManager({ autoStart: true });

    this.terrain = new TerrainLayer();
    this.terrain.build(terrain.texture, terrain.meta);
    this.world.addChild(this.terrain.view);

    // iso grid overlay, above terrain and below objects
    this.grid = new GridLayer();
    this.grid.build(map.size);
    this.world.addChild(this.grid.view);

    this.objects = new ObjectLayer();
    this.objects.build(map, assets, this.anim, objectTypes);
    this.world.addChild(this.objects.view);

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
      this.requestRender();
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
      this.requestRender();
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
    this.grid?.destroy();
    this.terrain?.destroy();
    this.anim?.destroy();
    this.camera?.destroy();
    this.objects = undefined;
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
