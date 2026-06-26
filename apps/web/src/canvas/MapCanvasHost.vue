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
import { storeToRefs } from "pinia";
import { Assets, type Texture } from "pixi.js";
import { Scene } from "@d2/pixi-render";
import type { CameraSnapshot, TerrainMeta, DebugStats } from "@d2/pixi-render";
import { worldToCell } from "@d2/pixi-render";
import { useMapStore } from "../stores/mapStore";
import { useAssetStore } from "../stores/assetStore";
import { useViewStore } from "../stores/viewStore";
import { getAssetStore, getScene, setScene, destroyScene } from "./sceneHolder";

const mapStore = useMapStore();
const assetStore = useAssetStore();
const viewStore = useViewStore();

const { currentMap } = storeToRefs(mapStore);
const { manifest } = storeToRefs(assetStore);
const {
  terrainVisible,
  objectsVisible,
  gridVisible,
  locationsVisible,
  animate,
  debugOverlay,
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
]);

const mountEl = ref<HTMLDivElement | null>(null);
const building = ref(false);
const buildError = ref<string | null>(null);

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
    // the pre-composited terrain image + alignment meta (compose_terrain.py output)
    const meta = (await (await fetch(`/assets/terrain/${id}.json`)).json()) as TerrainMeta;
    // NO mipmaps: the terrain is a large NON-power-of-two texture (4736x2432) and
    // autoGenerateMipmaps on NPOT is buggy on Intel/ANGLE — a mip level comes out
    // corrupted (black/garbage), showing as a black rectangle at the zoom that
    // samples it. Plain linear is the known-good path (tiny shimmer at most).
    const texture = await Assets.load<Texture>(`/assets/terrain/${id}.png`);
    // object placement data (landmark footprints from GLmark.dbf, etc.)
    const objectData = await (await fetch(`/assets/objectdata.json`)).json();
    await scene.buildScene(
      doc,
      man,
      getAssetStore(),
      { texture, meta },
      VISIBLE_OBJECT_TYPES,
      objectData,
    );
    // apply the current view state to the freshly-built scene
    scene.setLayerVisibility("terrain", terrainVisible.value);
    scene.setLayerVisibility("objects", objectsVisible.value);
    scene.setLayerVisibility("grid", gridVisible.value);
    scene.setLayerVisibility("locations", locationsVisible.value);
    scene.setAnimationEnabled(animate.value);
    // seed the status bar with the initial camera zoom
    const cam = scene.getCamera();
    if (cam) viewStore.setZoom(cam.zoom);
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

  // Sync camera changes back into the (reactive) view store for the status bar.
  scene.on({
    onCameraChange: (snap: CameraSnapshot) => {
      viewStore.setZoom(snap.zoom);
    },
  });

  setScene(scene);
  // debug hooks: inspect the live scene graph + asset store from the preview console
  (window as unknown as { __d2scene?: unknown }).__d2scene = scene;
  (window as unknown as { __d2assets?: unknown }).__d2assets = getAssetStore();

  // Report the cursor cell to the status bar (cheap pointer math via the
  // re-exported pure helpers; no Pixi reactivity involved).
  const canvas = scene.canvas;
  if (canvas) {
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
  }

  // poll debug stats for the HUD
  debugTimer = window.setInterval(() => {
    debugStats.value = getScene()?.getDebugStats() ?? null;
  }, 250);

  // If a document is already loaded (startup auto-load races mount), build now.
  if (currentMap.value && manifest.value) await rebuild();
});

function onPointerMove(e: PointerEvent): void {
  const scene = getScene();
  const cam = scene?.getCamera();
  const doc = currentMap.value;
  const canvas = scene?.canvas;
  if (!cam || !doc || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const world = cam.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  const frac = worldToCell(world.x, world.y);
  const cx = Math.floor(frac.x);
  const cy = Math.floor(frac.y);
  if (cx >= 0 && cy >= 0 && cx < doc.size && cy < doc.size) {
    viewStore.setCursorCell({ x: cx, y: cy });
  } else {
    viewStore.setCursorCell(null);
  }
}

function onPointerLeave(): void {
  viewStore.setCursorCell(null);
}

onBeforeUnmount(() => {
  if (debugTimer !== undefined) clearInterval(debugTimer);
  const canvas = getScene()?.canvas;
  if (canvas) {
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerleave", onPointerLeave);
  }
  destroyScene();
});

// Rebuild whenever the open document or the manifest changes.
watch([currentMap, manifest], () => {
  void rebuild();
});

// Imperatively reflect layer/animation toggles onto the live Scene.
watch(terrainVisible, (v) => getScene()?.setLayerVisibility("terrain", v));
watch(objectsVisible, (v) => getScene()?.setLayerVisibility("objects", v));
watch(gridVisible, (v) => getScene()?.setLayerVisibility("grid", v));
watch(locationsVisible, (v) => getScene()?.setLayerVisibility("locations", v));
watch(animate, (v) => getScene()?.setAnimationEnabled(v));
</script>

<template>
  <div class="canvas-host">
    <div ref="mountEl" class="canvas-mount" />
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
