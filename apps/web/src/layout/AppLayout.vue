<script setup lang="ts">
/**
 * The Element Plus application shell: a header (menu bar), a body split into a
 * left object panel + the Pixi canvas host, and a footer status bar.
 *
 * Vue owns this DOM chrome; the <MapCanvasHost> is the only seam where PixiJS
 * takes over a div and renders the map.
 */
import { computed, onMounted, onBeforeUnmount } from "vue";
import { storeToRefs } from "pinia";
import { useRoadActions } from "../composables/roadActions";
import { useSelectionActions } from "../composables/selectionActions";
import { useViewStore } from "../stores/viewStore";
import { useToolStore } from "../stores/toolStore";
import { useDecorStore } from "../stores/decorStore";
import { useEditStore } from "../stores/editStore";
import { useMapStore } from "../stores/mapStore";
import { getScene } from "../canvas/sceneHolder";
import TopMenuBar from "./TopMenuBar.vue";
import ToolDock from "./ToolDock.vue";
import ToolOptionsBar from "./ToolOptionsBar.vue";
import LeftObjectPanel from "./LeftObjectPanel.vue";
import ObjectInspector from "./ObjectInspector.vue";
import ZoneInspector from "./ZoneInspector.vue";
import StatusBar from "./StatusBar.vue";
import CopilotBar from "./CopilotBar.vue";
import DecorPalette from "./DecorPalette.vue";
import EventsPanel from "./EventsPanel.vue";
import ObjectActionBar from "./ObjectActionBar.vue";
import RoadActionBar from "./RoadActionBar.vue";
import SelectionActionBar from "./SelectionActionBar.vue";
import HistoryPanel from "./HistoryPanel.vue";
import MinimapDock from "./MinimapDock.vue";
import MapCanvasHost from "../canvas/MapCanvasHost.vue";

const view = useViewStore();
const toolStore = useToolStore();
const decorStore = useDecorStore();
const editStore = useEditStore();
const mapStore = useMapStore();
const { currentScenarioId } = storeToRefs(mapStore);
const roadActions = useRoadActions();
const selActions = useSelectionActions();

/** Cities/capitals show a double garrison (2 vertical formations) — give them a wider rail.
 *  Widths are clamp()'d so rails SHRINK on narrow windows instead of pushing off-screen. */
const inspectorWidth = computed(() => {
  const id = toolStore.selectedId;
  const o = id ? editStore.liveDoc?.objects.find((x) => x.id === id) : null;
  return o && (o.type === "capital" || o.type === "village" || o.type === "stack")
    ? "clamp(250px, 28vw, 320px)"
    : "clamp(220px, 24vw, 260px)";
});

