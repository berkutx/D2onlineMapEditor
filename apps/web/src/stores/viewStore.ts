/**
 * View state: which logical layers are visible, the animation toggle, and the
 * latest camera snapshot (cursor cell / zoom for the status bar). All plain
 * serialisable values — safe under Vue reactivity. The canvas host watches these
 * and calls the imperative Scene methods.
 */
import { defineStore } from "pinia";
import { ref, watch } from "vue";
import type { LayerName, OverlayTint } from "@d2/pixi-render";

export interface CursorCell {
  x: number;
  y: number;
}

/** Editor-assist tint overlays (passable/danger/terraform/forest/roads). Off by default. */
export type OverlayTints = Record<OverlayTint, boolean>;
const OVERLAY_TINTS: OverlayTint[] = ["passable", "danger", "terraform", "forest", "roads"];

/** Persist the view toggles in the browser so they survive reloads (minimal). */
const STORAGE_KEY = "d2.view.v1";
function loadPersisted(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);

export const useViewStore = defineStore("view", () => {
  const p = loadPersisted();
  const pt = (p.overlayTints ?? {}) as Partial<OverlayTints>;

  const terrainVisible = ref(bool(p.terrainVisible, true));
  const objectsVisible = ref(bool(p.objectsVisible, true));
  const gridVisible = ref(bool(p.gridVisible, true));
  /** Event-location highlights (spawns / trigger regions). On by default. */
  const locationsVisible = ref(bool(p.locationsVisible, true));
  // Animation off for now (objects render their first frame statically); toggle in View.
  const animate = ref(bool(p.animate, false));
  /** Left "Objects" panel — hidden by default; toggle from the View menu. */
  const objectPanelVisible = ref(bool(p.objectPanelVisible, false));
  /** Debug HUD overlay (FPS / render ms / iso engine). On by default for now. */
  const debugOverlay = ref(bool(p.debugOverlay, true));
  /** Copilot floating command input. Always shown on load (NOT persisted, so it can't get
   *  "lost"); toggle for the session via the toolbar / ✕, "/" reveals + focuses it. */
  const copilotVisible = ref(true);
  /** Bumped to ask the copilot input to take focus (the "/" hotkey). Not persisted. */
  const copilotFocusTick = ref(0);
  /** Editor-assist tint overlays — all off by default (opt-in like the editor). */
  const overlayTints = ref<OverlayTints>({
    passable: bool(pt.passable, false),
    danger: bool(pt.danger, false),
    terraform: bool(pt.terraform, false),
    forest: bool(pt.forest, false),
    roads: bool(pt.roads, false),
  });

  /** Camera zoom factor (for the status bar). */
  const zoom = ref(1);
  /** Cursor cell under the pointer, null when off-map. */
  const cursorCell = ref<CursorCell | null>(null);
  /** Bounding box (cells) of what's currently visible on screen — drives the "👁 eye" zone. */
  const visibleCells = ref<{ x: number; y: number; w: number; h: number } | null>(null);

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

  function toggleCopilot(): void {
    copilotVisible.value = !copilotVisible.value;
  }

  /** Reveal the copilot input and ask it to take focus ("/" hotkey). */
  function focusCopilot(): void {
    copilotVisible.value = true;
    copilotFocusTick.value++;
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
  function setVisibleCells(r: { x: number; y: number; w: number; h: number } | null): void {
    visibleCells.value = r;
  }

  // Persist the toggles to localStorage on any change (transient zoom/cursor excluded).
  watch(
    [terrainVisible, objectsVisible, gridVisible, locationsVisible, animate,
      objectPanelVisible, debugOverlay, overlayTints],
    () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          terrainVisible: terrainVisible.value,
          objectsVisible: objectsVisible.value,
          gridVisible: gridVisible.value,
          locationsVisible: locationsVisible.value,
          animate: animate.value,
          objectPanelVisible: objectPanelVisible.value,
          debugOverlay: debugOverlay.value,
          overlayTints: overlayTints.value,
        }));
      } catch {
        /* storage unavailable (private mode / quota) — ignore */
      }
    },
    { deep: true },
  );

  return {
    terrainVisible,
    objectsVisible,
    gridVisible,
    locationsVisible,
    animate,
    objectPanelVisible,
    debugOverlay,
    copilotVisible,
    copilotFocusTick,
    overlayTints,
    zoom,
    cursorCell,
    visibleCells,
    setLayerVisible,
    toggleGrid,
    toggleAnimate,
    toggleLocations,
    toggleObjectPanel,
    toggleDebugOverlay,
    toggleCopilot,
    focusCopilot,
    toggleOverlayTint,
    setZoom,
    setCursorCell,
  };
});

export { OVERLAY_TINTS };
