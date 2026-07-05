<script setup lang="ts">
/**
 * MapCanvasHost — the single bridge between Vue and PixiJS.
 *
 * It mounts the framework-agnostic `Scene` into a plain <div> ref in onMounted,
 * owns the Scene lifecycle (init / buildScene / destroy), and reacts to store
 * changes (the open document, layer visibility, the animate flag) by calling
 * Scene methods IMPERATIVELY via watchers.
 *
 * Reactivity boundary: the Scene/AssetStore live in the non-reactive
 * sceneHolder module; this component only ever holds plain refs (the mount
 * element, a loading flag). Pixi objects never enter Vue's reactive graph.
 */
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { assetUrl } from "../services/api";
import { storeToRefs } from "pinia";
import { Scene } from "@d2/pixi-render";
import type { CameraSnapshot, DebugStats, LandmarkFootprints, ObjectRoleMarker } from "@d2/pixi-render";
import { worldToCell, cellToWorld, objectFootprint, objectZBase, objectSprites, type ZoneVisual } from "@d2/pixi-render";
import type { MapDocument, MapObject } from "@d2/map-schema";
import {
  terrainBrush,
  roadBrush,
  eraseBrush,
  buildOccupiedSet,
  placeMountainOps,
  deleteMountainOps,
  placeLandmarkOps,
  placeVillageOps,
  placeChestOps,
  placeStackOps,
  placeRuinOps,
  placeSiteOps,
  selectRoadSegment,
  translateRoadCells,
  extendRoadPath,
  rerouteRoadOps,
  lPath,
  applyOps,
  type BrushKind,
  type EditOp,
} from "@d2/map-edit";
import { useMapStore } from "../stores/mapStore";
import { useAssetStore } from "../stores/assetStore";
import { useViewStore, OVERLAY_TINTS } from "../stores/viewStore";
import { useToolStore, type PlaceObjectKind } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";
import {
  locationRoleCounts,
  locationSummaries,
  computeObjectRoles,
  countsOf,
  rolesMatchFilter,
  formatRoleBadges,
  type ObjectRole,
  type RoleCounts,
} from "../services/scenarioRoles";
import { useDecorStore, type DecorEntry } from "../stores/decorStore";
import { useUnitStore } from "../stores/unitStore";
import { useCollabStore } from "../stores/collabStore";
import { useEventStore } from "../stores/eventStore";
import { getAssetStore, getScene, setScene, destroyScene } from "./sceneHolder";

const mapStore = useMapStore();
const assetStore = useAssetStore();
const viewStore = useViewStore();
const toolStore = useToolStore();
const editStore = useEditStore();
const decorStore = useDecorStore();
const unitStore = useUnitStore();
const collabStore = useCollabStore();
const eventStore = useEventStore();

const { currentMap } = storeToRefs(mapStore);
const { manifest } = storeToRefs(assetStore);
const {
  terrainVisible,
  objectsVisible,
  gridVisible,
  locationsVisible,
  animate,
  debugOverlay,
  overlayTints,
  cursorCell,
} = storeToRefs(viewStore);

// Static object layers with a faithful sprite key + footprint ported, that resolve
// in the atlases. Forts/capitals/villages, stacks, units (DBF-driven) and locations
// come next. Animation is intentionally off for now.
const VISIBLE_OBJECT_TYPES = new Set([
  "mountains",
  "landmark",
  "ruin",
  "crystal",
  "merchant",
  "mage",
  "mercenary",
  "trainer",
  "capital",
  "village",
  "treasure",
  "stack",
  "rod",
  "tomb",
]);

const mountEl = ref<HTMLDivElement | null>(null);
const building = ref(false);
const buildError = ref<string | null>(null);
/** Landmark footprints (cx,cy) from objectdata.json — for object hit-testing (move tool). */
let landmarkFootprints: LandmarkFootprints | undefined;
/** objectdata.json sprite-key tables (race codes / boats) — for deriving a move ghost sprite. */
let spriteTables:
  | { graceFortCodes?: Record<number, string>; graceRaceType?: Record<number, number>; unitBoat?: Record<string, number> }
  | undefined;

// Debug HUD: poll the Scene's live perf/engine numbers ~4x/s (setInterval works
// even when the page is backgrounded; rAF would not).
const debugStats = ref<DebugStats | null>(null);
let debugTimer: number | undefined;

/** Build (or rebuild) the scene from the current document + manifest. */
async function rebuild(): Promise<void> {
  const scene = getScene();
  const doc = currentMap.value;
  const man = manifest.value;
  const id = mapStore.currentScenarioId;
  if (!scene || !doc || !man || !id) return;

  building.value = true;
  buildError.value = null;
  try {
    // Terrain is now composited at runtime by the renderer (TerrainTilemapLayer) from
    // the SHARED tile atlas in the manifest — no per-map PNG fetch. So any map renders
    // without a per-map asset build.
    // object placement data (landmark footprints, graceFortCodes from the DBFs).
    // Let the browser cache it per the server headers (/assets = max-age + stale-while-
    // revalidate, NOT immutable) — a rare pipeline rebuild self-heals within a day.
    const objectData = await (
      await fetch(assetUrl("objectdata.json"))
    ).json();
    landmarkFootprints = objectData?.landmarkFootprints;
    spriteTables = objectData;
    // the animate flag must be known BEFORE the build: with playback persisted ON,
    // buildScene pre-pulls the lazy animation atlases (otherwise statics render).
    scene.setAnimationEnabled(animate.value);
    await scene.buildScene(doc, man, getAssetStore(), VISIBLE_OBJECT_TYPES, objectData);
    // editor: this map's project + base doc (liveDoc = base + persisted edits, which
    // the rev watcher re-tiles onto the freshly-built terrain).
    editStore.ensureProject(id);
    editStore.setBaseDoc(doc);
    // join this map's collaboration room (room = map id = share link). Done AFTER setBaseDoc
    // so a snapshot catch-up replaces a consistent base; join() leaves any previous room.
    void collabStore.join(id);
    scene.setPanEnabled(toolStore.tool === "select");
    // apply the current view state to the freshly-built scene
    scene.setLayerVisibility("terrain", terrainVisible.value);
    scene.setLayerVisibility("objects", objectsVisible.value);
    scene.setLayerVisibility("grid", gridVisible.value);
    scene.setLayerVisibility("locations", locationsVisible.value);
    // seed location labels + zone shapes (own captions + current selection) onto the fresh scene
    refreshZonesAndLocations();
    // seed the «Роли локаций» overlay too — a fresh Scene starts with an empty roles state,
    // and the objectsRev watcher only fires on the NEXT edit; without this the rings/badges
    // stay invisible after a reload until something bumps the doc.
    scene.updateScenarioRoles(
      editStore.liveDoc ?? doc,
      zoneFilteredRoleCounts(editStore.liveDoc ?? doc),
      viewStore.rolesVisible,
      objectRoleMarkers(editStore.liveDoc ?? doc),
    );
    for (const cat of OVERLAY_TINTS) scene.setOverlayTint(cat, overlayTints.value[cat]);
    scene.setAnimationEnabled(animate.value);
    // seed the status bar with the initial camera zoom + visible-cell box
    const cam = scene.getCamera();
    if (cam) {
      viewStore.setZoom(cam.zoom);
      updateVisibleCells(cam.snapshot());
    }
    focusPendingObject(); // deep link (?obj=): центр + выделение + мигание
  } catch (e) {
    buildError.value = e instanceof Error ? e.message : String(e);
  } finally {
    building.value = false;
  }
}

// --- deep link на объект (?obj= в URL) ----------------------------------------------------
/** Мигание «вот этот объект»: футпринт-ромбы 3 секунды (12 тиков × 250мс), затем чисто.
 *  renderNow на каждый тик — rAF заморожен, пока указатель вне канваса. */
let blinkTimer: number | undefined;
function blinkCells(cells: { x: number; y: number }[]): void {
  const scene = getScene();
  if (!scene || !cells.length) return;
  if (blinkTimer !== undefined) window.clearInterval(blinkTimer);
  let n = 0;
  blinkTimer = window.setInterval(() => {
    n++;
    scene.setFootprint(n % 2 === 1 ? cells : [], true);
    scene.renderNow();
    if (n >= 12) {
      window.clearInterval(blinkTimer);
      blinkTimer = undefined;
      scene.setFootprint([]);
      scene.renderNow();
    }
  }, 250);
}

/** Открытие ссылки вида ?map=…&obj=…: найти объект/зону, центрировать камеру, выделить
 *  (инспектор откроется сам) и мигнуть футпринтом. Однократно — фокус сбрасывается. */
function focusPendingObject(): void {
  const id = toolStore.focusObjectId;
  if (!id) return;
  toolStore.focusObjectId = null;
  const scene = getScene();
  const doc = editStore.liveDoc ?? currentMap.value;
  if (!scene || !doc) return;
  if (id.startsWith("ZN")) {
    const z = editStore.zones[id];
    if (!z || !z.cells.length) { ElMessage.warning("Зона из ссылки не найдена на карте"); return; }
    if (!viewStore.locationsVisible) viewStore.setLayerVisible("locations", true);
    toolStore.setSelectedZone(id);
    const pts = z.cells.map((k) => { const [x, y] = k.split(",").map(Number); return { x: x!, y: y! }; });
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const w = cellToWorld(cx + 0.5, cy + 0.5);
    scene.centerOn(w.x, w.y);
    blinkCells(pts);
    return;
  }
  const obj = doc.objects.find((o) => o.id === id);
  if (!obj) { ElMessage.warning("Объект из ссылки не найден на карте"); return; }
  if (obj.type === "location" && !viewStore.locationsVisible) viewStore.setLayerVisible("locations", true);
  toolStore.setSelectedId(obj.id);
  const { w, h } = objectFootprint(obj, landmarkFootprints);
  const c = cellToWorld(obj.pos.x + w / 2, obj.pos.y + h / 2);
  scene.focusOn(c.x, c.y, 1); // open the shared object at 100% (not the map's fit-to-screen zoom)
  blinkCells(obj.type === "location" ? locationCells(obj) : footprintCells(obj.pos.x, obj.pos.y, w, h));
}

onMounted(async () => {
  if (!mountEl.value) return;

  const scene = new Scene();
  await scene.init(mountEl.value);

  // Sync camera changes back into the (reactive) view store for the status bar + the eye zone.
  scene.on({
    onCameraChange: (snap: CameraSnapshot) => {
      viewStore.setZoom(snap.zoom);
      updateVisibleCells(snap);
    },
  });

  setScene(scene);
  // debug hooks: inspect the live scene graph + asset store + stores from the preview console
  (window as unknown as { __d2scene?: unknown }).__d2scene = scene;
  (window as unknown as { __d2assets?: unknown }).__d2assets = getAssetStore();
  (window as unknown as { __d2stores?: unknown }).__d2stores = {
    edit: editStore, tool: toolStore, view: viewStore, events: eventStore, map: mapStore, collab: collabStore,
  };

  // Report the cursor cell to the status bar (cheap pointer math via the
  // re-exported pure helpers; no Pixi reactivity involved).
  const canvas = scene.canvas;
  if (canvas) {
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("contextmenu", onContextMenu);
  }
  window.addEventListener("keydown", onKeyDown);
  // make the catalogs ready before the user opens the decor palette / places a stack
  void decorStore.load();
  void unitStore.load();

  // poll debug stats for the HUD
  debugTimer = window.setInterval(() => {
    debugStats.value = getScene()?.getDebugStats() ?? null;
  }, 250);

  // If a document is already loaded (startup auto-load races mount), build now.
  if (currentMap.value && manifest.value) await rebuild();
});