/** Global view hotkeys (single keys; ignored while typing or with modifiers). */
function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  // Global undo/redo: Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y), the single source of truth.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y")) {
    if (typing) return;
    const redo = (e.key === "y" || e.key === "Y") || e.shiftKey;
    if (redo) editStore.redoEdit();
    else editStore.undoEdit();
    e.preventDefault();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (typing) return;
  // road-select tool: Delete erases the selected segment, Escape clears it
  // (same actions as the floating RoadActionBar — shared via useRoadActions).
  if (toolStore.tool === "roadsel" && toolStore.roadSel.length) {
    if (e.key === "Delete" || e.key === "Backspace") {
      roadActions.eraseSelected();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      roadActions.clearSelection();
      e.preventDefault();
      return;
    }
  }
  // select tool, multi-selection: Delete removes the whole set (one undo stroke).
  if (
    (e.key === "Delete" || e.key === "Backspace") &&
    toolStore.tool === "select" &&
    toolStore.selectedIds.length > 1
  ) {
    selActions.deleteSelected();
    e.preventDefault();
    return;
  }
  // move tool: Escape drops the carried object without moving it.
  if (e.key === "Escape" && toolStore.tool === "move" && toolStore.moveId) {
    toolStore.setMoveId(null);
    e.preventDefault();
    return;
  }
  // Escape clears the selection (closes the object/zone inspector rail).
  if (e.key === "Escape" && (toolStore.selectedId || toolStore.selectedZoneId)) {
    toolStore.setSelectedId(null);
    toolStore.setSelectedZone(null);
    e.preventDefault();
    return;
  }
  // move tool, carrying a re-rollable object: R = random look, [ ] , . = cycle look.
  if (toolStore.tool === "move" && toolStore.moveId) {
    const obj = editStore.liveDoc?.objects.find((o) => o.id === toolStore.moveId);
    const curId = obj ? decorStore.catalogIdOf(obj) : null;
    if (obj && curId) {
      let next: string | null = null;
      if (e.key === "r" || e.key === "R") next = decorStore.randomVariant(curId);
      else if (e.key === "[" || e.key === "]" || e.key === "," || e.key === ".")
        next = decorStore.neighbor(curId, e.key === "[" || e.key === "," ? -1 : 1);
      if (next) {
        const fields = decorStore.variantPatch(obj, next);
        if (fields) editStore.commit([{ kind: "patchObject", id: obj.id, fields }]);
        e.preventDefault();
        return;
      }
    }
  }
  // decor tool: cycle the picked variant ([ ] , .) or roll a random look (R).
  if (toolStore.tool === "decor") {
    if (e.key === "[" || e.key === "]" || e.key === "," || e.key === ".") {
      const dir = e.key === "[" || e.key === "," ? -1 : 1;
      const next = decorStore.neighbor(toolStore.decorId, dir);
      if (next) toolStore.setDecor(next);
      e.preventDefault();
      return;
    }
    if (e.key === "r" || e.key === "R") {
      const next = decorStore.randomVariant(toolStore.decorId);
      if (next) toolStore.setDecor(next);
      e.preventDefault();
      return;
    }
  }
  switch (e.key.toLowerCase()) {
    case "t": view.setLayerVisible("terrain", !view.terrainVisible); break;
    case "o": view.setLayerVisible("objects", !view.objectsVisible); break;
    case "g": view.toggleGrid(); break;
    case "l": view.toggleLocations(); break;
    case "a": view.toggleAnimate(); break;
    case "p": view.toggleObjectPanel(); break;
    case "e": view.toggleEventPanel(); break;
    case "d": view.toggleDebugOverlay(); break;
    case "f": getScene()?.fitView(); break;
    case "/": view.focusCopilot(); break;
    default: return;
  }
  e.preventDefault();
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <el-container class="app-root">
    <el-header class="app-header" height="40px">
      <TopMenuBar />
    </el-header>
    <el-container class="app-body">
      <ToolDock />
      <el-aside v-if="view.objectPanelVisible" class="app-aside" width="clamp(180px, 18vw, 220px)">
        <LeftObjectPanel />
      </el-aside>
      <el-main class="app-main">
        <MapCanvasHost />
        <ToolOptionsBar v-if="currentScenarioId" />
        <ObjectActionBar v-if="toolStore.tool === 'move'" />
        <RoadActionBar v-if="toolStore.tool === 'roadsel'" />
        <SelectionActionBar v-if="toolStore.tool === 'select'" />
        <CopilotBar v-show="view.copilotVisible" />
        <HistoryPanel />
        <MinimapDock v-if="currentScenarioId" />
      </el-main>
      <el-aside v-if="toolStore.tool === 'decor'" class="app-decor" width="clamp(240px, 26vw, 300px)">
        <DecorPalette />
      </el-aside>
      <!-- zone inspector (mutually exclusive with the object selection by store invariant) -->
      <el-aside v-if="toolStore.selectedZoneId" class="app-inspector" width="clamp(220px, 24vw, 260px)">
        <ZoneInspector />
      </el-aside>
      <el-aside v-if="toolStore.selectedId" class="app-inspector" :width="inspectorWidth">
        <ObjectInspector />
      </el-aside>
      <!-- scenario WINDOW (draggable non-modal dialog; teleports to <body>) -->
      <EventsPanel />
    </el-container>
    <el-footer class="app-footer" height="28px">
      <StatusBar />
    </el-footer>
  </el-container>
</template>

<style scoped>
.app-root {
  height: 100vh;
  width: 100vw;
}
.app-header {
  padding: 0;
}
.app-body {
  flex: 1;
  min-height: 0;
  /* rails clamp() down on narrow windows; anything still over-budget must clip, not push
     the whole app past the viewport edge */
  overflow: hidden;
}
.app-aside,
.app-decor,
.app-inspector {
  min-width: 0;
  overflow: hidden;
}
.app-aside {
  padding: 0;
  overflow: hidden;
}
.app-decor {
  padding: 0;
  overflow: hidden;
}
.app-main {
  padding: 0;
  position: relative;
  min-width: 0;
}
.app-footer {
  padding: 0;
}
</style>
