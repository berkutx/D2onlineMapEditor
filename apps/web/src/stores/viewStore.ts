/**
 * View state: which logical layers are visible, the animation toggle, and the
 * latest camera snapshot (cursor cell / zoom for the status bar). All plain
 * serialisable values — safe under Vue reactivity. The canvas host watches these
 * and calls the imperative Scene methods.
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import type { LayerName, OverlayTint } from "@d2/pixi-render";

export interface CursorCell {
  x: number;
  y: number;
}

/** Editor-assist tint overlays (passable/danger/terraform/forest/roads). Off by default. */
export type OverlayTints = Record<OverlayTint, boolean>;
const OVERLAY_TINTS: OverlayTint[] = ["passable", "danger", "terraform", "forest", "roads"];

export const useViewStore = defineStore("view", () => {
  const terrainVisible = ref(true);
  const objectsVisible = ref(true);
  const gridVisible = ref(true);
  /** Event-location highlights (spawns / trigger regions). On by default. */
  const locationsVisible = ref(true);
  // Animation off for now (objects render their first frame statically); toggle in View.
  const animate = ref(false);
  /** Left "Objects" panel — hidden by default; toggle from the View menu. */
  const objectPanelVisible = ref(false);
  /** Debug HUD overlay (FPS / render ms / iso engine). On by default for now. */
  const debugOverlay = ref(true);
  /** Editor-assist tint overlays — all off by default (opt-in like the editor). */
  const overlayTints = ref<OverlayTints>({
    passable: false, danger: false, terraform: false, forest: false, roads: false,
  });

  /** Camera zoom factor (for the status bar). */
  const zoom = ref(1);
  /** Cursor cell under the pointer, null when off-map. */
  const cursorCell = ref<CursorCell | null>(null);

  function setLayerVisible(layer: LayerName, visible: boolean): void {
    if (layer === "terrain") terrainVisible.value = visible;
    else if (layer === "objects") objectsVisible.value = visible;
    else if (layer === "grid") gridVisible.value = visible;
    else if (layer === "locations") locationsVisible.value = visible;
  }

  function toggleLocations(): void {
    locationsVisible.value = !locationsVisible.value;
  }

  function toggleGrid(): void {
    gridVisible.value = !gridVisible.value;
  }

  function toggleAnimate(): void {
    animate.value = !animate.value;
  }

  function toggleObjectPanel(): void {
    objectPanelVisible.value = !objectPanelVisible.value;
  }

  function toggleDebugOverlay(): void {
    debugOverlay.value = !debugOverlay.value;
  }

  function toggleOverlayTint(cat: OverlayTint): void {
    overlayTints.value = { ...overlayTints.value, [cat]: !overlayTints.value[cat] };
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
    gridVisible,
    locationsVisible,
    animate,
    objectPanelVisible,
    debugOverlay,
    overlayTints,
    zoom,
    cursorCell,
    setLayerVisible,
    toggleGrid,
    toggleAnimate,
    toggleLocations,
    toggleObjectPanel,
    toggleDebugOverlay,
    toggleOverlayTint,
    setZoom,
    setCursorCell,
  };
});

export { OVERLAY_TINTS };
