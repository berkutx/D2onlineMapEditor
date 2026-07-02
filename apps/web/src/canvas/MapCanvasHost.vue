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
import type { CameraSnapshot, DebugStats, LandmarkFootprints } from "@d2/pixi-render";
import { worldToCell, objectFootprint, objectZBase, objectSprites } from "@d2/pixi-render";
import type { MapObject } from "@d2/map-schema";
import {
  terrainBrush,
  roadBrush,
  eraseBrush,
  placeMountainOps,
  placeLandmarkOps,
  placeVillageOps,
  placeChestOps,
  placeStackOps,
  selectRoadSegment,
  type BrushKind,
  type EditOp,
} from "@d2/map-edit";
import { useMapStore } from "../stores/mapStore";
import { useAssetStore } from "../stores/assetStore";
import { useViewStore, OVERLAY_TINTS } from "../stores/viewStore";
import { useToolStore } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";
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
    // A pipeline output like the manifest -> fetch fresh (the static mount serves
    // /assets with a long immutable cache, which would otherwise pin a stale copy).
    const objectData = await (
      await fetch(assetUrl("objectdata.json"), { cache: "no-store" })
    ).json();
    landmarkFootprints = objectData?.landmarkFootprints;
    spriteTables = objectData;
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
    // seed location labels (own captions + current selection) onto the fresh scene
    scene.updateLocations(editStore.liveDoc ?? doc, {
      captions: editStore.captions,
      selectedId: toolStore.selectedId,
    });
    for (const cat of OVERLAY_TINTS) scene.setOverlayTint(cat, overlayTints.value[cat]);
    scene.setAnimationEnabled(animate.value);
    // seed the status bar with the initial camera zoom + visible-cell box
    const cam = scene.getCamera();
    if (cam) {
      viewStore.setZoom(cam.zoom);
      updateVisibleCells(cam.snapshot());
    }
  } catch (e) {
    buildError.value = e instanceof Error ? e.message : String(e);
  } finally {
    building.value = false;
  }
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
    edit: editStore, tool: toolStore, view: viewStore, events: eventStore, map: mapStore,
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

// --- terrain painting --------------------------------------------------------
let painting = false;
let strokeOps: EditOp[] = [];
/** Press position for the select tool (to tell a click from a pan-drag). */
let selDown: { x: number; y: number } | null = null;
/** Last hovered cell (null = off-map); used to refresh the decor ghost on cycle. */
let lastCell: { x: number; y: number } | null = null;

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
    const { w, h } = objectFootprint(o, landmarkFootprints);
    if (cx >= o.pos.x && cx < o.pos.x + w && cy >= o.pos.y && cy < o.pos.y + h) {
      concrete.push({ o, z: objectZBase(o) + o.pos.x + o.pos.y + h });
    }
  }
  concrete.sort((a, b) => b.z - a.z);
  locs.sort((a, b) => b.z - a.z);
  return [...concrete.map((c) => c.o), ...locs.map((l) => l.o)];
}

/** Pick from the covering candidates: plain click → topmost; Shift → one level below the
 *  current selection (cycling), so overlapping objects/locations can be reached. */