/** Compute the bounding box (cells) of what's visible on screen, for the "👁 eye" zone. */
function updateVisibleCells(snap: CameraSnapshot): void {
  const n = editStore.liveDoc?.size ?? currentMap.value?.size ?? 0;
  if (!n) return viewStore.setVisibleCells(null);
  const corners: [number, number][] = [
    [snap.x, snap.y],
    [snap.x + snap.width, snap.y],
    [snap.x, snap.y + snap.height],
    [snap.x + snap.width, snap.y + snap.height],
  ];
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const [wx, wy] of corners) {
    const c = worldToCell(wx, wy);
    if (c.x < mnx) mnx = c.x; if (c.y < mny) mny = c.y; if (c.x > mxx) mxx = c.x; if (c.y > mxy) mxy = c.y;
  }
  const x0 = Math.max(0, Math.floor(mnx)), y0 = Math.max(0, Math.floor(mny));
  const x1 = Math.min(n - 1, Math.ceil(mxx)), y1 = Math.min(n - 1, Math.ceil(mxy));
  if (x1 < x0 || y1 < y0) { viewStore.setVisibleCells(null); viewStore.setVisibleMask(null); return; }
  viewStore.setVisibleCells({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });

  // Precise visible cells (the iso diamond) — only when the eye zone is on (it's the only
  // consumer, and this is per-camera-move work). The bbox over-covers because a screen
  // rectangle maps to a diamond in cell space; the mask is what's actually on screen.
  if (!toolStore.eyeZone) { viewStore.setVisibleMask(null); return; }
  const HALF_W = 32, HALF_H = 16;
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (area > 16000) { viewStore.setVisibleMask(null); return; } // whole-map view: bbox is fine
  const mask: string[] = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const wx = (x - y) * HALF_W, wy = (x + y) * HALF_H + HALF_H; // cell centre (origin conv)
      if (wx >= snap.x && wx <= snap.x + snap.width && wy >= snap.y && wy <= snap.y + snap.height) mask.push(`${x},${y}`);
    }
  viewStore.setVisibleMask(mask);
}

/** Map a pointer event to a cell, or null when off-map. */
function cellFromEvent(e: PointerEvent): { x: number; y: number } | null {
  const scene = getScene();
  const cam = scene?.getCamera();
  const doc = currentMap.value;
  const canvas = scene?.canvas;
  if (!cam || !doc || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const world = cam.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  const frac = worldToCell(world.x, world.y);
  // cellToWorld(x,y) is the cell's TOP vertex (editor origin convention), so a cell
  // spans frac [x,x+1) — floor() picks the cell the point falls in.
  const x = Math.floor(frac.x);
  const y = Math.floor(frac.y);
  return x >= 0 && y >= 0 && x < doc.size && y < doc.size ? { x, y } : null;
}

/** Event point in WORLD units + how many world units `px` screen pixels span (zoom-aware) —
 *  for pixel-tolerance hit tests against world-space anchors (the location resize handle). */
function worldFromEvent(e: PointerEvent, px = 12): { x: number; y: number; tol: number } | null {
  const scene = getScene();
  const cam = scene?.getCamera();
  const canvas = scene?.canvas;
  if (!cam || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const w = cam.screenToWorld(sx, sy);
  const w2 = cam.screenToWorld(sx + px, sy);
  return { x: w.x, y: w.y, tol: Math.abs(w2.x - w.x) };
}

// --- terrain painting --------------------------------------------------------
let painting = false;
let strokeOps: EditOp[] = [];
/** Press position for the select tool (to tell a click from a pan-drag). */
let selDown: { x: number; y: number } | null = null;
/** Shift+drag rubber-band start cell (select tool multi-select frame); null = not banding. */
let boxSelStart: { x: number; y: number } | null = null;
/** Last hovered cell (null = off-map); used to refresh the decor ghost on cycle. */
let lastCell: { x: number; y: number } | null = null;

// --- locations tool («режим локаций») + hover spotlight ----------------------
/** Press state: click (no drag) cycles the pick; a drag ≥1 cell moves the location. */
let locDown: { cell: { x: number; y: number }; locs: MapObject[]; zids: string[] } | null = null;
let locDragId: string | null = null;
let locDragging = false;
/** «Локации»: drag of the SELECTED location's corner handle = radius resize. */
let locResize: { id: string; lastR: number } | null = null;
/** «Локации»: drag of a whole ZONE (every primitive + the mask move together). */
let zoneDrag: { zid: string; start: { x: number; y: number }; moved: boolean } | null = null;

// ---- free-form ZONES as one entity -------------------------------------------------------
// A zone's location primitives are HIDDEN from LocationLayer/roles (they'd read as N circles);
// ZoneLayer draws the zone as one shape instead, and the locations tool picks/drags the whole.
/** locId → zoneId for every live zone primitive. */
function zoneByLoc(): Map<string, string> {
  const m = new Map<string, string>();
  for (const [zid, z] of Object.entries(editStore.zones))
    for (const id of z.locIds) m.set(id, zid);
  return m;
}
/** Zone visuals for the scene: mask + name (+ aggregated roles/summaries in locations mode). */
function zoneVisuals(): ZoneVisual[] {
  const doc = editStore.liveDoc;
  if (!doc) return [];
  const inLocMode = toolStore.tool === "locations";
  const counts = inLocMode ? locationRoleCounts(doc) : null;
  const sums = inLocMode ? locationSummaries(doc) : null;
  return Object.entries(editStore.zones).map(([zid, z]) => {
    let badges: string | undefined;
    let summary: string[] | undefined;
    if (counts) {
      const agg: RoleCounts = { trigger: 0, spawn: 0, destination: 0, env: 0 };
      for (const id of z.locIds) {
        const c = counts[id];
        if (c) {
          agg.trigger += c.trigger;
          agg.spawn += c.spawn;
          agg.destination += c.destination;
          agg.env += c.env;
        }
      }
      badges = formatRoleBadges(agg) || undefined;
    }
    if (sums) {
      const uniq: string[] = [];
      for (const id of z.locIds)
        for (const line of sums[id] ?? []) if (!uniq.includes(line)) uniq.push(line);
      if (uniq.length) {
        summary = uniq.slice(0, 2);
        if (uniq.length > 2) summary.push(`… ещё ${uniq.length - 2}`);
      }
    }
    return {
      id: zid,
      name: z.name,
      cells: z.cells,
      selected: toolStore.selectedZoneId === zid,
      badges,
      summary,
    };
  });
}
/** Clamp a zone shift so every mask cell stays inside the map (tiles ⊆ mask ⇒ safe). */
function clampZoneShift(cells: ReadonlyArray<string>, dx: number, dy: number, size: number): [number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number);
    minX = Math.min(minX, x!); minY = Math.min(minY, y!);
    maxX = Math.max(maxX, x!); maxY = Math.max(maxY, y!);
  }
  return [
    Math.max(-minX, Math.min(dx, size - 1 - maxX)),
    Math.max(-minY, Math.min(dy, size - 1 - maxY)),
  ];
}
/** Role counts with zone primitives dropped — the zone title carries them aggregated. */
function zoneFilteredRoleCounts(doc: MapDocument): Record<string, RoleCounts> {
  const counts = locationRoleCounts(doc);
  for (const id of zoneByLoc().keys()) delete counts[id];
  return counts;
}
/** Push zone visuals + the primitive-hiding list to the scene (with location labels). */
function refreshZonesAndLocations(): void {
  const s = getScene();
  const doc = editStore.liveDoc;
  if (!s || !doc) return;
  s.updateLocations(doc, {
    captions: editStore.captions,
    selectedId: toolStore.selectedId,
    summaries: toolStore.tool === "locations" ? locationSummaries(doc) : undefined,
    hideIds: [...zoneByLoc().keys()],
  });
  s.updateZones(zoneVisuals());
}
/** Last hovered cell key for the location spotlight (avoid re-computing per pixel). */
let hoverKey: string | null = null;

/** Ids of every location whose area covers the cell (the hover spotlight set). */
function locationIdsAtCell(cx: number, cy: number): string[] {
  const doc = editStore.liveDoc;
  if (!doc) return [];
  const ids: string[] = [];
  for (const o of doc.objects) {
    if (o.type !== "location") continue;
    const r = o.radius ?? 0;
    if (cx >= o.pos.x - r && cx <= o.pos.x + r && cy >= o.pos.y - r && cy <= o.pos.y + r) {
      ids.push(o.id);
    }
  }
  return ids;
}

// --- «Локации»-tool role filter: full role lists cached per objectsRev ------------------
let locRolesRev = -1;
let locRolesCache: Map<string, ObjectRole[]> = new Map();
function locRoles(): Map<string, ObjectRole[]> {
  const doc = editStore.liveDoc;
  if (!doc) return locRolesCache;
  if (locRolesRev !== editStore.objectsRev) {
    locRolesCache = computeObjectRoles(doc);
    locRolesRev = editStore.objectsRev;
  }
  return locRolesCache;
}

/** Event-wired NON-location objects (отряд-цель, город-триггер, сайт…) as plain markers
 *  for the roles overlay: anchored footprint + per-class counts. Reuses the cached roles. */
function objectRoleMarkers(doc: MapDocument): ObjectRoleMarker[] {
  const roles = locRoles();
  const out: ObjectRoleMarker[] = [];
  for (const o of doc.objects) {
    if (o.type === "location") continue;
    const c = countsOf(roles.get(o.id));
    if (!c) continue;
    const { w, h } = objectFootprint(o, landmarkFootprints);
    out.push({ id: o.id, x: o.pos.x, y: o.pos.y, w, h, counts: c });
  }
  return out;
}
/** Does a location pass the active «Локации»-tool role filter? (all = no filter;
 *  триггер-подтипы enter/stackIn/itemTo матчатся по KIND, остальное — по классу роли). */
function locMatchesFilter(id: string): boolean {
  return rolesMatchFilter(locRoles().get(id), toolStore.locFilter);
}
/** The filter set (matching location ids) or null when inactive/off-tool. */
function locFilterSet(): string[] | null {
  if (toolStore.tool !== "locations" || toolStore.locFilter === "all") return null;
  const doc = editStore.liveDoc;
  if (!doc) return null;
  return doc.objects.filter((o) => o.type === "location" && locMatchesFilter(o.id)).map((o) => o.id);
}

/** Hover spotlight: locations under the cursor light up (rings + names), the rest fade.
 *  With the «Локации»-tool role filter active, the spotlight is constrained to matching
 *  locations — and with NO hover the whole matching set stays lit (все прочие гаснут).
 *  Recomputed only when the hovered CELL changes; off-map falls back to the filter set. */
function updateLocationFocus(cell: { x: number; y: number } | null, force = false): void {
  const key = cell ? `${cell.x},${cell.y}` : null;
  if (!force && key === hoverKey) return;
  hoverKey = key;
  const s = getScene();
  if (!s) return;
  const filter = locFilterSet();
  if (cell && (locationsVisible.value || viewStore.rolesVisible)) {
    let ids = locationIdsAtCell(cell.x, cell.y);
    if (filter) {
      const set = new Set(filter);
      ids = ids.filter((id) => set.has(id));
      // hovering empty/non-matching cells keeps the filtered set lit (steady context)
      s.setLocationFocus(ids.length ? ids : filter);
    } else {
      s.setLocationFocus(ids.length ? ids : null);
    }
  } else {
    s.setLocationFocus(filter);
  }
}

