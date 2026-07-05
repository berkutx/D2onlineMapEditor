/**
 * Tool state for the map editor: the active brush tool, brush size (1/3/5 like the
 * game), and the land terrain to paint. Plain serialisable refs; MapCanvasHost reads
 * these on pointer events to drive the terrain brush.
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import type { LocFilter } from "../services/scenarioRoles";

/** select = pan/inspect (no painting); terrain/water/forest/road/erase paint cells;
 *  decor = place a decoration; move = pick+drop an object; roadsel = select a road segment;
 *  region = drag a rectangle for Copilot generation; locations = «режим локаций» (world
 *  dimmed under a veil, clicks pick/drag ONLY locations). */
export type EditTool =
  | "select" | "terrain" | "water" | "forest" | "road" | "erase"
  | "decor" | "object" | "move" | "roadsel" | "region" | "locations" | "zone";

/** What the "object" tool places (interactive objects, unlike the decor tool's landmarks). */
export type PlaceObjectKind =
  | "treasure" | "village" | "ruin" | "stack"
  | "merchant" | "mage" | "trainer" | "mercenary";

/** How the "region" tool paints a generation zone: a rectangle, a freehand brush, a
 *  thick line, or just the rectangle's perimeter (frame). rect = the whole bbox; the
 *  others build an arbitrary CELL MASK that clips generation to a hand-drawn shape. */
export type ZoneMode = "rect" | "brush" | "line" | "frame";