function pickAtCell(cx: number, cy: number, shift: boolean): MapObject | null {
  const list = objectsAtCell(cx, cy);
  if (!list.length) return null;
  if (!shift) return list[0]!;
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
    // units (leaders inside stacks, not independently grid-placed).
    if (o.type === "location" || o.type === "unit") continue;
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

/** Apply the brush at a cell against the LIVE doc (preview); accumulate stroke ops. */
function paintAt(cx: number, cy: number): void {
  const doc = editStore.liveDoc;
  if (!doc) return;
  let ops: EditOp[];
  if (toolStore.tool === "road") {
    ops = roadBrush(doc, cx, cy); // connectivity-based, ignores brush size
  } else if (toolStore.tool === "erase") {
    ops = eraseBrush(doc, cx, cy, toolStore.size); // clears terrain + roads (+ neighbour recompute)
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
    ops = terrainBrush(doc, cx, cy, toolStore.size, kind);
  }
  if (ops.length) {
    editStore.applyPreview(ops);
    strokeOps.push(...ops);
  }
}

// road-select: re-clicking the same anchor cell bumps the level (segment -> strand -> net).
let roadAnchor: { x: number; y: number } | null = null;
let roadLevel = 0;

// ---- right-click context menu + anchor-pick mode ("Заякорить к…") -------------------------
/** Open context menu: screen position + the object it targets (obj=null → the EMPTY-cell
 *  placement menu at `cell`). */
const ctxMenu = ref<{ x: number; y: number; obj: MapObject | null; cell: { x: number; y: number } } | null>(null);
/** While set, the NEXT left click picks the anchor PARENT for this child id. */
const anchorPickFor = ref<string | null>(null);

/** Double click = свойства объекта (select -> the inspector rail opens). */
function onDblClick(e: MouseEvent): void {
  const cell = cellFromEvent(e as PointerEvent);
  if (!cell) return;
  const hit = pickAtCell(cell.x, cell.y, e.shiftKey);
  if (hit) toolStore.setSelectedId(hit.id);
}

/** Right click = context menu: the object under the cursor, or the EMPTY-cell placement menu. */
function onContextMenu(e: MouseEvent): void {
  e.preventDefault();
  anchorPickFor.value = null;
  const cell = cellFromEvent(e as PointerEvent);
  if (!cell) { ctxMenu.value = null; return; }
  const hit = pickAtCell(cell.x, cell.y, e.shiftKey);
  ctxMenu.value = { x: e.clientX, y: e.clientY, obj: hit, cell };
}

/** Empty-cell placement («Поставить здесь»): village 4×4 / chest 1×1 / stack 1×1 with a
 *  default hero leader — everything is then edited in the inspector (fully editable). */
function placeAction(kind: "village" | "chest" | "stack"): void {
  const at = ctxMenu.value?.cell;
  ctxMenu.value = null;
  const doc = editStore.liveDoc;
  if (!at || !doc) return;
  const need = kind === "village" ? 4 : 1;
  if (!canPlaceFootprint(at.x, at.y, need, need)) {
    ElMessage.warning(kind === "village" ? "Не помещается: деревне нужно 4×4 свободных клетки" : "Клетка занята");
    return;
  }
  let ops: EditOp[] = [];
  if (kind === "village") ops = placeVillageOps(doc, at.x, at.y, "Новая деревня", 1);
  else if (kind === "chest") ops = placeChestOps(doc, at.x, at.y, 0, []);
  else {
    // default leader = the first hero (L_LEADER) from the catalog; change it in the editor
    const hero = unitStore.all
      .filter((u) => u.catKey === "L_LEADER")
      .sort((a, b) => a.name.localeCompare(b.name, "ru"))[0];
    if (!hero) {
      ElMessage.warning("Каталог юнитов ещё загружается — попробуйте через секунду");
      return;
    }
    ops = placeStackOps(doc, at.x, at.y, {
      units: [null, null, { unit: hero.id, level: hero.level, hp: hero.hp }, null, null, null],
      leaderCell: 2,
    });
  }
  const first = ops[0] as { object?: { id: string } } | undefined;
  editStore.commit(ops);
  if (first?.object) toolStore.setSelectedId(first.object.id);
  ElMessage.success("Поставлено — свойства в инспекторе справа");
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
      editStore.commit([{ kind: "deleteObject", id: obj.id }]);
      break;
  }
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

/** Esc closes the context menu and cancels a pending anchor pick. */
function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (ctxMenu.value) ctxMenu.value = null;
  if (anchorPickFor.value) {
    anchorPickFor.value = null;
    ElMessage.info("Якорение отменено");
  }
}

