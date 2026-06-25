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
import type { CameraSnapshot, TerrainMeta } from "@d2/pixi-render";
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
const { terrainVisible, objectsVisible, gridVisible, animate } = storeToRefs(viewStore);

// For now show only the relief: terrain + water (baked into the terrain image) +
// mountains. Other object types are hidden until they're retuned to the tile scale.
const VISIBLE_OBJECT_TYPES = new Set(["mountains"]);

const mountEl = ref<HTMLDivElement | null>(null);
const building = ref(false);
const buildError = ref<string | null>(null);

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
    const texture = await Assets.load<Texture>(`/assets/terrain/${id}.png`);
    await scene.buildScene(doc, man, getAssetStore(), { texture, meta }, VISIBLE_OBJECT_TYPES);
    // apply the current view state to the freshly-built scene
    scene.setLayerVisibility("terrain", terrainVisible.value);
    scene.setLayerVisibility("objects", objectsVisible.value);
    scene.setLayerVisibility("grid", gridVisible.value);
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
watch(animate, (v) => getScene()?.setAnimationEnabled(v));
</script>

<template>
  <div class="canvas-host">
    <div ref="mountEl" class="canvas-mount" />
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
</style>