// --- region select (zone for Copilot generation) -----------------------------
let regionDragging = false;
let regionStart: { x: number; y: number } | null = null;
/** Accumulated cell mask for the brush mode (built across a drag). */
let regionMaskAccum = new Set<string>();
/** Normalised rectangle (inclusive) from two corner cells. */
function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x) + 1,
    h: Math.abs(a.y - b.y) + 1,
  };
}
/** Cells of a square brush of side `side` centred at (cx,cy). */
function squareCells(cx: number, cy: number, side: number): { x: number; y: number }[] {
  const r = Math.floor(side / 2);
  const out: { x: number; y: number }[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.push({ x: cx + dx, y: cy + dy });
  return out;
}
/** Cells along a (thick) straight line a→b (Bresenham + square stamp) — the "line" mode. */
function lineMask(a: { x: number; y: number }, b: { x: number; y: number }, side: number): Set<string> {
  const out = new Set<string>();
  let x0 = a.x, y0 = a.y;
  const x1 = b.x, y1 = b.y;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    for (const c of squareCells(x0, y0, side)) out.add(`${c.x},${c.y}`);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
  return out;
}
/** Perimeter cells of a rectangle — the "frame" mode. */
function frameMask(r: { x: number; y: number; w: number; h: number }): Set<string> {
  const out = new Set<string>();
  for (let x = r.x; x < r.x + r.w; x++) { out.add(`${x},${r.y}`); out.add(`${x},${r.y + r.h - 1}`); }
  for (let y = r.y; y < r.y + r.h; y++) { out.add(`${r.x},${y}`); out.add(`${r.x + r.w - 1},${y}`); }
  return out;
}
/** Bounding box of a set of "x,y" cells. */
function bboxOfMask(cells: Iterable<string>): { x: number; y: number; w: number; h: number } {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    if (x < mnx) mnx = x; if (y < mny) mny = y; if (x > mxx) mxx = x; if (y > mxy) mxy = y;
  }
  return { x: mnx, y: mny, w: mxx - mnx + 1, h: mxy - mny + 1 };
}
/** "x,y" cells -> in-bounds CellRefs for the footprint overlay. */
function maskRefs(cells: Iterable<string>): { x: number; y: number }[] {
  const n = editStore.liveDoc?.size ?? currentMap.value?.size ?? 0;
  const out: { x: number; y: number }[] = [];
  for (const k of cells) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    if (x >= 0 && y >= 0 && x < n && y < n) out.push({ x, y });
  }
  return out;
}
/** Re-render the persistent generation zone (drawn mask if any, else the bbox) — faint, hideable. */
function showZone(): void {
  const s = getScene();
  if (!s) return;
  if (toolStore.zoneHidden) { s.setFootprint([]); return; }
  const mask = toolStore.regionMask;
  if (mask && mask.length) { s.setFootprint(maskRefs(mask), true, true); return; }
  const r = toolStore.region;
  s.setFootprint(r ? footprintCells(r.x, r.y, r.w, r.h) : [], true, true);
}

// --- decoration placement (decor tool) ---------------------------------------
/** Footprint in cells. MOMNE mountains are square (verified across all game maps),
 *  with w encoded in the id (chars 5-6); landmarks use the catalog cx/cy. */
function decorFootprint(entry: DecorEntry): { w: number; h: number } {
  if (entry.id.startsWith("MOMNE")) {
    const w = parseInt(entry.id.slice(5, 7), 10) || 1;
    return { w, h: w };
  }
  return { w: entry.cx || 1, h: entry.cy || 1 };
}

/** EditOps to place a decoration at (cx,cy): MidMountains for MOMNE, else a landmark. */
function decorPlaceOps(entry: DecorEntry, cx: number, cy: number): EditOp[] {
  const doc = editStore.liveDoc;
  if (!doc) return [];
  if (entry.id.startsWith("MOMNE")) {
    const w = parseInt(entry.id.slice(5, 7), 10) || 1;
    const image = parseInt(entry.id.slice(7, 9), 10) || 0;
    return placeMountainOps(doc, cx, cy, w, w, image);
  }
  return placeLandmarkOps(doc, cx, cy, entry.id);
}

// --- object move (move tool) -------------------------------------------------
/** Is the cell water (ground bits == 3)? */
function isWaterCell(x: number, y: number): boolean {
  const doc = editStore.liveDoc;
  if (!doc) return false;
  const c = doc.terrain.cells[y * doc.size + x];
  return c ? ((c.value >> 3) & 7) === 3 : false;
}

/** The primary sprite atlas key for an object's ghost — derived the SAME way the renderer
 *  draws it (objectSprites accessor port), so a chest/treasure/ruin/site/fort all preview.
 *  Returns null for non-drawables (garrisoned stack) or unresolved data — footprint still shows. */
function objectGhostKey(obj: MapObject, cell: { x: number; y: number } | null): string | null {
  try {
    const subs = objectSprites(obj, {
      graceFortCodes: spriteTables?.graceFortCodes,
      graceRaceType: spriteTables?.graceRaceType,
      unitBoat: spriteTables?.unitBoat,
      water: cell ? isWaterCell(cell.x, cell.y) : false,
    });
    return subs.length ? subs[0]!.key : null;
  } catch {
    return null; // missing accessor data -> footprint-only preview
  }
}

/** The centered cell span of a location's drawn area — (2r+1)² around its center pos, matching
 *  LocationLayer's highlight (NOT objectFootprint, which is the editor's r×r placement box). */
function locationCells(o: MapObject): { x: number; y: number }[] {
  const r = o.type === "location" ? (o.radius ?? 0) : 0;
  return footprintCells(o.pos.x - r, o.pos.y - r, 2 * r + 1, 2 * r + 1);
}

/**
 * Every selectable object whose footprint covers (cx,cy), in pick-priority order: concrete
 * objects first (topmost painter-z first), then location overlays (smaller/more specific area
 * first). Index 0 is what a plain click selects; Shift steps one level down the list — so a
 * location overlapping a building, or two overlapping locations, can both be reached.
 */
function objectsAtCell(cx: number, cy: number): MapObject[] {
  const doc = editStore.liveDoc;
  if (!doc) return [];
  const concrete: { o: MapObject; z: number }[] = [];
  const locs: { o: MapObject; z: number }[] = [];
  for (const o of doc.objects) {
    if (o.type === "location") {
      const r = o.radius ?? 0; // centered (2r+1)² area, like the drawn highlight
      if (cx >= o.pos.x - r && cx <= o.pos.x + r && cy >= o.pos.y - r && cy <= o.pos.y + r) {
        locs.push({ o, z: -r }); // a smaller location ranks above the bigger one it sits in
      }
      continue;
    }
    if (!VISIBLE_OBJECT_TYPES.has(o.type)) continue;
    // A garrisoned stack (a hero stationed INSIDE a fort/capital) is not drawn and sits on the
    // fort's origin cell — never hit-test it, or a click on the fort grabs the invisible stack.
    if (o.type === "stack" && o.garrisoned) continue;
    const { w, h } = objectFootprint(o, landmarkFootprints);
    if (cx >= o.pos.x && cx < o.pos.x + w && cy >= o.pos.y && cy < o.pos.y + h) {
      concrete.push({ o, z: objectZBase(o) + o.pos.x + o.pos.y + h });
    }
  }
  concrete.sort((a, b) => b.z - a.z);
  locs.sort((a, b) => b.z - a.z);
  return [...concrete.map((c) => c.o), ...locs.map((l) => l.o)];
}

/** Pick from the covering candidates: plain click → topmost; Alt (`below`) → one level
 *  below the current selection (cycling), so overlapping objects/locations can be reached.
 *  (Shift is the MULTI-SELECT modifier now — the cycle moved to Alt everywhere.) */
function pickAtCell(cx: number, cy: number, below: boolean): MapObject | null {
  const list = objectsAtCell(cx, cy);
  if (!list.length) return null;
  if (!below) return list[0]!;
  const i = list.findIndex((o) => o.id === toolStore.selectedId);
  return list[(i + 1) % list.length]!;
}

/** The in-bounds cells of a w×h footprint anchored at (cx,cy). */
function footprintCells(cx: number, cy: number, w: number, h: number): { x: number; y: number }[] {
  const n = editStore.liveDoc?.size ?? currentMap.value?.size ?? 0;
  const out: { x: number; y: number }[] = [];
  for (let y = cy; y < cy + h; y++)
    for (let x = cx; x < cx + w; x++) if (x >= 0 && y >= 0 && x < n && y < n) out.push({ x, y });
  return out;
}

/** Clear both placement previews (sprite ghost + footprint diamonds). */
function clearPreview(): void {
  const s = getScene();
  s?.setGhost(null);
  s?.setFootprint([]);
}

// --- placement validity (ported from d2mapeditorqt PlaceObjectTool/ObjectMoveTool) ----
// Rule: a footprint is valid iff every cell is in bounds AND not occupied by ANOTHER
// object's footprint (terrain — water/mountain/forest/roads — never blocks). Occupancy is
// the union of all object footprints, cached and rebuilt only when objects change.
let occRev = -1;
let occMap = new Map<string, Set<string>>();
function occupancy(): Map<string, Set<string>> {
  const doc = editStore.liveDoc;
  if (!doc) return occMap;
  if (occRev === editStore.objectsRev) return occMap;
  const m = new Map<string, Set<string>>();
  const n = doc.size;
  for (const o of doc.objects) {
    // editor occupancy (objBinging) excludes locations (separate locationsBinging) and
    // units (leaders inside stacks, not independently grid-placed). A garrisoned stack lives
    // on its fort's origin cell (not independently placed) — it must not block the fort's move.
    if (o.type === "location" || o.type === "unit") continue;
    if (o.type === "stack" && o.garrisoned) continue;
    const { w, h } = objectFootprint(o, landmarkFootprints);
    for (let y = o.pos.y; y < o.pos.y + h; y++)
      for (let x = o.pos.x; x < o.pos.x + w; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const k = `${x},${y}`;
        let s = m.get(k);
        if (!s) {
          s = new Set();
          m.set(k, s);
        }
        s.add(o.id);
      }
  }
  occMap = m;
  occRev = editStore.objectsRev;
  return occMap;
}

/** Can a w×h footprint be placed at (cx,cy)? Bounds + no other object occupies it
 *  (`exclude` = the object(s) being moved, which may overlap their own cells). */
function canPlaceFootprint(cx: number, cy: number, w: number, h: number, exclude?: string | ReadonlySet<string>): boolean {
  const doc = editStore.liveDoc;
  if (!doc || w <= 0 || h <= 0) return false;
  const n = doc.size;
  const occ = occupancy();
  const excluded = (id: string): boolean =>
    typeof exclude === "string" ? id === exclude : exclude ? exclude.has(id) : false;
  for (let y = cy; y < cy + h; y++)
    for (let x = cx; x < cx + w; x++) {
      if (x < 0 || y < 0 || x >= n || y >= n) return false;
      const s = occ.get(`${x},${y}`);
      if (s) for (const id of s) if (!excluded(id)) return false;
    }
  return true;
}

/**
 * Anchored-group move check: every member of the group placed at (its pos + delta) must be
 * in bounds and free of NON-group occupancy. Locations skip the occupancy test (they overlap
 * by design) but still respect the map bounds. Returns null when the whole group fits, else
 * the id of the first offender (for messaging).
 */
function groupMoveBlocked(group: readonly string[], dx: number, dy: number): string | null {
  const doc = editStore.liveDoc;
  if (!doc) return group[0] ?? null;
  const ids = new Set(group);
  for (const id of group) {
    const o = doc.objects.find((x) => x.id === id);
    if (!o) continue;
    const nx = o.pos.x + dx;
    const ny = o.pos.y + dy;
    if (o.type === "location") {
      const r = o.radius ?? 0;
      if (nx - r < 0 || ny - r < 0 || nx + r >= doc.size || ny + r >= doc.size) return id;
      continue;
    }
    const { w, h } = objectFootprint(o, landmarkFootprints);
    if (!canPlaceFootprint(nx, ny, w, h, ids)) return id;
  }
  return null;
}

/**
 * Show/refresh the placement/move preview at `cell`: a translucent sprite ghost (when a
 * sprite key is derivable) PLUS a footprint "fitting" outline (always — so even a camp /
 * fort / site shows exactly where it will land, green=valid, red=out of bounds).
 */
