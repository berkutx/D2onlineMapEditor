/**
 * View state: which logical layers are visible, the animation toggle, and the
 * latest camera snapshot (cursor cell / zoom for the status bar). All plain
 * serialisable values — safe under Vue reactivity. The canvas host watches these
 * and calls the imperative Scene methods.
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import type { LayerName } from "@d2/pixi-render";

export interface CursorCell {
  x: number;
  y: number;
}

export const useViewStore = defineStore("view", () => {
  const terrainVisible = ref(true);
  const objectsVisible = ref(true);
  const animate = ref(true);

  /** Camera zoom factor (for the status bar). */
  const zoom = ref(1);
  /** Cursor cell under the pointer, null when off-map. */
  const cursorCell = ref<CursorCell | null>(null);

  function setLayerVisible(layer: LayerName, visible: boolean): void {
    if (layer === "terrain") terrainVisible.value = visible;
    else if (layer === "objects") objectsVisible.value = visible;
  }

  function toggleAnimate(): void {
    animate.value = !animate.value;
  }

  function setZoom(z: number): void {
    zoom.value = z;
  }

  function setCursorCell(cell: CursorCell | null): void {
    cursorCell.value = cell;
  }

  return {
    terrainVisible,
    objectsVisible,
    animate,
    zoom,
    cursorCell,
    setLayerVisible,
    toggleAnimate,
    setZoom,
    setCursorCell,
  };
});