export const useToolStore = defineStore("tool", () => {
  const tool = ref<EditTool>("select");
  /** Square brush side in cells (1, 3, 5). */
  const size = ref(1);
  /** Land terrain id painted by the "terrain" tool (1=HU,2=DW,3=HE,4=UN,5=NE,6=EL). */
  const terrainId = ref(5);
  /** Catalog id of the decoration the "decor" tool will place (null = none picked). */
  const decorId = ref<string | null>(null);
  /** What the "object" tool places (руина/город/сундук/отряд/сайты). */
  const objectKind = ref<PlaceObjectKind>("treasure");
  /** Gunit id of the leader a placed stack starts with (обязателен для «Отряд»). */
  const stackLeaderId = ref<string | null>(null);
  /** Object id picked by the "move" tool, awaiting a drop click (null = none picked). */
  const moveId = ref<string | null>(null);
  /** Cells of the road segment currently selected by the "roadsel" tool. */
  const roadSel = ref<{ x: number; y: number }[]>([]);
  /** The roadsel anchor cell + expansion level (0=прямая, 1=нить, 2=вся сеть). Lifted here
   *  so BOTH the canvas re-click and the floating RoadActionBar's «Больше» share them. */
  const roadAnchor = ref<{ x: number; y: number } | null>(null);
  const roadLevel = ref(0);
  /** The rectangle selected by the "region" tool (for Copilot generation); null = none.
   *  For mask modes this is the bounding box of the painted cells (display + LLM + bbox-size). */
  const region = ref<{ x: number; y: number; w: number; h: number } | null>(null);
  /** How the region tool draws (rect = bbox fill; brush/line/frame paint a cell mask). */
  const zoneMode = ref<ZoneMode>("rect");
  /** The hand-drawn cell mask ("x,y" keys); null = use the whole `region` bbox (rect mode). */
  const regionMask = ref<string[] | null>(null);
  /** Temporarily hide the zone overlay (so it doesn't obscure the generated result). */
  const zoneHidden = ref(false);
  /** "👁 eye" mode: when on and no zone is drawn, the visible screen area IS the zone. */
  const eyeZone = ref(false);
  /** «По рисунку»: a generator recipe armed on the region tool — finishing a stroke
   *  IMMEDIATELY generates along it (road/river follow the line; decor sprinkles along
   *  the brush). null = the region tool is a plain Copilot zone selector. */
  const drawGenRecipe = ref<string | null>(null);
  /** Deep-link focus (?obj= in the share URL): the object/zone id to centre, select and
   *  blink once the scene is built. Cleared after the focus fires. */
  const focusObjectId = ref<string | null>(null);
  /** PRIMARY selected object (drives ObjectInspector + pick-below cycling), null = none. */
  const selectedId = ref<string | null>(null);
  /** The FULL multi-selection (Shift+клик / Shift+рамка). Invariant: selectedId ∈ selectedIds
   *  (or both empty). Single-click selection is the degenerate case [id]. Drives the outline,
   *  group move and the SelectionActionBar. */
  const selectedIds = ref<string[]>([]);

  /** «Локации»-tool role filter: which locations stay bright + pickable in the mode.
   *  free = не используется ни одним событием; enter/stackIn/itemTo = триггер-подтипы
   *  (вход в зону / отряд в зоне / предмет в зону); spawn/destination/env = класс роли. */
  const locFilter = ref<LocFilter>("all");
  function setLocFilter(f: LocFilter): void {
    locFilter.value = f;
  }

  /** «🎯 выбрать на карте» pick mode for event ref-fields: while non-null, the NEXT map
   *  click on an object of one of these types resolves the pick (MapCanvasHost hooks it;
   *  Esc cancels). startObjectPick returns a TOKEN; the result carries it back so ONLY the
   *  field that requested this pick consumes it (several fields watch the same store). */
  const objectPickTypes = ref<string[] | null>(null);
  const objectPickResult = ref<{ id: string; nonce: number } | null>(null);
  let pickSeq = 0;
  let pickToken = 0;
  function startObjectPick(types: string[]): number {
    objectPickTypes.value = types;
    pickToken = ++pickSeq;
    return pickToken;
  }
  function finishObjectPick(id: string | null): void {
    objectPickTypes.value = null;
    if (id) objectPickResult.value = { id, nonce: pickToken };
  }

  const painting = (): boolean => tool.value !== "select";

  function setTool(t: EditTool): void {
    tool.value = t;
    if (t !== "region") drawGenRecipe.value = null; // switching tools disarms «по рисунку»
  }

  /** Arm/disarm the «по рисунку» generator: arming enters the region tool with a fitting
   *  draw mode (paths → line, scatter → brush); disarming leaves the tool too. */
  function setDrawGen(recipeId: string | null): void {
    drawGenRecipe.value = recipeId;
    if (recipeId) {
      tool.value = "region";
      const isPath = recipeId === "road_path" || recipeId === "river";
      zoneMode.value = isPath ? "line" : "brush";
      if (isPath) size.value = 1; // a path follows the stroke exactly (no 3-wide band)
      region.value = null;
      regionMask.value = null;
      zoneHidden.value = false;
    } else if (tool.value === "region") {
      tool.value = "select";
      clearZone();
    }
  }
  function setSize(s: number): void {
    size.value = s;
  }
  function setTerrainId(id: number): void {
    terrainId.value = id;
  }
  /** Pick a decoration to place; also switches to the decor tool. */
  function setDecor(id: string | null): void {
    decorId.value = id;
    if (id) tool.value = "decor";
  }
  /** Pick what the object tool places; also switches to the object tool. */
  function setObjectKind(k: PlaceObjectKind): void {
    objectKind.value = k;
    tool.value = "object";
  }
  /** Set/clear the object the move tool is carrying. */
  function setMoveId(id: string | null): void {
    moveId.value = id;
  }
  /** Set/clear the selected road-segment cells. Clearing also drops the anchor/level. */
  function setRoadSel(cells: { x: number; y: number }[]): void {
    roadSel.value = cells;
    if (cells.length === 0) {
      roadAnchor.value = null;
      roadLevel.value = 0;
    }
  }
  /** Set/clear the Copilot generation region (bbox). */
  function setRegion(r: { x: number; y: number; w: number; h: number } | null): void {
    region.value = r;
  }
  function setZoneMode(m: ZoneMode): void {
    zoneMode.value = m;
  }
  /** Set/clear the hand-drawn cell mask. */
  function setRegionMask(cells: string[] | null): void {
    regionMask.value = cells && cells.length ? cells : null;
  }
  function setZoneHidden(h: boolean): void {
    zoneHidden.value = h;
  }
  function setEyeZone(v: boolean): void {
    eyeZone.value = v;
  }
  /** Selected free-form ZONE (a project entity, not a map object) — mutually exclusive
   *  with the object selection so the inspector shows exactly one thing. */
  const selectedZoneId = ref<string | null>(null);
  /** Zone queued for REGENERATION in the «Зона» tool (the drawn mask replaces its tiles).
   *  Lifted here so the zone inspector's «Перегенерировать» can preset the tool. */
  const regenZoneId = ref<string>("");
  function setSelectedZone(zid: string | null): void {
    selectedZoneId.value = zid;
    if (zid) {
      selectedId.value = null;
      selectedIds.value = [];
    }
  }

  function setSelectedId(id: string | null): void {
    selectedId.value = id;
    selectedIds.value = id ? [id] : [];
    if (id) selectedZoneId.value = null;
  }
  /** Shift+клик: toggle an object in/out of the multi-selection (primary follows). */
  function toggleSelected(id: string): void {
    const list = selectedIds.value.slice();
    const i = list.indexOf(id);
    if (i >= 0) {
      list.splice(i, 1);
      selectedIds.value = list;
      if (selectedId.value === id) selectedId.value = list[list.length - 1] ?? null;
    } else {
      list.push(id);
      selectedIds.value = list;
      selectedId.value = id;
    }
  }
  /** Shift+рамка: union `ids` into the selection (primary = last of the batch). */
  function addSelected(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const set = new Set(selectedIds.value);
    for (const id of ids) set.add(id);
    selectedIds.value = [...set];
    selectedId.value = ids[ids.length - 1]!;
  }
  /** Clear the whole zone selection (region bbox + mask) — the "accept"/done action. */
  function clearZone(): void {
    region.value = null;
    regionMask.value = null;
    zoneHidden.value = false;
  }

  return {
    tool, size, terrainId, decorId, objectKind, stackLeaderId, setObjectKind, moveId, roadSel, roadAnchor, roadLevel, region, zoneMode, regionMask, zoneHidden, eyeZone, drawGenRecipe, setDrawGen, focusObjectId, selectedId, selectedIds,
    selectedZoneId, setSelectedZone, regenZoneId,
    locFilter, setLocFilter,
    objectPickTypes, objectPickResult, startObjectPick, finishObjectPick,
    painting, setTool, setSize, setTerrainId, setDecor, setMoveId, setRoadSel,
    setRegion, setZoneMode, setRegionMask, setZoneHidden, setEyeZone, setSelectedId, toggleSelected, addSelected, clearZone,
  };
});