function refreshGhost(cell: { x: number; y: number } | null): void {
  const s = getScene();
  if (!s) return;
  const doc = editStore.liveDoc;
  if (toolStore.tool === "decor") {
    const entry = decorStore.get(toolStore.decorId);
    if (!entry || !cell || !doc) return clearPreview();
    const { w, h } = decorFootprint(entry);
    const valid = canPlaceFootprint(cell.x, cell.y, w, h);
    s.setGhost(entry.id, cell, { w, h }, valid);
    s.setFootprint(footprintCells(cell.x, cell.y, w, h), valid);
    return;
  }
  if (toolStore.tool === "object") {
    if (!cell || !doc) return clearPreview();
    const ops = buildPlaceOps(toolStore.objectKind, cell.x, cell.y);
    const obj = (ops[0] as Extract<EditOp, { kind: "addObject" }> | undefined)?.object;
    if (!obj) return clearPreview();
    const { w, h } = objectFootprint(obj, landmarkFootprints);
    const waterBad = obj.type === "village" &&
      footprintCells(cell.x, cell.y, w, h).some((c) => isWaterCell(c.x, c.y));
    const valid = !waterBad && canPlaceFootprint(cell.x, cell.y, w, h);
    s.setGhost(objectGhostKey(obj, cell), cell, { w, h }, valid); // null key => footprint only
    s.setFootprint(footprintCells(cell.x, cell.y, w, h), valid);
    return;
  }
  if (toolStore.tool === "move" && toolStore.moveId) {
    const obj = doc?.objects.find((o) => o.id === toolStore.moveId);
    if (!obj || !cell || !doc) return clearPreview();
    if (obj.type === "location") {
      const r = obj.radius ?? 0; // centered area follows the cursor; always a valid drop
      s.setGhost(null, cell);
      s.setFootprint(footprintCells(cell.x - r, cell.y - r, 2 * r + 1, 2 * r + 1), true);
      return;
    }
    const { w, h } = objectFootprint(obj, landmarkFootprints);
    const valid = canPlaceFootprint(cell.x, cell.y, w, h, toolStore.moveId ?? undefined);
    s.setGhost(objectGhostKey(obj, cell), cell, { w, h }, valid); // null key => footprint only
    s.setFootprint(footprintCells(cell.x, cell.y, w, h), valid);
    return;
  }
  clearPreview();
}

function brushKind(): BrushKind | null {
  switch (toolStore.tool) {
    case "terrain": return { type: "terrain", terrain: toolStore.terrainId };
    case "water": return { type: "water" };
    case "forest": return { type: "forest" };
    case "erase": return { type: "erase" };
    default: return null;
  }
}

// Occupied-cells cache for the brush mechanics guard (water/forest never paint under an
// object; land paints skip occupied water). Rebuilt only when the OBJECT set changes.
let occupiedCache: { rev: number; set: Set<string> } | null = null;
function occupiedCells(doc: MapDocument): Set<string> {
  if (!occupiedCache || occupiedCache.rev !== editStore.objectsRev) {
    occupiedCache = {
      rev: editStore.objectsRev,
      set: buildOccupiedSet(doc, landmarkFootprints as Record<string, readonly [number, number]>),
    };
  }
  return occupiedCache.set;
}

/** Apply the brush at a cell against the LIVE doc (preview); accumulate stroke ops. */
function paintAt(cx: number, cy: number): void {
  const doc = editStore.liveDoc;
  if (!doc) return;
  let ops: EditOp[];
  if (toolStore.tool === "road") {
    ops = roadBrush(doc, cx, cy); // connectivity-based, ignores brush size; skips water
  } else if (toolStore.tool === "erase") {
    ops = eraseBrush(doc, cx, cy, toolStore.size, occupiedCells(doc)); // clears terrain + roads (+ neighbour recompute)
    // the eraser also removes DECOR (landmarks) under the brush — an honest deleteObject
    // (M4 block splice on export). Other object types stay (writer support is per-type).
    const half = Math.floor(toolStore.size / 2);
    for (const o of doc.objects) {
      if (o.type !== "landmark") continue;
      const { w, h } = objectFootprint(o, landmarkFootprints);
      const hit =
        o.pos.x <= cx + half && o.pos.x + w > cx - half &&
        o.pos.y <= cy + half && o.pos.y + h > cy - half;
      if (hit) ops.push({ kind: "deleteObject", id: o.id });
    }
  } else {
    const kind = brushKind();
    if (!kind) return;
    ops = terrainBrush(doc, cx, cy, toolStore.size, kind, occupiedCells(doc));
  }
  if (ops.length) {
    editStore.applyPreview(ops);
    strokeOps.push(...ops);
  }
}

// road-select: re-clicking the same anchor cell bumps the level (segment -> strand -> net).
// (the roadsel anchor/level live in toolStore — shared with the floating RoadActionBar)
/** roadsel drag state: press INSIDE the selection starts a MOVE (interior cell) or an
 *  EXTEND (endpoint cell, ≤1 selected neighbour); a press without movement falls back
 *  to the classic click behavior (same-cell level bump) on pointerup. */
let roadDrag: { kind: "move" | "extend"; start: { x: number; y: number }; last: { x: number; y: number }; moved: boolean } | null = null;

// ---- right-click context menu + anchor-pick mode ("Заякорить к…") -------------------------
/** Open context menu: screen position + the object it targets (obj=null → the EMPTY-cell
 *  placement menu at `cell`). */
const ctxMenu = ref<{ x: number; y: number; obj: MapObject | null; cell: { x: number; y: number } } | null>(null);
/** While set, the NEXT left click picks the anchor PARENT for this child id. */
const anchorPickFor = ref<string | null>(null);

/** Double click = ВЗЯТЬ объект в перенос (инспектор уже открыт первым кликом двойного;
 *  локации переносятся драгом в своём инструменте — для них dblclick остаётся выбором). */
function onDblClick(e: MouseEvent): void {
  const cell = cellFromEvent(e as PointerEvent);
  if (!cell) return;
  const hit = pickAtCell(cell.x, cell.y, e.altKey);
  if (!hit) return;
  // don't COLLAPSE a multi-selection when double-clicking one of its members — the whole
  // group is picked up (the move drop unions selectedIds with anchor groups).
  if (!toolStore.selectedIds.includes(hit.id)) toolStore.setSelectedId(hit.id);
  if (hit.type === "location") return;
  // pick it up for moving: same state the Move tool's first click would set. Order matters
  // less than it looks (the [decorId, moveId] watcher re-runs refreshGhost either way), but
  // setMoveId-then-setTool avoids a ghost refresh with a null id.
  toolStore.setMoveId(hit.id);
  toolStore.setTool("move");
}

/** Right click = context menu: the object under the cursor, or the EMPTY-cell placement menu. */
function onContextMenu(e: MouseEvent): void {
  e.preventDefault();
  anchorPickFor.value = null;
  const cell = cellFromEvent(e as PointerEvent);
  if (!cell) { ctxMenu.value = null; return; }
  const hit = pickAtCell(cell.x, cell.y, e.altKey);
  ctxMenu.value = { x: e.clientX, y: e.clientY, obj: hit, cell };
}

/** EditOps to place an interactive object of `kind` at (x,y); [] when not buildable yet
 *  (unit catalog still loading for a stack). Shared by the «Объекты» tool, its ghost
 *  preview, and the right-click «Поставить здесь» menu. */
function buildPlaceOps(kind: PlaceObjectKind, x: number, y: number): EditOp[] {
  const doc = editStore.liveDoc;
  if (!doc) return [];
  switch (kind) {
    case "village": return placeVillageOps(doc, x, y, "Новая деревня", 1);
    case "treasure": return placeChestOps(doc, x, y, 0, []);
    case "ruin": return placeRuinOps(doc, x, y, 0);
    case "merchant": case "mage": case "trainer": case "mercenary":
      return placeSiteOps(doc, x, y, kind);
    case "stack": {
      // leader = the tool's picked leader, else the first hero (L_LEADER) from the catalog
      const picked = toolStore.stackLeaderId ? unitStore.get(toolStore.stackLeaderId) : undefined;
      const hero = picked ?? unitStore.all
        .filter((u) => u.catKey === "L_LEADER")
        .sort((a, b) => a.name.localeCompare(b.name, "ru"))[0];
      if (!hero) return [];
      return placeStackOps(doc, x, y, {
        units: [null, null, { unit: hero.id, level: hero.level, hp: hero.hp }, null, null, null],
        leaderCell: 2,
      });
    }
  }
}

/** Place an interactive object at a cell: footprint + water guard → commit → select in the
 *  inspector. Returns false (with a toast) when the spot is invalid. */
function placeObjectAt(kind: PlaceObjectKind, x: number, y: number): boolean {
  const ops = buildPlaceOps(kind, x, y);
  const obj = (ops[0] as Extract<EditOp, { kind: "addObject" }> | undefined)?.object;
  if (!obj) {
    if (kind === "stack") ElMessage.warning("Каталог юнитов ещё загружается — попробуйте через секунду");
    return false;
  }
  const { w, h } = objectFootprint(obj, landmarkFootprints);
  if (!canPlaceFootprint(x, y, w, h)) {
    ElMessage.warning(w > 1 ? `Не помещается: нужно ${w}×${h} свободных клеток` : "Клетка занята");
    return false;
  }
  // города на воде нелегальны (подводные клады/затонувшие руины/лодки — легальны)
  if (obj.type === "village" && footprintCells(x, y, w, h).some((c) => isWaterCell(c.x, c.y))) {
    ElMessage.warning("Город нельзя ставить на воду");
    return false;
  }
  editStore.commit(ops);
  toolStore.setSelectedId(obj.id);
  return true;
}

/** Empty-cell placement («Поставить здесь») from the right-click menu. */
function placeAction(kind: PlaceObjectKind): void {
  const at = ctxMenu.value?.cell;
  ctxMenu.value = null;
  if (!at) return;
  if (placeObjectAt(kind, at.x, at.y)) ElMessage.success("Поставлено — свойства в инспекторе справа");
}

function ctxAction(action: string): void {
  const obj = ctxMenu.value?.obj;
  ctxMenu.value = null;
  if (!obj) return;
  switch (action) {
    case "props":
      toolStore.setSelectedId(obj.id);
      break;
    // scenario shortcuts: the map and the events window work as one surface
    case "events":
      eventStore.objectFilter = obj.id;
      eventStore.panelTab = "events";
      if (!viewStore.eventPanelVisible) viewStore.toggleEventPanel();
      break;
    case "spawnHere": {
      // one-click spawn trigger for a location (day-1 frequency + createStack pre-wired)
      eventStore.createSpawnAt(obj.id, (obj as { name?: string }).name);
      if (!viewStore.eventPanelVisible) viewStore.toggleEventPanel();
      ElMessage.success("Событие спавна создано — выберите шаблон отряда в редакторе");
      break;
    }
    case "newEvent": {
      const ev = eventStore.createForObject(
        obj.id, obj.type, (obj as { name?: string }).name,
      );
      eventStore.panelTab = "events";
      eventStore.select(ev.id);
      if (!viewStore.eventPanelVisible) viewStore.toggleEventPanel();
      ElMessage.success("Событие создано и привязано к объекту");
      break;
    }
    case "copyId":
      void navigator.clipboard.writeText(obj.id).then(
        () => ElMessage.success(`id скопирован: ${obj.id}`),
        () => ElMessage.info(obj.id),
      );
      break;
    case "anchor":
      anchorPickFor.value = obj.id; // next click picks the parent
      if (!viewStore.anchorsVisible) viewStore.toggleAnchors(); // show the links overlay
      ElMessage.info("Кликните объект-родитель для якоря (Esc — отмена)");
      break;
    case "unanchor":
      editStore.clearAnchor(obj.id);
      ElMessage.success("Якорь снят");
      break;
    case "links":
      viewStore.toggleAnchors();
      break;
    case "delete":
      deleteObjectSafely(obj);
      break;
    case "roadAnchor": {
      const on = editStore.toggleRoadAnchor(obj.id);
      ElMessage.success(
        on
          ? "Дорога следует за входом: при переносе города дорога перепроложится к новому входу"
          : "Дорога больше не следует за городом",
      );
      break;
    }
  }
}

/** Delete an object, routing by type: mountains need the renumber batch (deleteMountainOps),
 *  a city's visiting hero can't be map-deleted (edit it via the city), a village hosting a
 *  visitor must part with the hero first, the rest are a plain block splice (garrison/item
 *  cascades happen in the byte writer). Export runs the 3-tier validator — fail-closed. */
function deleteObjectSafely(obj: MapObject): void {
  const doc = editStore.liveDoc;
  if (!doc) return;
  if (obj.type === "mountains") {
    editStore.commit(deleteMountainOps(doc, obj.id));
    return;
  }
  if (obj.type === "stack" && ((obj as { inside?: string }).inside || (obj as { garrisoned?: boolean }).garrisoned)) {
    ElMessage.warning("Это гость города — удалите/замените героя через свойства города");
    return;
  }
  if (obj.type === "village" && (obj as { stackRef?: string }).stackRef) {
    ElMessage.warning("В городе герой-гость — сначала уберите его (свойства города)");
    return;
  }
  editStore.commit([{ kind: "deleteObject", id: obj.id }]);
}

