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
import { Application, Container, Sprite, Graphics } from "pixi.js";
import type { MapDocument } from "@d2/map-schema";
import type { AssetManifest } from "@d2/asset-manifest";

import { AssetStore } from "./AssetStore.js";
import { TerrainTilemapLayer } from "./TerrainTilemapLayer.js";
import { GridLayer } from "./GridLayer.js";
import { ObjectLayer, type ObjectTables } from "./ObjectLayer.js";
import { LocationLayer, type LocationOpts } from "./LocationLayer.js";
import { EventOverlayLayer } from "./EventOverlayLayer.js";
import { AnchorLayer } from "./AnchorLayer.js";
import { ScenarioRolesLayer, type RoleCounts } from "./ScenarioRolesLayer.js";
import { PresenceLayer, type PeerMarker } from "./PresenceLayer.js";
import { OverlayLayer, type OverlayTint, type CellRef } from "./OverlayLayer.js";
import { cellToWorld, mapWorldBounds, HALF_W, HALF_H } from "./iso.js";
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
  /** label/highlight inputs (captions, selected id) kept so locations can rebuild in place. */
  private locOpts: LocationOpts = {};
  private eventOverlay?: EventOverlayLayer;
  /** The selected event to visualize; kept so a rebuild after an edit re-draws it. */
  private selectedEvent: import("@d2/map-schema").MapEvent | null = null;
  private anchorLayer?: AnchorLayer;
  /** anchors (child->parent) + visibility, kept so a full rebuild restores the overlay. */
  private anchorState: { anchors: Record<string, string>; visible: boolean } = { anchors: {}, visible: false };
  private scenarioRoles?: ScenarioRolesLayer;
  /** location roles + visibility, kept so a full rebuild restores the overlay. */
  private scenarioRolesState: { roles: Record<string, RoleCounts>; visible: boolean } = { roles: {}, visible: true };
  /** «режим локаций»: a dark veil between objects and location overlays + its toggle state
   *  (kept so buildScene restores the mode after a map rebuild). */
  private locVeil?: Graphics;
  private locationsModeOn = false;
  private mapSizeCur = 0;
  /** hover spotlight (location ids under the cursor), kept to re-apply after rebuilds. */
  private locFocus: ReadonlySet<string> | null = null;
  private presence?: PresenceLayer;
  private overlay?: OverlayLayer;
  private anim?: AnimationManager;
  private camera?: Camera;
  /** kept so the terrain layer can be re-tiled in place after an edit (M2 brushes). */
  private assets?: AssetStore;
  private terrainCodes?: Record<number, string>;
  /** kept so the object layer can be rebuilt in place after a placement/move edit. */
  private objectTypes?: ReadonlySet<string>;
  private objectTables?: ObjectTables;
  /** translucent placement preview (the decor tool) — one reused sprite. */
  private ghost?: Container;
  private ghostSprite?: Sprite;
  /** highlight diamonds for a selected road segment (the road-select tool). */
  private roadSel?: Graphics;
  /** footprint "fitting" diamonds for the decor/move target (green=valid, red=invalid). */
  private footprint?: Graphics;
  /** persistent selection outline (the inspector's selected object). */
  private selection?: Graphics;

  private handlers: SceneEventHandlers = {};
  private resizeObserver?: ResizeObserver;
  /** render-on-demand state */
  private renderScheduled = false;
  private rafId?: number;
  private animContinuous = false;
  /** When false, drag-pan is suppressed so a paint tool can own the drag. */
  private panEnabled = true;
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
    this.assets = assets;
    this.terrainCodes = objectData?.terrainCodes;
    this.terrain = new TerrainTilemapLayer();
    this.terrain.build(map, assets, this.terrainCodes);
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
    this.objectTypes = objectTypes;
    this.objectTables = {
      landmarks: objectData?.landmarkFootprints,
      graceFortCodes: objectData?.graceFortCodes,
      graceRaceType: objectData?.graceRaceType,
      unitBoat: objectData?.unitBoat,
    };
    this.objects.build(map, assets, this.anim, objectTypes, this.objectTables);
    this.world.addChild(this.objects.view);

    // event-location highlights, drawn on top of everything (editor getZ ~1300)
    this.mapSizeCur = map.size;
    this.locations = new LocationLayer();
    this.locations.build(map.objects, this.locOpts);
    this.locations.setFocus(this.locFocus);
    this.world.addChild(this.locations.view);
    if (this.locationsModeOn) this.addLocVeil(); // restore «режим локаций» after a rebuild

    // event overlay (trigger zones / movement arrows), above locations
    this.eventOverlay = new EventOverlayLayer();
    this.eventOverlay.build(map, this.selectedEvent);
    this.world.addChild(this.eventOverlay.view);

    // editor-only anchors («Связи»): ⚓ + child→parent arrows
    this.anchorLayer = new AnchorLayer();
    this.anchorLayer.build(map, this.anchorState.anchors);
    this.anchorLayer.setVisible(this.anchorState.visible);
    this.world.addChild(this.anchorLayer.view);

    // scenario-roles overlay («Роли локаций»): ring + role badges per event-wired location
    this.scenarioRoles = new ScenarioRolesLayer();
    this.scenarioRoles.build(map, this.scenarioRolesState.roles);
    this.scenarioRoles.setVisible(this.scenarioRolesState.visible);
    this.scenarioRoles.setFocus(this.locFocus);
    this.world.addChild(this.scenarioRoles.view);

    // collaborator cursors, above locations
    this.presence = new PresenceLayer();
    this.world.addChild(this.presence.view);

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
    // immediate paint (not rAF-scheduled): the first frame after a load must not depend
    // on rAF, which is throttled while the pointer is off-canvas / window unfocused
    this.renderNow();
  }

  /**
   * Re-tile the terrain layer from an edited document (M2 brushes). Lighter than a
   * full buildScene: only the terrain layer rebuilds; objects/grid/camera untouched.
   */
  updateTerrain(map: MapDocument): void {
    if (!this.terrain || !this.assets) return;
    this.terrain.build(map, this.assets, this.terrainCodes);
    this.renderNow(); // paint immediately — rAF is throttled when the pointer is off-canvas
  }

  /**
   * Rebuild the object layer in place from an edited document (a placed/moved/removed
   * object). ObjectLayer.build() clears itself first and its container keeps its slot
   * in the world, so z-order vs terrain/overlay is preserved. Call this only on edits
   * that change objects (placement/move) — not on every terrain brush stroke.
   */
  updateObjects(map: MapDocument): void {
    if (!this.objects || !this.assets || !this.anim) return;
    this.objects.build(map, this.assets, this.anim, this.objectTypes, this.objectTables);
    this.updateRenderMode();
    this.renderNow(); // paint immediately — rAF is throttled when the pointer is off-canvas
  }

  /**
   * Rebuild the location highlights + labels in place from an edited document plus the
   * editor's label inputs (captions, the selected object id). Cheap (a few Graphics/Text);
   * call on object edits and whenever the caption/selection changes. `opts` is merged into
   * the kept state so a later buildScene re-applies the same labels.
   */
  updateLocations(map: MapDocument, opts?: LocationOpts): void {
    if (opts) this.locOpts = { ...this.locOpts, ...opts };
    if (!this.locations) return;
    this.locations.build(map.objects, this.locOpts);
    this.renderNow();
  }

  /** Visualize a selected scenario event (trigger zones + movement arrows), or clear (null). */
  updateEventOverlay(map: MapDocument, ev: import("@d2/map-schema").MapEvent | null): void {
    this.selectedEvent = ev;
    if (!this.eventOverlay) return;
    this.eventOverlay.build(map, ev);
    this.renderNow();
  }

  /** Redraw the editor-only anchors overlay («Связи»). */
  updateAnchors(map: MapDocument, anchors: Record<string, string>, visible: boolean): void {
    this.anchorState = { anchors, visible };
    if (!this.anchorLayer) return;
    this.anchorLayer.build(map, anchors);
    this.anchorLayer.setVisible(visible);
    this.renderNow();
  }

  /** Redraw the «Роли локаций» overlay (per-location role counts from the host's
   *  scenarioRoles model: trigger/spawn/destination/env). */
  updateScenarioRoles(map: MapDocument, roles: Record<string, RoleCounts>, visible: boolean): void {
    this.scenarioRolesState = { roles, visible };
    if (!this.scenarioRoles) return;
    this.scenarioRoles.build(map, roles);
    this.scenarioRoles.setVisible(visible);
    this.renderNow();
  }

  /** Replace the live collaborator-cursor markers (collab presence). */
  setPeers(peers: ReadonlyArray<PeerMarker>): void {
    if (!this.presence) return;
    this.presence.setPeers(peers);
    this.renderNow();
  }

  /**
   * Show (or hide) a translucent placement preview ("ghost") for the decor tool.
   * `key` is the sprite atlas key (a landmark id / MOMNE id); `footprint` is in cells
   * so the ghost centres on its footprint like a real object. `valid===false` tints it
   * red. Pass `key=null` (or no cell) to hide. One Sprite is reused across calls.
   */
  setGhost(
    key: string | null,
    cell?: CellRef | null,
    footprint?: { w: number; h: number },
    valid = true,
  ): void {
    if (!this.world || !this.assets) return;
    if (!key || !cell) {
      if (this.ghost) this.ghost.visible = false;
      this.requestRender();
      return;
    }
    let tex = this.assets.resolveTexture(key);
    if (tex.label === "EMPTY") {
      const frames = this.assets.resolveAnimation(key);
      if (frames.length > 0) tex = frames[0]!;
    }
    if (tex.label === "EMPTY") {
      if (this.ghost) this.ghost.visible = false;
      this.requestRender();
      return;
    }
    if (!this.ghost) {
      this.ghost = new Container();
      this.ghost.label = "ghost";
      this.world.addChild(this.ghost); // added after every layer -> drawn on top
    }
    if (!this.ghostSprite) {
      this.ghostSprite = new Sprite();
      this.ghostSprite.anchor.set(0.5, 0.5);
      this.ghostSprite.alpha = 0.6;
      this.ghost.addChild(this.ghostSprite);
    }
    this.ghostSprite.texture = tex;
    this.ghostSprite.tint = valid ? 0xffffff : 0xff6666;
    const w = footprint?.w ?? 1;
    const h = footprint?.h ?? 1;
    const c = cellToWorld(cell.x + w / 2, cell.y + h / 2);
    this.ghostSprite.position.set(c.x, c.y);
    this.ghost.visible = true;
    this.requestRender();
  }

  /**
   * Highlight a selected road segment with translucent iso diamonds over `cells`
   * (the road-select tool). Pass an empty array to clear. One reused Graphics.
   */
  setRoadSelection(cells: readonly CellRef[]): void {
    if (!this.world) return;
    if (!this.roadSel) {
      this.roadSel = new Graphics();
      this.roadSel.label = "road-selection";
      this.world.addChild(this.roadSel); // added last -> drawn on top
    }
    const g = this.roadSel;
    g.clear();
    for (const c of cells) {
      const p = cellToWorld(c.x, c.y);
      const cy = p.y + HALF_H;
      g.poly([p.x, cy - HALF_H, p.x + HALF_W, cy, p.x, cy + HALF_H, p.x - HALF_W, cy]);
    }
    if (cells.length) {
      g.fill({ color: 0x46d0ff, alpha: 0.34 });
      g.stroke({ color: 0x9fe6ff, alpha: 0.95, width: 1 });
    }
    this.requestRender();
  }

  /**
   * Footprint "fitting" preview — translucent iso diamonds over the target `cells`,
   * green when the placement/move is valid, red when not. Empty array clears it.
   * Works for ANY object (no sprite key needed), so move always shows where it lands.
   * `faint` draws it lightly (for a persistent generation zone that shouldn't obscure
   * the result), vs. the bold default used for transient move/decor previews.
   */
  setFootprint(cells: readonly CellRef[], valid = true, faint = false): void {
    if (!this.world) return;
    if (!this.footprint) {
      this.footprint = new Graphics();
      this.footprint.label = "footprint";
      this.world.addChild(this.footprint);
    }
    const g = this.footprint;
    g.clear();
    for (const c of cells) {
      const p = cellToWorld(c.x, c.y);
      const cy = p.y + HALF_H;
      g.poly([p.x, cy - HALF_H, p.x + HALF_W, cy, p.x, cy + HALF_H, p.x - HALF_W, cy]);
    }
    if (cells.length) {
      const color = valid ? 0x66ff99 : 0xff6b6b;
      g.fill({ color, alpha: faint ? 0.1 : 0.22 });
      g.stroke({ color, alpha: faint ? 0.5 : 0.95, width: faint ? 1 : 1.5 });
    }
    this.requestRender();
  }

  /** Persistent SELECTION outline over `cells` (the inspector's selected object). A bold
   *  cyan diamond border, distinct from the transient green/red footprint preview. Empty
   *  array clears it. */
  setSelection(cells: readonly CellRef[]): void {
    if (!this.world) return;
    if (!this.selection) {
      this.selection = new Graphics();
      this.selection.label = "selection";
      this.selection.eventMode = "none";
      this.world.addChild(this.selection);
    }
    const g = this.selection;
    g.clear();
    for (const c of cells) {
      const p = cellToWorld(c.x, c.y);
      const cy = p.y + HALF_H;
      g.poly([p.x, cy - HALF_H, p.x + HALF_W, cy, p.x, cy + HALF_H, p.x - HALF_W, cy]);
    }
    if (cells.length) {
      g.fill({ color: 0x33ddff, alpha: 0.12 });
      g.stroke({ color: 0x33ddff, alpha: 0.95, width: 2 });
    }
    this.renderNow();
  }

  /** Enable/disable drag-to-pan (disabled while a paint tool is active). */
  setPanEnabled(enabled: boolean): void {
    this.panEnabled = enabled;
    if (!enabled) this.pointerState.dragging = false;
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

  /** Center the camera on a WORLD point and paint IMMEDIATELY (minimap click, "show on map").
   *  renderNow, not requestRender: rAF is throttled while the pointer sits off the canvas —
   *  which is exactly the minimap-click case — so a plain requestRender would leave the map
   *  frozen until the next pointermove ("moves only when I wave the mouse over it"). */
  centerOn(worldX: number, worldY: number): void {
    this.camera?.centerOn(worldX, worldY);
    this.renderNow();
  }

  /** Hover spotlight for location overlays: the ids under the cursor render at full alpha
   *  (+ their name labels), every other location/ring fades. null = no hover, all normal.
   *  This is what keeps a 400-location map readable — see LocationLayer/ScenarioRolesLayer. */
  setLocationFocus(ids: ReadonlyArray<string> | null): void {
    this.locFocus = ids && ids.length ? new Set(ids) : null;
    this.locations?.setFocus(this.locFocus);
    this.scenarioRoles?.setFocus(this.locFocus);
    this.requestRender();
  }

  /** «Режим локаций»: dim the WORLD (terrain + objects) under a dark veil so the location
   *  overlays read at full strength while the user works with locations. The veil sits
   *  between the object layer and the location overlays. */
  setLocationsMode(on: boolean): void {
    this.locationsModeOn = on;
    if (on) this.addLocVeil();
    else this.removeLocVeil();
    this.renderNow(); // programmatic scene change — paint now (rAF may be throttled)
  }

  private addLocVeil(): void {
    if (this.locVeil || !this.world || !this.locations) return;
    const b = mapWorldBounds(Math.max(1, this.mapSizeCur));
    const pad = 512; // cover the pan margin too
    const g = new Graphics();
    g.rect(b.minX - pad, b.minY - pad, b.width + 2 * pad, b.height + 2 * pad)
      .fill({ color: 0x05070a, alpha: 0.55 });
    g.eventMode = "none";
    g.label = "locations-veil";
    this.world.addChildAt(g, this.world.getChildIndex(this.locations.view));
    this.locVeil = g;
  }

  private removeLocVeil(): void {
    if (!this.locVeil) return;
    this.locVeil.destroy();
    this.locVeil = undefined;
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
   * Render IMMEDIATELY, bypassing requestAnimationFrame. Used during active pan/zoom
   * AND after edit-driven scene updates: a single frame is cheap (<2 ms here), but rAF
   * gets throttled in background / embedded / off-canvas-pointer contexts, which makes
   * on-demand painting lag even though the GPU is idle.
   *
   * Deliberately NOT skipped while the continuous animation loop is running: the ticker
   * is rAF-driven too, so it stalls under the same throttle — an updateTerrain/
   * updateObjects after a Copilot generation would otherwise paint nothing until a
   * pointermove wakes rAF (the "result appears only when I move the mouse" bug). One
   * extra immediate frame alongside the ticker is harmless.
   */
  private renderNow(): void {
    if (!this.app) return;
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
      // a paint/edit tool owns the drag (setPanEnabled false) — EXCEPT Ctrl+drag, which
      // always pans the camera so you can move the map without leaving the active tool.
      if (!this.panEnabled && !e.ctrlKey) return;
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

    // Keep the RENDERER + camera in sync with the parent element. Pixi's `resizeTo: element`
    // only re-measures on WINDOW resize — when a side panel opens/closes (container resizes
    // without a window resize) the canvas kept its stale size, leaving a black gap next to a
    // docked panel (or pushing it off-screen). Explicitly app.resize() (re-reads resizeTo),
    // then sync the camera and paint NOW (rAF may be throttled).
    if (typeof ResizeObserver !== "undefined" && this.parent) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.camera && this.app) {
          this.app.resize();
          this.camera.setScreenSize(
            this.app.screen.width,
            this.app.screen.height,
          );
          this.renderNow();
        }
      });
      this.resizeObserver.observe(this.parent);
    }
  }

  private teardownLayers(): void {
    if (this.ghost) {
      this.ghost.destroy({ children: true });
      this.ghost = undefined;
      this.ghostSprite = undefined;
    }
    if (this.roadSel) {
      this.roadSel.destroy();
      this.roadSel = undefined;
    }
    if (this.footprint) {
      this.footprint.destroy();
      this.footprint = undefined;
    }
    if (this.selection) {
      this.selection.destroy();
      this.selection = undefined;
    }
    this.removeLocVeil();
    if (this.objects && this.anim) this.objects.destroy(this.anim);
    this.overlay?.destroy();
    this.presence?.destroy();
    this.eventOverlay?.destroy();
    this.anchorLayer?.destroy();
    this.scenarioRoles?.destroy();
    this.locations?.destroy();
    this.grid?.destroy();
    this.terrain?.destroy();
    this.anim?.destroy();
    this.camera?.destroy();
    this.objects = undefined;
    this.overlay = undefined;
    this.eventOverlay = undefined;
    this.anchorLayer = undefined;
    this.scenarioRoles = undefined;
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
