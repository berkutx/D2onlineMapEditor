/**
 * Tool state for the map editor: the active brush tool, brush size (1/3/5 like the
 * game), and the land terrain to paint. Plain serialisable refs; MapCanvasHost reads
 * these on pointer events to drive the terrain brush.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

/** select = pan/inspect (no painting); terrain/water/forest/road/erase paint cells;
 *  decor = place a decoration; move = pick+drop an object; roadsel = select a road segment;
 *  region = drag a rectangle for Copilot generation; locations = «режим локаций» (world
 *  dimmed under a veil, clicks pick/drag ONLY locations). */
export type EditTool =
  | "select" | "terrain" | "water" | "forest" | "road" | "erase"
  | "decor" | "move" | "roadsel" | "region" | "locations";

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
  /** Object id picked by the "move" tool, awaiting a drop click (null = none picked). */
  const moveId = ref<string | null>(null);
  /** Cells of the road segment currently selected by the "roadsel" tool. */
  const roadSel = ref<{ x: number; y: number }[]>([]);
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
  /** Object selected for the property inspector (id of a doc object), null = none.
   *  Set by a click in the "select" tool; drives ObjectInspector + the selection outline. */
  const selectedId = ref<string | null>(null);

  /** «Локации»-tool role filter: which locations stay bright + pickable in the mode.
   *  free = не используется ни одним событием; the rest = dominant scenario role. */
  const locFilter = ref<"all" | "free" | "trigger" | "spawn" | "destination" | "env">("all");
  function setLocFilter(f: "all" | "free" | "trigger" | "spawn" | "destination" | "env"): void {
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
  /** Set/clear the object the move tool is carrying. */
  function setMoveId(id: string | null): void {
    moveId.value = id;
  }
  /** Set/clear the selected road-segment cells. */
  function setRoadSel(cells: { x: number; y: number }[]): void {
    roadSel.value = cells;
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
  function setSelectedId(id: string | null): void {
    selectedId.value = id;
  }
  /** Clear the whole zone selection (region bbox + mask) — the "accept"/done action. */
  function clearZone(): void {
    region.value = null;
    regionMask.value = null;
    zoneHidden.value = false;
  }

  return {
    tool, size, terrainId, decorId, moveId, roadSel, region, zoneMode, regionMask, zoneHidden, eyeZone, selectedId,
    locFilter, setLocFilter,
    objectPickTypes, objectPickResult, startObjectPick, finishObjectPick,
    painting, setTool, setSize, setTerrainId, setDecor, setMoveId, setRoadSel,
    setRegion, setZoneMode, setRegionMask, setZoneHidden, setEyeZone, setSelectedId, clearZone,
  };
});
