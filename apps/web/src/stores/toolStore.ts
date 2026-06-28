/**
 * Tool state for the map editor: the active brush tool, brush size (1/3/5 like the
 * game), and the land terrain to paint. Plain serialisable refs; MapCanvasHost reads
 * these on pointer events to drive the terrain brush.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

/** select = pan/inspect (no painting); terrain/water/forest/road/erase paint cells;
 *  decor = place a decoration; move = pick+drop an object; roadsel = select a road segment. */
export type EditTool =
  | "select" | "terrain" | "water" | "forest" | "road" | "erase" | "decor" | "move" | "roadsel";

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

  return {
    tool, size, terrainId, decorId, moveId, roadSel,
    painting, setTool, setSize, setTerrainId, setDecor, setMoveId, setRoadSel,
  };
});