function onPointerDown(e: PointerEvent): void {
  ctxMenu.value = null; // any left press dismisses the context menu
  // anchor-pick mode: this click chooses the PARENT for the pending "Заякорить к…"
  if (anchorPickFor.value) {
    const cell = cellFromEvent(e);
    const hit = cell ? pickAtCell(cell.x, cell.y, e.shiftKey) : null;
    if (hit) finishAnchorPick(hit);
    else { anchorPickFor.value = null; ElMessage.info("Якорение отменено"); }
    return;
  }
  if (e.ctrlKey) return; // Ctrl+drag pans the camera (handled by Scene), not a tool action
  // region tool: start drawing the Copilot generation zone (mode = rect/brush/line/frame).
  if (toolStore.tool === "region") {
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
  if (toolStore.tool === "roadsel") {
    const cell = cellFromEvent(e);
    const doc = editStore.liveDoc;
    if (!cell || !doc) return;
    if (roadAnchor && roadAnchor.x === cell.x && roadAnchor.y === cell.y) {
      roadLevel = Math.min(roadLevel + 1, 2);
    } else {
      roadAnchor = cell;
      roadLevel = 0;
    }
    const sel = selectRoadSegment(doc, cell.x, cell.y, roadLevel);
    if (sel.length === 0) roadAnchor = null;
    toolStore.setRoadSel(sel);
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
  // move tool: 1st click picks the object (Shift = one level below, like select); 2nd click
  // drops it at the new cell. A location's center moves freely (it overlaps objects by design).
  if (toolStore.tool === "move") {
    const cell = cellFromEvent(e);
    if (!cell) return;
    if (!toolStore.moveId) {
      const hit = pickAtCell(cell.x, cell.y, e.shiftKey);
      if (hit) {
        toolStore.setMoveId(hit.id);
        refreshGhost(cell);
      }
    } else {
      const obj = editStore.liveDoc?.objects.find((o) => o.id === toolStore.moveId);
      if (obj) {
        const dx = cell.x - obj.pos.x;
        const dy = cell.y - obj.pos.y;
        // anchored group: the carried object + every transitively anchored child moves by the
        // same delta — and the WHOLE group must fit (bounds + occupancy), else keep carrying.
        const group = editStore.anchorGroup(obj.id);
        if (group.length > 1) {
          if (dx !== 0 || dy !== 0) {
            if (groupMoveBlocked(group, dx, dy)) return; // не даём даже попытаться
            const doc = editStore.liveDoc!;
            const ops: EditOp[] = group
              .map((id) => doc.objects.find((o) => o.id === id))
              .filter((o): o is NonNullable<typeof o> => !!o)
              .map((o) => ({ kind: "moveObject" as const, id: o.id, x: o.pos.x + dx, y: o.pos.y + dy }));
            editStore.commit(ops); // one stroke = one undo for the whole group
          }
        } else {
          if (obj.type !== "location") {
            const { w, h } = objectFootprint(obj, landmarkFootprints);
            // invalid drop (off-map / onto another object) -> keep carrying, like the editor
            if (!canPlaceFootprint(cell.x, cell.y, w, h, toolStore.moveId ?? undefined)) return;
          }
          if (dx !== 0 || dy !== 0) {
            editStore.commit([{ kind: "moveObject", id: toolStore.moveId, x: cell.x, y: cell.y }]);
          }
        }
      }
      toolStore.setMoveId(null);
      clearPreview();
    }
    return;
  }
  // select/inspect tool: remember the press; a click (no drag) on pointerup selects the
  // object under it (drag still pans the camera — we don't capture the pointer here).
  if (toolStore.tool === "select") {
    selDown = { x: e.clientX, y: e.clientY };
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
        const set =
          mode === "brush" ? regionMaskAccum
          : mode === "line" ? lineMask(regionStart, end, Math.max(3, toolStore.size))
          : frameMask(rectFrom(regionStart, end));
        const cells = maskRefs(set).map((c) => `${c.x},${c.y}`); // clamp to bounds
        if (cells.length) {
          toolStore.setRegionMask(cells);
          toolStore.setRegion(bboxOfMask(cells));
        }
      }
      toolStore.setZoneHidden(false);
      showZone();
    }
    try {
      getScene()?.canvas?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    return;
  }
  // select/inspect tool: a click (negligible movement) picks the topmost object → inspector.
  // Hold Shift to step one level below the current pick (overlapping locations/objects).
  if (toolStore.tool === "select" && selDown) {
    const moved = Math.abs(e.clientX - selDown.x) + Math.abs(e.clientY - selDown.y);
    selDown = null;
    if (moved < 6) {
      const cell = cellFromEvent(e);
      const hit = cell ? pickAtCell(cell.x, cell.y, e.shiftKey) : null;
      toolStore.setSelectedId(hit ? hit.id : null);
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
  if (toolStore.tool === "decor" || toolStore.tool === "move") refreshGhost(cell);
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
let retileScheduled = false;
watch(
  () => editStore.rev,
  () => {
    if (retileScheduled) return;
    retileScheduled = true;
    setTimeout(() => {
      retileScheduled = false;
      const s = getScene();
      if (s && editStore.liveDoc) s.updateTerrain(editStore.liveDoc);
    }, 0);
  },
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

// Persistent selection outline for the inspector's selected object (redraw when the
// selection changes or the object moves/edits; clear when it's gone).
watch(
  [() => toolStore.selectedId, () => editStore.objectsRev],
  () => {
    const s = getScene();
    if (!s) return;
    const id = toolStore.selectedId;
    const obj = id ? editStore.liveDoc?.objects.find((o) => o.id === id) : null;
    // A selected location is highlighted by LocationLayer (yellow accent on its centered
    // area), so skip the generic footprint outline (which would be the wrong r×r box at pos).
    if (!obj || obj.type === "location") { s.setSelection([]); return; }
    const { w, h } = objectFootprint(obj, landmarkFootprints);
    s.setSelection(footprintCells(obj.pos.x, obj.pos.y, w, h));
  },
);

// Rebuild the LOCATION highlights + labels when an object edit moves/adds/removes a
// location, when the selection changes (selected location gets its name label + accent),
// or when an editor-only caption is edited. Cheap (a few Graphics/Text).
watch(
  [() => editStore.objectsRev, () => toolStore.selectedId, () => editStore.captions],
  () => {
    const s = getScene();
    if (s && editStore.liveDoc) {
      s.updateLocations(editStore.liveDoc, {
        captions: editStore.captions,
        selectedId: toolStore.selectedId,
      });
    }
  },
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

// Collab presence: broadcast my selection to room peers; render their live cursors.
watch(
  () => toolStore.selectedId,
  (id) => collabStore.sendSelection(id ? [id] : []),
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
      toolStore.setRoadSel([]); // leaving road-select clears the highlight
      roadAnchor = null;
      roadLevel = 0;
    }
    if (prev === "region") regionDragging = false;
    if (t === "decor" || t === "move") refreshGhost(lastCell);
    else if (t === "region") showZone(); // re-show the existing zone (mask or bbox)
    else clearPreview();
  },
);

// Keep the zone overlay in sync when the region / mask / hidden flag changes from elsewhere
// (the accept ✓ / hide 👁 buttons, mode switches, programmatic setRegion).
watch(
  () => [toolStore.region, toolStore.regionMask, toolStore.zoneHidden],
  () => {
    if (toolStore.tool === "region") showZone();
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

// Refresh the ghost when the picked decoration or carried object changes.
watch(
  () => [toolStore.decorId, toolStore.moveId],
  () => {
    if (toolStore.tool === "decor" || toolStore.tool === "move") refreshGhost(lastCell);
  },
);

// Imperatively reflect layer/animation toggles onto the live Scene.
watch(terrainVisible, (v) => getScene()?.setLayerVisibility("terrain", v));
watch(objectsVisible, (v) => getScene()?.setLayerVisibility("objects", v));
watch(gridVisible, (v) => getScene()?.setLayerVisibility("grid", v));
watch(locationsVisible, (v) => getScene()?.setLayerVisibility("locations", v));
watch(animate, (v) => getScene()?.setAnimationEnabled(v));
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
        <div class="ctx-sep" />
        <button class="ctx-item" @click="ctxAction('anchor')">⚓ Заякорить к…</button>
        <button v-if="editStore.anchors[ctxMenu.obj.id]" class="ctx-item" @click="ctxAction('unanchor')">Снять якорь</button>
        <button class="ctx-item" @click="ctxAction('links')">{{ viewStore.anchorsVisible ? 'Скрыть связи' : 'Показать связи' }}</button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="ctxAction('copyId')">Скопировать id</button>
        <button v-if="ctxMenu.obj.type === 'landmark'" class="ctx-item ctx-danger" @click="ctxAction('delete')">🗑 Удалить</button>
      </template>
      <template v-else>
        <div class="ctx-title">Поставить здесь <code>{{ ctxMenu.cell.x }}, {{ ctxMenu.cell.y }}</code></div>
        <button class="ctx-item" @click="placeAction('village')">🏘 Деревню (4×4)</button>
        <button class="ctx-item" @click="placeAction('stack')">⚔️ Отряд (герой)</button>
        <button class="ctx-item" @click="placeAction('chest')">📦 Сундук</button>
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
      <div class="hud-row">
        <span>js heap</span>
        <b v-if="debugStats.jsHeapMB != null">{{ debugStats.jsHeapMB.toFixed(0) }} / {{ debugStats.jsHeapLimitMB?.toFixed(0) }} MB</b>
        <b v-else>n/a</b>
      </div>
      <div class="hud-row"><span>net</span><b>{{ debugStats.netMB.toFixed(1) }} MB ({{ debugStats.assetsMB.toFixed(0) }} dec)</b></div>
      <div class="hud-sep" />
      <div class="hud-row"><span>{{ debugStats.rendererType }}</span><b>max tex {{ debugStats.maxTexture }}</b></div>
      <div class="hud-row hud-gpu">{{ debugStats.gpu }}</div>
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
