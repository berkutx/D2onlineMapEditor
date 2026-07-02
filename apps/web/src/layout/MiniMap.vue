<script setup lang="ts">
/**
 * MiniMap — a reusable top-down square render of the map terrain with location
 * markers. Embedded in popovers/panels to help the user verify WHERE a location
 * (or any map object) is: pass `highlightId` to accent it, click to center the
 * main camera on the clicked cell.
 *
 * Pure 2D-canvas (one pixel block per cell), no Pixi involvement: terrain colors
 * come straight from the packed cell bits (CLAUDE.md verified: terrain = v & 7,
 * ground = (v >> 3) & 7 [3 = water], forest = v >>> 26).
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { cellToWorld } from "@d2/pixi-render";
import { useEditStore } from "../stores/editStore";
import { useViewStore } from "../stores/viewStore";
import { getScene } from "../canvas/sceneHolder";

const props = withDefaults(
  defineProps<{
    /** Map-object id to accent (usually a location). */
    highlightId?: string | null;
    /** Canvas CSS size in px (square). */
    size?: number;
    /** Click → center the main camera on the clicked cell. */
    clickToCenter?: boolean;
  }>(),
  {
    highlightId: null,
    size: 160,
    clickToCenter: true,
  },
);

const emit = defineEmits<{
  (e: "centered", cell: { x: number; y: number }): void;
}>();

const editStore = useEditStore();
const viewStore = useViewStore();

const canvasRef = ref<HTMLCanvasElement | null>(null);