/** Complete the anchor-pick: `parent` = the clicked object. */
function finishAnchorPick(parent: MapObject): void {
  const child = anchorPickFor.value;
  anchorPickFor.value = null;
  if (!child || child === parent.id) return;
  if (editStore.setAnchor(child, parent.id)) {
    ElMessage.success("Заякорено — перенос родителя тянет всю связку");
  } else {
    ElMessage.warning("Нельзя: цикл якорей");
  }
}

/** Esc closes the context menu and cancels pending anchor/object picks. */
function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (ctxMenu.value) ctxMenu.value = null;
  if (anchorPickFor.value) {
    anchorPickFor.value = null;
    ElMessage.info("Якорение отменено");
  }
  if (toolStore.objectPickTypes) {
    toolStore.finishObjectPick(null);
    ElMessage.info("Выбор на карте отменён");
  }
  if (locResize) {
    locResize = null; // drop the radius drag without committing
    clearPreview();
  }
  if (zoneDrag) {
    zoneDrag = null; // drop the zone drag without committing
    clearPreview();
  }
}

function onPointerDown(e: PointerEvent): void {
  ctxMenu.value = null; // any left press dismisses the context menu
  // «🎯 выбрать на карте»: this click picks an object for a pending event ref-field
  if (toolStore.objectPickTypes) {
    const types = toolStore.objectPickTypes;
    const cell = cellFromEvent(e);
    const hit = cell
      ? objectsAtCell(cell.x, cell.y).find((o) => types.includes(o.type)) ?? null
      : null;
    if (hit) {
      toolStore.finishObjectPick(hit.id);
      ElMessage.success("Выбрано");
    } else {
      toolStore.finishObjectPick(null);
      ElMessage.info("Выбор отменён (тут нет подходящего объекта)");
    }
    return;
  }
  // anchor-pick mode: this click chooses the PARENT for the pending "Заякорить к…"
  if (anchorPickFor.value) {
    const cell = cellFromEvent(e);
    const hit = cell ? pickAtCell(cell.x, cell.y, e.altKey) : null;
    if (hit) finishAnchorPick(hit);
    else { anchorPickFor.value = null; ElMessage.info("Якорение отменено"); }
    return;
  }
  if (e.ctrlKey) return; // Ctrl+drag pans the camera (handled by Scene), not a tool action
  // region tool (Copilot generation zone) + zone tool («Зона» → локации-примитивы): both
  // draw a cell mask with the same rect/brush/line/frame pipeline; only the ACCEPT differs.
  if (toolStore.tool === "region" || toolStore.tool === "zone") {
    const cell = cellFromEvent(e);
    if (!cell) return;
    regionStart = cell;
    regionDragging = true;
    regionMaskAccum = new Set();
    if (toolStore.zoneMode === "brush") {
      for (const c of squareCells(cell.x, cell.y, toolStore.size)) regionMaskAccum.add(`${c.x},${c.y}`);
      getScene()?.setFootprint(maskRefs(regionMaskAccum), true);
    } else {
      getScene()?.setFootprint(footprintCells(cell.x, cell.y, 1, 1), true);
    }
    getScene()?.canvas?.setPointerCapture(e.pointerId);
    return;
  }
  // road-select tool: click a road to select its segment; click the same cell to grow.
  // A press INSIDE the selection starts a DRAG: interior cell = MOVE the whole segment,
  // endpoint (≤1 selected neighbour) = EXTEND with an L-path. No movement → classic click.
  if (toolStore.tool === "roadsel") {
    const cell = cellFromEvent(e);
    const doc = editStore.liveDoc;
    if (!cell || !doc) return;
    const inSel = toolStore.roadSel.some((c) => c.x === cell.x && c.y === cell.y);
    if (inSel) {
      const nbInSel = toolStore.roadSel.filter(
        (c) => Math.abs(c.x - cell.x) + Math.abs(c.y - cell.y) === 1,
      ).length;
      roadDrag = { kind: nbInSel <= 1 ? "extend" : "move", start: cell, last: cell, moved: false };
      getScene()?.canvas?.setPointerCapture(e.pointerId);
      return;
    }
    const a = toolStore.roadAnchor;
    if (a && a.x === cell.x && a.y === cell.y) {
      toolStore.roadLevel = Math.min(toolStore.roadLevel + 1, 2);
    } else {
      toolStore.roadAnchor = cell;
      toolStore.roadLevel = 0;
    }
    const sel = selectRoadSegment(doc, cell.x, cell.y, toolStore.roadLevel);
    toolStore.setRoadSel(sel); // an empty result clears the anchor inside setRoadSel
    return;
  }
  // decor tool: a single click stamps the picked decoration (no drag stroke).
  if (toolStore.tool === "decor") {
    const cell = cellFromEvent(e);
    const entry = decorStore.get(toolStore.decorId);
    if (cell && entry && editStore.liveDoc) {
      const { w, h } = decorFootprint(entry);
      if (canPlaceFootprint(cell.x, cell.y, w, h)) {
        const ops = decorPlaceOps(entry, cell.x, cell.y);
        if (ops.length) editStore.commit(ops); // objectsRev watcher re-renders objects
      }
    }
    return;
  }
  // object tool: a single click places the picked interactive object (руина/город/сундук/отряд/сайт).
  if (toolStore.tool === "object") {
    const cell = cellFromEvent(e);
    if (cell) placeObjectAt(toolStore.objectKind, cell.x, cell.y);
    return;
  }
  // move tool: 1st click picks the object (Shift = one level below, like select); 2nd click
  // drops it at the new cell. A location's center moves freely (it overlaps objects by design).
  if (toolStore.tool === "move") {
    const cell = cellFromEvent(e);
    if (!cell) return;
    if (!toolStore.moveId) {
      const hit = pickAtCell(cell.x, cell.y, e.altKey);
      if (hit) {
        toolStore.setMoveId(hit.id);
        refreshGhost(cell);
      }
    } else {
      const obj = editStore.liveDoc?.objects.find((o) => o.id === toolStore.moveId);
      if (obj) {
        const dx = cell.x - obj.pos.x;
        const dy = cell.y - obj.pos.y;
        // the moved GROUP = the multi-selection (when the carried object is part of it) +
        // every member's transitively anchored children, deduped — one delta, one stroke.
        // Otherwise just the carried object's anchor group (the pre-multiselect behavior).
        const seeds = toolStore.selectedIds.includes(obj.id) ? toolStore.selectedIds : [obj.id];
        const group = [...new Set(seeds.flatMap((id) => editStore.anchorGroup(id)))];
        const doc = editStore.liveDoc!;
        let moveOps: EditOp[] | null = null;
        if (group.length > 1) {
          if (dx !== 0 || dy !== 0) {
            if (groupMoveBlocked(group, dx, dy)) return; // не даём даже попытаться
            moveOps = group
              .map((id) => doc.objects.find((o) => o.id === id))
              .filter((o): o is NonNullable<typeof o> => !!o)
              .map((o) => ({ kind: "moveObject" as const, id: o.id, x: o.pos.x + dx, y: o.pos.y + dy }));
          }
        } else {
          if (obj.type !== "location") {
            const { w, h } = objectFootprint(obj, landmarkFootprints);
            // invalid drop (off-map / onto another object) -> keep carrying, like the editor
            if (!canPlaceFootprint(cell.x, cell.y, w, h, toolStore.moveId ?? undefined)) return;
          }
          if (dx !== 0 || dy !== 0) {
            moveOps = [{ kind: "moveObject", id: obj.id, x: cell.x, y: cell.y }];
          }
        }
        if (moveOps) {
          // «Дорога следует за входом»: for every moved fort with a roadAnchor, re-route
          // its attached strand (erase old-entrance..bend, extend bend → new entrance) —
          // planned SEQUENTIALLY against a working doc, committed WITH the move (one undo).
          const reroutes: EditOp[] = [];
          let planDoc = doc;
          for (const op of moveOps) {
            if (op.kind !== "moveObject" || !editStore.roadAnchors[op.id]) continue;
            const o = doc.objects.find((x) => x.id === op.id);
            if (!o || (o.type !== "village" && o.type !== "capital")) continue;
            const { w } = objectFootprint(o, landmarkFootprints);
            const ops = rerouteRoadOps(planDoc, o.pos, { x: op.x, y: op.y }, w);
            if (ops.length) {
              reroutes.push(...ops);
              planDoc = applyOps(planDoc, ops);
            }
          }
          // «Гость следует за городом»: a fort/capital's garrisoned visitor stack sits on the
          // fort's origin — carry it along by the same delta so the hero stays stationed inside.
          const moved = new Set(moveOps.map((op) => (op.kind === "moveObject" ? op.id : "")));
          const visitorMoves: EditOp[] = [];
          for (const op of moveOps) {
            if (op.kind !== "moveObject") continue;
            const o = doc.objects.find((x) => x.id === op.id);
            const ref = o && (o.type === "village" || o.type === "capital") ? o.stackRef : undefined;
            if (!o || !ref || moved.has(ref)) continue;
            const st = doc.objects.find((x) => x.id === ref);
            if (!st) continue;
            visitorMoves.push({ kind: "moveObject", id: st.id, x: st.pos.x + (op.x - o.pos.x), y: st.pos.y + (op.y - o.pos.y) });
          }
          editStore.commit([...moveOps, ...visitorMoves, ...reroutes]); // one stroke = one undo for everything
        }
      }
      toolStore.setMoveId(null);
      clearPreview();
    }
    return;
  }
  // locations tool («режим локаций»): pick ONLY locations — the world is veiled. A click
  // selects (re-click cycles the overlapping locations, smaller-first); drag ≥1 cell moves;
  // a press on the SELECTED location's corner handle starts a radius RESIZE drag.
  if (toolStore.tool === "locations") {
    const selLoc = editStore.liveDoc?.objects.find(
      (o) => o.id === toolStore.selectedId && o.type === "location",
    );
    if (selLoc) {
      const w = worldFromEvent(e);
      if (w) {
        const r = selLoc.radius ?? 0;
        const h = cellToWorld(selLoc.pos.x + r + 1, selLoc.pos.y + r + 1); // SE vertex = handle
        if (Math.hypot(w.x - h.x, w.y - h.y) <= w.tol) {
          locResize = { id: selLoc.id, lastR: r };
          getScene()?.canvas?.setPointerCapture(e.pointerId);
          return;
        }
      }
    }
    const cell = cellFromEvent(e);
    if (!cell) return;
    // the role filter constrains picking too: dimmed-out locations are not clickable.
    // ZONE primitives are hidden — the zone itself joins the pick ring after the locations
    // (click cycles: локация → … → зона → локация …); drag moves whatever is selected.
    const zbl = zoneByLoc();
    const locs = objectsAtCell(cell.x, cell.y).filter(
      (o) => o.type === "location" && !zbl.has(o.id) && locMatchesFilter(o.id),
    );
    const key = `${cell.x},${cell.y}`;
    const zids = Object.entries(editStore.zones)
      .filter(([, z]) => z.cells.includes(key))
      .map(([zid]) => zid);
    if (!locs.length && !zids.length) {
      toolStore.setSelectedId(null);
      toolStore.setSelectedZone(null);
      return;
    }
    // drag target: the SELECTED thing if it covers the cell (zone or location), else the
    // topmost location, else the first zone. Selection/cycling happens on pointerup.
    const selZoneHit = zids.find((z) => z === toolStore.selectedZoneId);
    const selLocHit = locs.find((o) => o.id === toolStore.selectedId);
    if (selZoneHit && !selLocHit) {
      zoneDrag = { zid: selZoneHit, start: cell, moved: false };
    } else if (locs.length) {
      locDragId = (selLocHit ?? locs[0]!).id;
      locDragging = false;
    } else {
      zoneDrag = { zid: zids[0]!, start: cell, moved: false };
    }
    locDown = { cell, locs, zids };
    getScene()?.canvas?.setPointerCapture(e.pointerId);
    return;
  }
  // select/inspect tool: remember the press; a click (no drag) on pointerup selects the
  // object under it (drag still pans the camera — we don't capture the pointer here).
  // SHIFT+press starts the multi-select RUBBER BAND instead (drag = frame, click = toggle).
  if (toolStore.tool === "select") {
    selDown = { x: e.clientX, y: e.clientY };
    if (e.shiftKey) {
      const cell = cellFromEvent(e);
      if (cell) {
        boxSelStart = cell;
        const s = getScene();
        s?.setPanEnabled(false); // the band owns this drag — камера не должна ехать следом
        s?.canvas?.setPointerCapture(e.pointerId);
      }
    }
    return;
  }
  const cell = cellFromEvent(e);
  if (!cell) return;
  painting = true;
  strokeOps = [];
  paintAt(cell.x, cell.y);
  getScene()?.canvas?.setPointerCapture(e.pointerId);
}

