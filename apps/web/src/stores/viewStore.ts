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

  /** One-off migration: the map now loads CLEAN — locations/roles overlays off and the minimap
   *  collapsed. Older browsers persisted these ON; force them off ONCE (then respect the user's
   *  choice). New defaults are also false, so fresh loads are clean too. */
  const cleanMigrated = p.cleanDefaultsMigrated === true;

  const terrainVisible = ref(bool(p.terrainVisible, true));
  const objectsVisible = ref(bool(p.objectsVisible, true));
  const gridVisible = ref(bool(p.gridVisible, true));
  /** Event-location highlights (spawns / trigger regions). OFF by default — the map is cluttered
   *  with 400+ of them on real maps; turn on from Вид, or the «Локации» tool enables them. */
  const locationsVisible = ref(cleanMigrated ? bool(p.locationsVisible, false) : false);
  // Animation off for now (objects render their first frame statically); toggle in View.
  const animate = ref(bool(p.animate, false));
  /** Left "Objects" panel — hidden by default; toggle from the View menu. */
  const objectPanelVisible = ref(bool(p.objectPanelVisible, false));
  /** Events panel (scenario triggers/effects). Hidden by default; toggle from the View menu. */
  const eventPanelVisible = ref(bool(p.eventPanelVisible, false));
  /** Scenario «Граф связей» column inside the events tab. OFF by default so the default
   *  layout is a roomy list | editor 2-column (the graph is a space hog that shows little
   *  until you want it); toggled from a button in the events toolbar. Persisted. */
  const eventGraphVisible = ref(bool(p.eventGraphVisible, false));
  /** «Связи»: the editor-only anchors overlay (⚓ + child→parent arrows). */
  const anchorsVisible = ref(bool(p.anchorsVisible, false));
  /** «Роли локаций»: rings + role badges (⚡✨➜☁) on event-wired locations. OFF by default
   *  (part of the clean-map default), but they RIDE ALONG with the locations layer: turning
   *  «Локации» on shows the roles too (they live on the location rings — locations without
   *  them are anonymous circles). The menu toggle still overrides per direction afterwards.
   *  One-off migration: earlier builds persisted rolesVisible=false independently — re-couple
   *  it to the persisted locations state once, then respect the user's explicit choice. */
  const rolesFollowMigrated = p.rolesFollowMigrated === true;
  const rolesVisible = ref(
    rolesFollowMigrated
      ? bool(p.rolesVisible, false)
      : (cleanMigrated ? bool(p.locationsVisible, false) : false),
  );
  /** Floating minimap dock. COLLAPSED by default (a small 🗺 button, bottom-right); click to
   *  expand. true = expanded card, false = collapsed FAB. */
  const minimapVisible = ref(cleanMigrated ? bool(p.minimapVisible, false) : false);
  /** Debug HUD overlay (FPS / render ms / iso engine). OFF by default (product decision);
   *  the one-off migration flips earlier persisted defaults off once. */
  const debugOverlay = ref(p.debugOffMigrated ? bool(p.debugOverlay, false) : false);
  /** Copilot floating command input. Always shown on load (NOT persisted, so it can't get
   *  "lost"); toggle for the session via the toolbar / ✕, "/" reveals + focuses it. */
  const copilotVisible = ref(true);
  /** Bumped to ask the copilot input to take focus (the "/" hotkey). Not persisted. */
  const copilotFocusTick = ref(0);
  /** Dark chrome (panels/menus) — default ON to match the dark canvas; the user
   *  can switch to light via View ▸ Appearance. Applied to <html class="dark">
   *  so Element Plus' dark css-vars take over. Persisted. */
  const dark = ref(bool(p.dark, true));
  function applyDark(): void {
    document.documentElement.classList.toggle("dark", dark.value);
  }
  function toggleDark(): void {
    dark.value = !dark.value;
    applyDark();
  }
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
  /** Exact visible cells ("x,y") — the iso diamond on screen (the bbox over-covers it). The
   *  eye zone uses this as a mask so generation matches what you actually see. */
  const visibleMask = ref<string[] | null>(null);

  function setLayerVisible(layer: LayerName, visible: boolean): void {
    if (layer === "terrain") terrainVisible.value = visible;
    else if (layer === "objects") objectsVisible.value = visible;
    else if (layer === "grid") gridVisible.value = visible;
    else if (layer === "locations") {
      locationsVisible.value = visible;
      rolesVisible.value = visible; // roles ride along; «Роли локаций» re-toggles individually
    }
  }

  function toggleLocations(): void {
    locationsVisible.value = !locationsVisible.value;
    rolesVisible.value = locationsVisible.value; // roles ride along by default
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

  function toggleEventPanel(): void {
    eventPanelVisible.value = !eventPanelVisible.value;
  }

  function toggleEventGraph(): void {
    eventGraphVisible.value = !eventGraphVisible.value;
  }

  function toggleAnchors(): void {
    anchorsVisible.value = !anchorsVisible.value;
  }

  function toggleRoles(): void {
    rolesVisible.value = !rolesVisible.value;
  }

  function toggleMinimap(): void {
    minimapVisible.value = !minimapVisible.value;
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
  function setVisibleMask(cells: string[] | null): void {
    visibleMask.value = cells && cells.length ? cells : null;
  }

  // Apply persisted dark chrome immediately on store init (before first paint).
  applyDark();

  // Persist the toggles to localStorage on any change (transient zoom/cursor excluded).
  watch(
    [terrainVisible, objectsVisible, gridVisible, locationsVisible, animate,
      objectPanelVisible, eventPanelVisible, eventGraphVisible, anchorsVisible, rolesVisible, minimapVisible, debugOverlay, dark, overlayTints],
    () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          terrainVisible: terrainVisible.value,
          objectsVisible: objectsVisible.value,
          gridVisible: gridVisible.value,
          locationsVisible: locationsVisible.value,
          animate: animate.value,
          objectPanelVisible: objectPanelVisible.value,
          eventPanelVisible: eventPanelVisible.value,
          eventGraphVisible: eventGraphVisible.value,
          anchorsVisible: anchorsVisible.value,
          rolesVisible: rolesVisible.value,
          minimapVisible: minimapVisible.value,
          debugOverlay: debugOverlay.value,
          debugOffMigrated: true,
          cleanDefaultsMigrated: true,
          rolesFollowMigrated: true,
          dark: dark.value,
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
    eventPanelVisible,
    eventGraphVisible,
    anchorsVisible,
    rolesVisible,
    minimapVisible,
    debugOverlay,
    copilotVisible,
    copilotFocusTick,
    dark,
    toggleDark,
    overlayTints,
    zoom,
    cursorCell,
    visibleCells,
    visibleMask,
    setLayerVisible,
    toggleGrid,
    toggleAnimate,
    toggleLocations,
    toggleObjectPanel,
    toggleEventPanel,
    toggleEventGraph,
    toggleAnchors,
    toggleRoles,
    toggleMinimap,
    toggleDebugOverlay,
    toggleCopilot,
    focusCopilot,
    toggleOverlayTint,
    setZoom,
    setCursorCell,
    setVisibleCells,
    setVisibleMask,
  };
});

export { OVERLAY_TINTS };