// ---------------------------------------------------------------------------
// Fixed terrain palette (canvas doesn't theme — these are literal map colors).
// ---------------------------------------------------------------------------
type Rgb = readonly [number, number, number];
function hexRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
const WATER = hexRgb("#1d4e89"); // ground === 3
const MOUNTAIN = hexRgb("#6e655a"); // ground === 4 (mountains stamp)
const FOREST = hexRgb("#2e5d34"); // forest > 0
/** Race-themed base tiles by `terrain = v & 7`. */
const RACE_COLORS: Readonly<Record<number, Rgb>> = {
  1: hexRgb("#7aa15a"), // Empire (grass)
  2: hexRgb("#d9e4ea"), // Clans (snow)
  3: hexRgb("#8a4a3d"), // Legions (scorched)
  4: hexRgb("#6f7d6a"), // Undead (blight)
  5: hexRgb("#a08d62"), // Neutral (tan)
  6: hexRgb("#5d7d4a"), // Elves
};
const FALLBACK = hexRgb("#857a5f");
const ACCENT = "#ffb44a";

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------
function paint(): void {
  const el = canvasRef.value;
  if (!el) return;
  const ctx = el.getContext("2d");
  if (!ctx) return;

  // Device-pixel-aware backing store; all drawing below is in CSS px.
  const dpr = window.devicePixelRatio || 1;
  const backing = Math.max(1, Math.round(props.size * dpr));
  if (el.width !== backing || el.height !== backing) {
    el.width = backing;
    el.height = backing;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, props.size, props.size);

  const doc = editStore.liveDoc;
  if (!doc) return;
  const n = doc.size;
  if (n <= 0) return;
  const scale = props.size / n;

  // --- Terrain: one pixel per cell into an N×N ImageData, then upscale crisp. ---
  const off = document.createElement("canvas");
  off.width = n;
  off.height = n;
  const octx = off.getContext("2d");
  if (!octx) return;
  const img = octx.createImageData(n, n);
  const data = img.data;
  const cells = doc.terrain.cells;
  const total = n * n;
  for (let i = 0; i < total; i++) {
    const cell = cells[i];
    let rgb: Rgb = FALLBACK;
    if (cell) {
      const v = cell.value;
      const ground = (v >> 3) & 7;
      const forest = v >>> 26;
      if (ground === 3) rgb = WATER;
      else if (ground === 4) rgb = MOUNTAIN;
      else if (forest > 0) rgb = FOREST;
      else rgb = RACE_COLORS[v & 7] ?? FALLBACK;
    }
    const p = i * 4;
    data[p] = rgb[0];
    data[p + 1] = rgb[1];
    data[p + 2] = rgb[2];
    data[p + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, props.size, props.size);

  // --- Locations: faint circles (a location of radius r covers the (2r+1)² cell
  //     square around its cell, so the circle half-extent is r + 0.5 cells). ---
  for (const o of doc.objects) {
    if (o.type !== "location") continue;
    const cx = (o.pos.x + 0.5) * scale;
    const cy = (o.pos.y + 0.5) * scale;
    const r = Math.max((o.radius + 0.5) * scale, 1);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.stroke();
  }

  // --- Highlighted object: accent dot + ring, plus an outer ring for visibility. ---
  const hi = props.highlightId
    ? doc.objects.find((o) => o.id === props.highlightId)
    : undefined;
  if (hi) {
    const cx = (hi.pos.x + 0.5) * scale;
    const cy = (hi.pos.y + 0.5) * scale;
    const ringR =
      hi.type === "location"
        ? Math.max((hi.radius + 0.5) * scale, 3)
        : Math.max(scale, 3);
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(scale * 0.5, 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR + 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // --- Main-camera viewport bbox. ---
  const vc = viewStore.visibleCells;
  if (vc) {
    ctx.strokeStyle = "#ffffff88";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      vc.x * scale + 0.5,
      vc.y * scale + 0.5,
      Math.max(vc.w * scale - 1, 1),
      Math.max(vc.h * scale - 1, 1),
    );
  }
}

// Coalesced repaint (same setTimeout pattern as MapCanvasHost — NOT rAF, which is
// throttled while the pointer sits off-canvas): many triggers within 100 ms → one paint.
let repaintTimer: number | null = null;
function schedulePaint(): void {
  if (repaintTimer !== null) return;
  repaintTimer = window.setTimeout(() => {
    repaintTimer = null;
    paint();
  }, 100);
}

watch(
  [
    () => editStore.rev,
    () => editStore.objectsRev,
    () => props.highlightId,
    () => viewStore.visibleCells,
    () => props.size,
  ],
  schedulePaint,
);

onMounted(paint);
onBeforeUnmount(() => {
  if (repaintTimer !== null) {
    clearTimeout(repaintTimer);
    repaintTimer = null;
  }
});

// ---------------------------------------------------------------------------
// Click → center the MAIN camera on the clicked cell.
// ---------------------------------------------------------------------------
function onClick(ev: MouseEvent): void {
  if (!props.clickToCenter) return;
  const doc = editStore.liveDoc;
  const el = canvasRef.value;
  if (!doc || !el) return;
  const n = doc.size;
  if (n <= 0) return;
  // Use the live client rect (robust if the popover scales the element).
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const x = Math.min(
    Math.max(Math.floor(((ev.clientX - rect.left) / rect.width) * n), 0),
    n - 1,
  );
  const y = Math.min(
    Math.max(Math.floor(((ev.clientY - rect.top) / rect.height) * n), 0),
    n - 1,
  );
  const w = cellToWorld(x + 0.5, y + 0.5);
  getScene()?.getCamera()?.centerOn(w.x, w.y); // emits camera-change → re-render
  emit("centered", { x, y });
}
</script>

<template>
  <canvas
    ref="canvasRef"
    class="minimap"
    :class="{ clickable: clickToCenter }"
    :style="{ width: `${size}px`, height: `${size}px` }"
    @click="onClick"
  />
</template>

<style scoped>
.minimap {
  display: block;
  border: var(--d2-hairline, 1px solid var(--el-border-color));
  border-radius: var(--d2-radius);
  /* Neutral backdrop while no document is loaded (canvas is transparent then). */
  background: var(--el-fill-color-darker, #1a1c20);
}
.minimap.clickable {
  cursor: crosshair;
}
</style>