function onPointerUp(e: PointerEvent): void {
  // roadsel drag: commit the move/extend (or fall back to the classic same-cell click).
  if (roadDrag) {
    const drag = roadDrag;
    roadDrag = null;
    try { getScene()?.canvas?.releasePointerCapture(e.pointerId); } catch { /* released */ }
    const doc = editStore.liveDoc;
    if (!doc) return;
    if (!drag.moved) {
      // no movement — the classic click: same-cell = bump level, else reselect from here
      const a = toolStore.roadAnchor;
      if (a && a.x === drag.start.x && a.y === drag.start.y) {
        toolStore.roadLevel = Math.min(toolStore.roadLevel + 1, 2);
      } else {
        toolStore.roadAnchor = drag.start;
        toolStore.roadLevel = 0;
      }
      toolStore.setRoadSel(selectRoadSegment(doc, drag.start.x, drag.start.y, toolStore.roadLevel));
      return;
    }
    const target = drag.last;
    if (drag.kind === "move") {
      const dx = target.x - drag.start.x;
      const dy = target.y - drag.start.y;
      const ops = translateRoadCells(doc, toolStore.roadSel, dx, dy);
      if (ops.length) {
        editStore.commit(ops);
        const shifted = toolStore.roadSel.map((c) => ({ x: c.x + dx, y: c.y + dy }));
        const a = toolStore.roadAnchor;
        toolStore.setRoadSel(shifted);
        if (a) toolStore.roadAnchor = { x: a.x + dx, y: a.y + dy };
      } else {
        getScene()?.setRoadSelection(toolStore.roadSel); // aborted (off-map) — restore highlight
      }
      return;
    }
    // extend: draw the L-path from the grabbed endpoint to the drop cell
    const ops = extendRoadPath(doc, drag.start, target);
    if (ops.length) {
      editStore.commit(ops);
      const seen = new Set(toolStore.roadSel.map((c) => `${c.x},${c.y}`));
      const merged = [...toolStore.roadSel];
      for (const c of lPath(drag.start, target)) {
        const k = `${c.x},${c.y}`;
        if (!seen.has(k)) { seen.add(k); merged.push(c); }
      }
      toolStore.setRoadSel(merged);
    } else {
      getScene()?.setRoadSelection(toolStore.roadSel);
    }
    return;
  }
  // region tool: finalize the drawn zone. rect -> bbox (no mask); brush/line/frame -> a
  // cell MASK + its bbox. A click without a drag yields a 1×1 "point" (rect mode), used by
  // the Copilot's "вокруг этой точки NxM" to anchor a centred region on that cell.
  if (regionDragging) {
    regionDragging = false;
    const mode = toolStore.zoneMode;
    if (regionStart) {
      const end = lastCell ?? regionStart;
      if (mode === "rect") {
        const r = rectFrom(regionStart, end);
        toolStore.setRegion(r);
        toolStore.setRegionMask(null);
      } else {
        // line width: a generation ZONE needs a workable band (min 3); an armed «по
        // рисунку» path (road/river) is the path itself — honour size 1 exactly.
        const lineW = toolStore.drawGenRecipe ? Math.max(1, toolStore.size) : Math.max(3, toolStore.size);
        const set =
          mode === "brush" ? regionMaskAccum
          : mode === "line" ? lineMask(regionStart, end, lineW)
          : frameMask(rectFrom(regionStart, end));
        const cells = maskRefs(set).map((c) => `${c.x},${c.y}`); // clamp to bounds
        if (cells.length) {
          toolStore.setRegionMask(cells);
          toolStore.setRegion(bboxOfMask(cells));
        }
      }
      toolStore.setZoneHidden(false);
      showZone();
      // «По рисунку»: an armed generator fires as soon as the stroke lands — the drawn
      // mask IS the shape (roads/rivers follow the line, decor sprinkles along the brush).
      // protect=true: a hand stroke must not carve through existing water/mountains.
      const gen = toolStore.drawGenRecipe;
      const genRegion = toolStore.region;
      if (gen && genRegion) {
        const cells = toolStore.regionMask
          ? toolStore.regionMask.map((k) => k.split(",").map(Number) as [number, number])
          : null;
        void editStore
          .generate(gen, genRegion, undefined, cells, true)
          .then((rep) => {
            if (rep && !rep.ok) ElMessage.warning("Генерация по рисунку не прошла валидацию — откачено");
          })
          .catch((err) => ElMessage.error("⚠ " + (err instanceof Error ? err.message : String(err))))
          .finally(() => toolStore.clearZone()); // the veil clears; ready for the next stroke
      }
    }
    try {
      getScene()?.canvas?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    return;
  }
  // locations tool: releasing a zone drag commits the whole-zone move (one undo step);
  // a zone press WITHOUT movement falls through to the unified click-cycle below
  if (zoneDrag && zoneDrag.moved) {
    const d = zoneDrag;
    zoneDrag = null;
    locDown = null;
    clearPreview();
    try { getScene()?.canvas?.releasePointerCapture(e.pointerId); } catch { /* released */ }
    const cell = cellFromEvent(e);
    const z = editStore.zones[d.zid];
    const doc = editStore.liveDoc;
    if (cell && z && doc) {
      const [dx, dy] = clampZoneShift(z.cells, cell.x - d.start.x, cell.y - d.start.y, doc.size);
      if (dx !== 0 || dy !== 0) editStore.moveZone(d.zid, dx, dy);
    }
    return;
  }
  zoneDrag = null;
  // locations tool: releasing the corner handle commits the radius change (one undo step)
  if (locResize) {
    const { id, lastR } = locResize;
    locResize = null;
    clearPreview();
    try { getScene()?.canvas?.releasePointerCapture(e.pointerId); } catch { /* released */ }
    const o = editStore.liveDoc?.objects.find((x) => x.id === id);
    if (o && o.type === "location" && (o.radius ?? 0) !== lastR) {
      editStore.commit([{ kind: "patchObject", id, fields: { radius: lastR } }]);
    }
    return;
  }
  // locations tool: finish the press — a drag commits the move (locations skip occupancy,
  // only bounds are enforced), a click (no drag) selects / cycles the overlap.
  if (locDown) {
    const start = locDown;
    const dragId = locDragId;
    const dragged = locDragging;
    locDown = null;
    locDragId = null;
    locDragging = false;
    clearPreview();
    try {
      getScene()?.canvas?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const cell = cellFromEvent(e);
    if (dragged && dragId && cell) {
      const doc = editStore.liveDoc;
      const o = doc?.objects.find((x) => x.id === dragId);
      if (o && doc) {
        const nx = o.pos.x + (cell.x - start.cell.x);
        const ny = o.pos.y + (cell.y - start.cell.y);
        if (nx >= 0 && ny >= 0 && nx < doc.size && ny < doc.size && (nx !== o.pos.x || ny !== o.pos.y)) {
          editStore.commit([{ kind: "moveObject", id: dragId, x: nx, y: ny }]);
        }
      }
      toolStore.setSelectedId(dragId);
    } else {
      // unified click-cycle: locations (smaller-first) then ZONES covering the cell
      const ring: { kind: "loc" | "zone"; id: string }[] = [
        ...start.locs.map((o) => ({ kind: "loc" as const, id: o.id })),
        ...(start.zids ?? []).map((zid) => ({ kind: "zone" as const, id: zid })),
      ];
      const cur = ring.findIndex((c) =>
        c.kind === "loc" ? c.id === toolStore.selectedId : c.id === toolStore.selectedZoneId,
      );
      const next = ring[(cur + 1) % ring.length]!;
      if (next.kind === "loc") toolStore.setSelectedId(next.id);
      else toolStore.setSelectedZone(next.id);
    }
    return;
  }
  // select/inspect tool. Plain click (negligible movement) → topmost object → inspector;
  // Alt+клик — слой ниже (цикл); Shift+клик — toggle в мультивыделение; Shift+drag — рамка
  // (выделяются НЕ-локации, чей якорь попал в прямоугольник; объединяется с текущим набором).
  if (toolStore.tool === "select" && selDown) {
    const moved = Math.abs(e.clientX - selDown.x) + Math.abs(e.clientY - selDown.y);
    selDown = null;
    const band = boxSelStart;
    boxSelStart = null;
    if (band) {
      const s = getScene();
      s?.setFootprint([]); // clear the band preview
      s?.setPanEnabled(true); // select tool owns the pan again
      try { s?.canvas?.releasePointerCapture(e.pointerId); } catch { /* released */ }
    }
    if (moved < 6) {
      const cell = cellFromEvent(e);
      if (e.shiftKey) {
        const hit = cell ? pickAtCell(cell.x, cell.y, false) : null;
        if (hit) toolStore.toggleSelected(hit.id);
        return; // Shift+клик мимо объектов НЕ сбрасывает набранное выделение
      }
      const hit = cell ? pickAtCell(cell.x, cell.y, e.altKey) : null;
      toolStore.setSelectedId(hit ? hit.id : null);
      return;
    }
    if (band) {
      const cell = cellFromEvent(e);
      const doc = editStore.liveDoc;
      if (cell && doc) {
        const x0 = Math.min(band.x, cell.x), x1 = Math.max(band.x, cell.x);
        const y0 = Math.min(band.y, cell.y), y1 = Math.max(band.y, cell.y);
        const ids = doc.objects
          .filter((o) => o.type !== "location" && VISIBLE_OBJECT_TYPES.has(o.type))
          .filter((o) => o.pos.x >= x0 && o.pos.x <= x1 && o.pos.y >= y0 && o.pos.y <= y1)
          .map((o) => o.id);
        toolStore.addSelected(ids);
      }
    }
    return;
  }
  if (!painting) return;
  painting = false;
  if (strokeOps.length) editStore.commitStroke(strokeOps);
  strokeOps = [];
  try {
    getScene()?.canvas?.releasePointerCapture(e.pointerId);
  } catch {
    /* pointer already released */
  }
}

function onPointerMove(e: PointerEvent): void {
  const cell = cellFromEvent(e);
  lastCell = cell;
  if (cell) {
    viewStore.setCursorCell({ x: cell.x, y: cell.y });
    getScene()?.setCursorCell({ x: cell.x, y: cell.y });
    collabStore.sendCursor(cell); // broadcast my cursor to room peers (throttled)
    if (painting) paintAt(cell.x, cell.y);
  } else {
    viewStore.setCursorCell(null);
    getScene()?.setCursorCell(null);
  }
  if (toolStore.tool === "decor" || toolStore.tool === "move" || toolStore.tool === "object") refreshGhost(cell);
  // select tool: Shift+drag rubber band — live FRAME preview of the selection rectangle
  if (boxSelStart && cell) {
    getScene()?.setFootprint(maskRefs(frameMask(rectFrom(boxSelStart, cell))), true);
  }
  // roadsel drag: live highlight of the would-be segment (move = translated; extend = ∪ L-path)
  if (roadDrag && cell) {
    if (cell.x !== roadDrag.start.x || cell.y !== roadDrag.start.y) roadDrag.moved = true;
    roadDrag.last = cell;
    if (roadDrag.moved) {
      const sel = toolStore.roadSel;
      if (roadDrag.kind === "move") {
        const dx = cell.x - roadDrag.start.x;
        const dy = cell.y - roadDrag.start.y;
        getScene()?.setRoadSelection(sel.map((c) => ({ x: c.x + dx, y: c.y + dy })));
      } else {
        getScene()?.setRoadSelection([...sel, ...lPath(roadDrag.start, cell)]);
      }
    }
  }
  // hover spotlight for location overlays (all tools — this is what declutters the soup)
  updateLocationFocus(cell);
  // locations tool: dragging a ZONE moves the whole entity — shifted-mask preview
  if (zoneDrag && cell) {
    if (!zoneDrag.moved && (cell.x !== zoneDrag.start.x || cell.y !== zoneDrag.start.y)) zoneDrag.moved = true;
    if (zoneDrag.moved) {
      const z = editStore.zones[zoneDrag.zid];
      const doc = editStore.liveDoc;
      if (z && doc) {
        const [dx, dy] = clampZoneShift(z.cells, cell.x - zoneDrag.start.x, cell.y - zoneDrag.start.y, doc.size);
        const shifted = z.cells.map((k) => {
          const [x, y] = k.split(",").map(Number);
          return { x: x! + dx, y: y! + dy };
        });
        getScene()?.setFootprint(shifted, true);
      }
    }
    return;
  }
  // locations tool: dragging the corner handle = radius resize (live footprint preview)
  if (locResize && cell) {
    const o = editStore.liveDoc?.objects.find((x) => x.id === locResize!.id);
    const doc = editStore.liveDoc;
    if (o && doc && o.type === "location") {
      const cheb = Math.max(Math.abs(cell.x - o.pos.x), Math.abs(cell.y - o.pos.y));
      // r≤3: the native ScenEdit dialog knows only 1×1..7×7 — bigger breaks the map there
      const maxR = Math.min(3, o.pos.x, o.pos.y, doc.size - 1 - o.pos.x, doc.size - 1 - o.pos.y);
      const nr = Math.max(0, Math.min(cheb, maxR));
      locResize.lastR = nr;
      getScene()?.setFootprint(footprintCells(o.pos.x - nr, o.pos.y - nr, 2 * nr + 1, 2 * nr + 1), true);
    }
    return;
  }
  // locations tool: a drag ≥1 cell moves the location — live footprint preview at the target
  if (locDown && locDragId && cell) {
    if (!locDragging && (cell.x !== locDown.cell.x || cell.y !== locDown.cell.y)) locDragging = true;
    if (locDragging) {
      const o = editStore.liveDoc?.objects.find((x) => x.id === locDragId);
      if (o && o.type === "location") {
        const r = o.radius ?? 0;
        const nx = o.pos.x + (cell.x - locDown.cell.x);
        const ny = o.pos.y + (cell.y - locDown.cell.y);
        getScene()?.setFootprint(footprintCells(nx - r, ny - r, 2 * r + 1, 2 * r + 1), true);
      }
    }
  }
  if (regionDragging && regionStart && cell) {
    const mode = toolStore.zoneMode;
    const s = getScene();
    if (mode === "rect") {
      const r = rectFrom(regionStart, cell);
      s?.setFootprint(footprintCells(r.x, r.y, r.w, r.h), true);
    } else if (mode === "frame") {
      s?.setFootprint(maskRefs(frameMask(rectFrom(regionStart, cell))), true);
    } else if (mode === "line") {
      s?.setFootprint(maskRefs(lineMask(regionStart, cell, Math.max(3, toolStore.size))), true);
    } else {
      // brush: accumulate cells along the drag
      for (const c of squareCells(cell.x, cell.y, toolStore.size)) regionMaskAccum.add(`${c.x},${c.y}`);
      s?.setFootprint(maskRefs(regionMaskAccum), true);
    }
  }
}

function onPointerLeave(): void {
  lastCell = null;
  viewStore.setCursorCell(null);
  getScene()?.setCursorCell(null);
  clearPreview();
}

onBeforeUnmount(() => {
  if (debugTimer !== undefined) clearInterval(debugTimer);
  const canvas = getScene()?.canvas;
  if (canvas) {
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("dblclick", onDblClick);
    canvas.removeEventListener("contextmenu", onContextMenu);
  }
  window.removeEventListener("keydown", onKeyDown);
  destroyScene();
});

// Rebuild whenever the open document or the manifest changes.
watch([currentMap, manifest], () => {
  toolStore.setSelectedId(null); // a new map invalidates any selection
  void rebuild();
});

// Re-tile the terrain after an edit. Coalesced via setTimeout (NOT requestAnimationFrame):
// rAF is throttled when the pointer sits off-canvas (e.g. on the Copilot panel), which made
// "↻ another variant" not repaint until you moved onto the map. updateTerrain paints now.
// Incremental (#35): editStore accumulates the setCell coordinates since the last tick —
// a brush stroke re-tiles only the touched chunks; an object-only edit skips the terrain
// layer entirely; undo/redo/load (recompute) falls back to the full rebuild.
function flushTerrain(): void {
  const s = getScene();
  if (!s || !editStore.liveDoc) return;
  const dirty = editStore.takeTerrainDirty();
  if (dirty.full) s.updateTerrain(editStore.liveDoc);
  else if (dirty.cells.length) s.updateTerrain(editStore.liveDoc, dirty.cells);
  // else: object-only edit — terrain unchanged
}
let retileScheduled = false;
watch(
  () => editStore.rev,
  () => {
    if (editStore.renderMuted) return; // «↻ другой вариант»: skip the undo's rollback paint;
    if (retileScheduled) return; //       dirty accumulates and renders once on unmute
    retileScheduled = true;
    setTimeout(() => {
      retileScheduled = false;
      flushTerrain();
    }, 0);
  },
);
// When the Copilot un-mutes (retry finished), paint the FINAL accumulated terrain once — so
// the map jumps straight from the previous variant to the new one, no base flash between.
watch(
  () => editStore.renderMuted,
  (muted) => { if (!muted) flushTerrain(); },
);

// Re-render the OBJECT layer after an object edit (place/move/delete/undo/redo).
// Same setTimeout coalescing for the same reason. Terrain strokes don't bump objectsRev.
let objRebuildScheduled = false;
watch(
  () => editStore.objectsRev,
  () => {
    if (objRebuildScheduled) return;
    objRebuildScheduled = true;
    setTimeout(() => {
      objRebuildScheduled = false;
      const s = getScene();
      if (s && editStore.liveDoc) s.updateObjects(editStore.liveDoc);
    }, 0);
  },
);

// Persistent selection outline — for EVERY object in the multi-selection (redraw when the
// selection changes or an object moves/edits; clear when gone). Scene.setSelection is
// cell-array based, so N objects = one concatenated cell list.
watch(
  [() => toolStore.selectedIds, () => editStore.objectsRev],
  () => {
    const s = getScene();
    if (!s) return;
    const doc = editStore.liveDoc;
    const cells: { x: number; y: number }[] = [];
    for (const id of toolStore.selectedIds) {
      const obj = doc?.objects.find((o) => o.id === id);
      // A selected location is highlighted by LocationLayer (yellow accent on its centered
      // area), so skip the generic footprint outline (wrong r×r box at pos).
      if (!obj || obj.type === "location") continue;
      const { w, h } = objectFootprint(obj, landmarkFootprints);
      cells.push(...footprintCells(obj.pos.x, obj.pos.y, w, h));
    }
    s.setSelection(cells);
  },
);

// Rebuild the LOCATION highlights + labels when an object edit moves/adds/removes a
// location, when the selection changes (selected location gets its name label + accent),
// when an editor-only caption is edited, or when the «Локации» mode toggles (it adds the
// scenario-SUMMARY lines — «⚡ вход → …», «➜ приказ: охранять» — under the names).
watch(
  [
    () => editStore.objectsRev, () => toolStore.selectedId, () => editStore.captions,
    () => toolStore.tool, () => toolStore.selectedZoneId, () => editStore.zones,
  ],
  () => refreshZonesAndLocations(),
  { deep: true },
);

// Event overlay: draw the selected event's trigger zones + movement arrows. Re-run when the
// selection changes or any object/event edit lands (objectsRev bumps on both).
watch(
  [() => eventStore.selectedId, () => editStore.objectsRev],
  () => {
    const s = getScene();
    if (s && editStore.liveDoc) s.updateEventOverlay(editStore.liveDoc, eventStore.selected);
  },
);

// Anchors overlay («Связи»): redraw when an anchor is set/cleared, an object moves,
// or the visibility toggle flips.
watch(
  [() => editStore.anchors, () => editStore.objectsRev, () => viewStore.anchorsVisible],
  () => {
    const s = getScene();
    if (s && editStore.liveDoc)
      s.updateAnchors(editStore.liveDoc, editStore.anchors, viewStore.anchorsVisible);
  },
  { deep: true },
);

// Scenario-roles overlay: locations AND event-wired objects (отряд/город/сайт/руина)
// show their role (⚡ trigger / 🎯 target / ✨ spawn / ➜ dest / ☁ env). objectsRev bumps
// on event edits too, so wiring stays live.
watch(
  [() => editStore.objectsRev, () => viewStore.rolesVisible, () => editStore.zones],
  () => {
    const s = getScene();
    if (s && editStore.liveDoc)
      s.updateScenarioRoles(
        editStore.liveDoc,
        zoneFilteredRoleCounts(editStore.liveDoc),
        viewStore.rolesVisible,
        objectRoleMarkers(editStore.liveDoc),
      );
  },
  { deep: true },
);

// Link threads of the SELECTED object: arcs to every entity its events wire. Selection-
// scoped by design (permanent all-links rendering is unreadable on dense maps): click an
// event-wired object → its web lights up; deselect → clean map.
watch(
  [() => toolStore.selectedId, () => editStore.objectsRev],
  () => {
    const s = getScene();
    const doc = editStore.liveDoc;
    if (!s || !doc) return;
    const id = toolStore.selectedId;
    const roles = id ? locRoles().get(id) : undefined;
    const events = roles?.length ? [...new Set(roles.map((r) => r.ev))] : [];
    s.updateObjectLinks(doc, events.length ? id : null, events);
  },
);

// Collab presence: broadcast my selection to room peers; render their live cursors.
watch(
  () => toolStore.selectedIds,
  (ids) => collabStore.sendSelection(ids),
);
watch(
  () => collabStore.peerList,
  (peers) => getScene()?.setPeers(peers.map((p) => ({ socketId: p.socketId, name: p.name, color: p.color, cursor: p.cursor }))),
  { deep: true },
);

// A paint tool owns the drag; "select" restores camera pan. The decor tool also owns
// the drag (no pan) and clears its ghost when deselected.
watch(
  () => toolStore.tool,
  (t, prev) => {
    const s = getScene();
    s?.setPanEnabled(t === "select");
    if (prev === "move") toolStore.setMoveId(null); // leaving move drops the carry
    if (prev === "roadsel") {
      toolStore.setRoadSel([]); // leaving road-select clears the highlight (+anchor/level)
      roadDrag = null;
    }
    if (prev === "region" || prev === "zone") regionDragging = false;
    // «режим локаций»: veil the world; make sure the location layer is actually visible
    if (t === "locations") {
      s?.setLocationsMode(true);
      if (!viewStore.locationsVisible) viewStore.setLayerVisible("locations", true);
      updateLocationFocus(lastCell, true); // apply the role filter's steady spotlight
    } else if (prev === "locations") {
      s?.setLocationsMode(false);
      locDown = null;
      locDragId = null;
      locDragging = false;
      locResize = null;
      zoneDrag = null;
      updateLocationFocus(lastCell, true); // drop the filter spotlight with the mode
    }
    if (t === "decor" || t === "move" || t === "object") refreshGhost(lastCell);
    else if (t === "region") showZone(); // re-show the existing zone (mask or bbox)
    else clearPreview();
  },
);

// Keep the zone overlay in sync when the region / mask / hidden flag changes from elsewhere
// (the accept ✓ / hide 👁 buttons, mode switches, programmatic setRegion).
watch(
  () => [toolStore.region, toolStore.regionMask, toolStore.zoneHidden],
  () => {
    if (toolStore.tool === "region" || toolStore.tool === "zone") showZone();
  },
  { deep: true },
);

// Recompute the visible-cell set immediately when the 👁 eye toggles (don't wait for a pan).
watch(
  () => toolStore.eyeZone,
  () => {
    const cam = getScene()?.getCamera();
    if (cam) updateVisibleCells(cam.snapshot());
  },
);

// Mirror the road-segment selection onto the Scene highlight.
watch(
  () => toolStore.roadSel,
  (cells) => getScene()?.setRoadSelection(cells),
  { deep: true },
);

// «Локации»: re-apply the spotlight when the role filter changes (steady filtered set).
watch(
  () => toolStore.locFilter,
  () => updateLocationFocus(lastCell, true),
);

// Deep-link routing: адресная строка ВСЕГДА несёт ?map&obj текущего выбора — скопировать URL
// и есть «пошарить»; получатель откроет карту с центром/выделением/миганием на объекте.
watch(
  () => [toolStore.selectedId, toolStore.selectedZoneId, mapStore.currentScenarioId] as const,
  ([sel, zid, mapId]) => {
    if (!mapId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("map", String(mapId));
    const target = sel ?? zid;
    if (target) url.searchParams.set("obj", target);
    else url.searchParams.delete("obj");
    window.history.replaceState(null, "", url);
  },
);

// Страховка гонки бута: App ставит focusObjectId ПОСЛЕ openMap — если rebuild уже успел
// завершиться (кэшированные ассеты), фокусируем прямо отсюда.
watch(
  () => toolStore.focusObjectId,
  (id) => {
    if (id && !building.value && (editStore.liveDoc ?? currentMap.value)) focusPendingObject();
  },
);

// Refresh the ghost when the picked decoration / carried object / placed kind changes.
watch(
  () => [toolStore.decorId, toolStore.moveId, toolStore.objectKind, toolStore.stackLeaderId],
  () => {
    if (toolStore.tool === "decor" || toolStore.tool === "move" || toolStore.tool === "object") refreshGhost(lastCell);
  },
);

// Imperatively reflect layer/animation toggles onto the live Scene.
watch(terrainVisible, (v) => getScene()?.setLayerVisibility("terrain", v));
watch(objectsVisible, (v) => getScene()?.setLayerVisibility("objects", v));
watch(gridVisible, (v) => getScene()?.setLayerVisibility("grid", v));
watch(locationsVisible, (v) => getScene()?.setLayerVisibility("locations", v));
// Animation toggle. The animation-frame atlases (iso-anim-*, 82 MB) are LAZY: turning
// playback on first pulls just the atlases this map's objects animate with, then rebuilds
// the object layer so AnimatedSprites materialize (statics keep rendering meanwhile).
watch(animate, (v) => {
  const s = getScene();
  if (!s) return;
  if (!v) {
    s.setAnimationEnabled(false);
    return;
  }
  const doc = editStore.liveDoc;
  if (!doc) {
    s.setAnimationEnabled(true);
    return;
  }
  void s.ensureAnimationsFor(doc).then(() => {
    s.updateObjects(doc);
    s.setAnimationEnabled(true);
  });
});
watch(
  overlayTints,
  (t) => {
    const s = getScene();
    if (!s) return;
    for (const cat of OVERLAY_TINTS) s.setOverlayTint(cat, t[cat]);
  },
  { deep: true },
);
</script>

<template>
  <div class="canvas-host">
    <div ref="mountEl" class="canvas-mount" />

    <!-- right-click object menu (плавающее, закрывается любым кликом/Esc) -->
    <div
      v-if="ctxMenu"
      class="ctx-menu d2-float"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
    >
      <template v-if="ctxMenu.obj">
        <div class="ctx-title">{{ (ctxMenu.obj as { name?: string }).name || ctxMenu.obj.type }} <code>{{ ctxMenu.obj.id }}</code></div>
        <button class="ctx-item" @click="ctxAction('props')">Свойства</button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="ctxAction('events')">📋 События объекта</button>
        <button class="ctx-item" @click="ctxAction('newEvent')">＋ Событие с этим объектом</button>
        <button v-if="ctxMenu.obj.type === 'location'" class="ctx-item" @click="ctxAction('spawnHere')">✨ Спавн отряда здесь</button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="ctxAction('anchor')">⚓ Заякорить к…</button>
        <button
          v-if="ctxMenu.obj.type === 'village' || ctxMenu.obj.type === 'capital'"
          class="ctx-item"
          @click="ctxAction('roadAnchor')"
        >
          🛣 Дорога следует за входом {{ editStore.roadAnchors[ctxMenu.obj.id] ? "✓" : "" }}
        </button>
        <button v-if="editStore.anchors[ctxMenu.obj.id]" class="ctx-item" @click="ctxAction('unanchor')">Снять якорь</button>
        <button class="ctx-item" @click="ctxAction('links')">{{ viewStore.anchorsVisible ? 'Скрыть связи' : 'Показать связи' }}</button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="ctxAction('copyId')">Скопировать id</button>
        <button v-if="['landmark', 'stack', 'mountains', 'village', 'treasure', 'ruin', 'merchant', 'mage', 'trainer', 'mercenary'].includes(ctxMenu.obj.type)" class="ctx-item ctx-danger" @click="ctxAction('delete')">🗑 Удалить</button>
      </template>
      <template v-else>
        <div class="ctx-title">Поставить здесь <code>{{ ctxMenu.cell.x }}, {{ ctxMenu.cell.y }}</code></div>
        <button class="ctx-item" @click="placeAction('village')">🏘 Деревню (4×4)</button>
        <button class="ctx-item" @click="placeAction('stack')">⚔️ Отряд (герой)</button>
        <button class="ctx-item" @click="placeAction('treasure')">📦 Сундук</button>
        <button class="ctx-item" @click="placeAction('ruin')">🏚 Руину (3×3)</button>
        <button class="ctx-item" @click="placeAction('merchant')">🛒 Торговца (3×3)</button>
        <button class="ctx-item" @click="placeAction('mage')">🔮 Мага (3×3)</button>
        <button class="ctx-item" @click="placeAction('trainer')">🎓 Тренера (3×3)</button>
        <button class="ctx-item" @click="placeAction('mercenary')">🛡 Наёмников (3×3)</button>
      </template>
    </div>
    <div v-if="debugOverlay && debugStats" class="debug-hud">
      <div class="hud-row hud-head">debug</div>
      <div class="hud-row">
        <span>renders/s</span><b :class="{ warn: debugStats.fps > 0 && debugStats.fps < 30 }">{{ debugStats.fps }}</b>
      </div>
      <div class="hud-row"><span>cpu/frame</span><b>{{ debugStats.cpuMs.toFixed(2) }} ms</b></div>
      <div class="hud-row"><span>cpu load</span><b>{{ (debugStats.fps * debugStats.cpuMs / 10).toFixed(0) }}%</b></div>
      <div class="hud-row">
        <span>gpu/frame</span><b>{{ debugStats.gpuMs != null ? debugStats.gpuMs.toFixed(2) + " ms" : "—" }}</b>
      </div>
      <div class="hud-sep" />
      <div class="hud-row"><span>zoom</span><b>{{ (debugStats.zoom * 100).toFixed(0) }}%</b></div>
      <div class="hud-row">
        <span>cell</span><b>{{ cursorCell ? cursorCell.x + "," + cursorCell.y : "—" }}</b>
      </div>
      <div class="hud-row"><span>world</span><b>{{ Math.round(debugStats.world.x) }}, {{ Math.round(debugStats.world.y) }}</b></div>
      <div class="hud-sep" />
      <div class="hud-row"><span>objects</span><b>{{ debugStats.objects }}<template v-if="debugStats.animActive"> ({{ debugStats.animActive }} anim)</template></b></div>
      <div class="hud-row"><span>screen</span><b>{{ debugStats.screen.w }}×{{ debugStats.screen.h }} @{{ debugStats.resolution }}x</b></div>
      <div class="hud-row"><span>buffer</span><b>{{ debugStats.drawingBuffer.w }}×{{ debugStats.drawingBuffer.h }} (dpr {{ debugStats.dpr }})</b></div>
      <div class="hud-sep" />
      <div class="hud-row"><span>tex vram</span><b>{{ debugStats.texMB.toFixed(0) }} MB / {{ debugStats.texCount }}</b></div>
      <div class="hud-row"><span>atlas vram</span><b>{{ debugStats.atlasVramMB.toFixed(0) }} MB / {{ debugStats.sheets }} листов</b></div>
      <div class="hud-row">
        <span>js heap</span>
        <b v-if="debugStats.jsHeapMB != null">{{ debugStats.jsHeapMB.toFixed(0) }} / {{ debugStats.jsHeapLimitMB?.toFixed(0) }} MB</b>
        <b v-else>n/a</b>
      </div>
      <div class="hud-row">
        <span>assets dl</span>
        <b>{{ debugStats.netMB != null ? debugStats.netMB.toFixed(1) + " MB" : "—" }}</b>
      </div>
      <div class="hud-sep" />
      <div class="hud-row"><span>{{ debugStats.rendererType }}</span><b>max tex {{ debugStats.maxTexture }}</b></div>
      <div class="hud-row hud-gpu">{{ debugStats.gpu }}</div>
    </div>
    <!-- легенда оверлея «Роли локаций» (тумблер в Вид) -->
    <div v-if="viewStore.rolesVisible && currentMap" class="roles-legend d2-float">
      ⚡ вход-триггер&ensp;✨ спавн&ensp;➜ цель&ensp;☁ эффект&ensp;<span class="rl-dim">· точка — не используется</span>
    </div>
    <div v-if="building" v-loading="true" class="canvas-overlay" element-loading-text="Building scene…" />
    <el-alert
      v-if="buildError"
      class="canvas-error"
      type="error"
      :title="buildError"
      :closable="false"
      show-icon
    />
  </div>
</template>

<style scoped>
.canvas-host {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #1a1a1a;
}
.canvas-mount {
  width: 100%;
  height: 100%;
}
.canvas-mount :deep(canvas) {
  display: block;
}
/* right-click object menu: fixed at the cursor, above every float */
.ctx-menu {
  position: fixed;
  z-index: 90;
  min-width: 190px;
  padding: 6px;
  font-size: 12px;
}
.ctx-title {
  padding: 4px 8px 6px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-title code {
  font-size: 10px;
  color: var(--el-text-color-secondary);
  margin-left: 4px;
}
.ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 6px 8px;
  border-radius: var(--d2-radius);
  cursor: pointer;
  color: var(--el-text-color-regular);
  font-size: 12px;
}
.ctx-item:hover {
  background: var(--el-fill-color-light);
}
.ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--el-border-color-lighter);
}
/* «Роли локаций» legend — bottom-left, clear of the dock/copilot/minimap corners */
.roles-legend {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 20;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--el-text-color-regular);
  pointer-events: none;
  white-space: nowrap;
}
.rl-dim {
  color: var(--el-text-color-secondary);
}
.ctx-danger {
  color: var(--el-color-danger);
}
.canvas-overlay {
  position: absolute;
  inset: 0;
}
.canvas-error {
  position: absolute;
  left: 12px;
  bottom: 12px;
  max-width: 60%;
}
.debug-hud {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 20;
  min-width: 180px;
  padding: 6px 8px;
  font: 11px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
  color: #d7f0d7;
  background: rgba(0, 0, 0, 0.62);
  border: 1px solid rgba(120, 200, 120, 0.25);
  border-radius: 5px;
  pointer-events: none;
  user-select: none;
}
.hud-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.hud-row > span {
  color: #8fae8f;
}
.hud-row > b {
  font-weight: 600;
}
.hud-row > b.warn {
  color: #ffce6b;
}
.hud-head {
  justify-content: center;
  color: #6fd06f;
  letter-spacing: 2px;
  text-transform: uppercase;
  font-size: 10px;
  margin-bottom: 2px;
}
.hud-gpu {
  display: block;
  margin-top: 2px;
  color: #7f9a7f;
  font-size: 10px;
  max-width: 230px;
  white-space: normal;
}
.hud-sep {
  height: 1px;
  margin: 4px 0;
  background: rgba(120, 200, 120, 0.18);
}
</style>
