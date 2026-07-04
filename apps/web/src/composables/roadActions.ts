/**
 * Shared actions on the roadsel tool's selected segment — ONE implementation for the
 * keyboard shortcuts (AppLayout: Del/Esc) and the on-canvas RoadActionBar buttons, so
 * the two surfaces can never drift.
 */
import { computed } from "vue";
import { eraseRoadCells, selectRoadSegment } from "@d2/map-edit";
import { useToolStore } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";

export function useRoadActions() {
  const toolStore = useToolStore();
  const editStore = useEditStore();

  /** Erase the selected segment (one undo stroke), then drop the selection. */
  function eraseSelected(): void {
    const doc = editStore.liveDoc;
    if (!doc || toolStore.roadSel.length === 0) return;
    editStore.commit(eraseRoadCells(doc, toolStore.roadSel));
    toolStore.setRoadSel([]);
  }

  /** Grow the selection one level (прямая → нить → вся сеть) from the click anchor. */
  function expandSelection(): void {
    const doc = editStore.liveDoc;
    const a = toolStore.roadAnchor;
    if (!doc || !a || toolStore.roadLevel >= 2) return;
    toolStore.roadLevel = Math.min(toolStore.roadLevel + 1, 2);
    toolStore.setRoadSel(selectRoadSegment(doc, a.x, a.y, toolStore.roadLevel));
  }

  function clearSelection(): void {
    toolStore.setRoadSel([]);
  }

  const canExpand = computed(() => !!toolStore.roadAnchor && toolStore.roadLevel < 2);

  return { eraseSelected, expandSelection, clearSelection, canExpand };
}
