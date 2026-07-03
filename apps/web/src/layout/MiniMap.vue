<script setup lang="ts">
/**
 * MiniMap — an ISOMETRIC diamond render of the map (same orientation as the main
 * canvas), embedded in popovers/panels. Two modes:
 *  - "terrain": full relief palette + object dots (the dock minimap);
 *  - "simple":  orientation-only — sea + capital/city dots + the highlighted
 *    object, no relief (the event ref-loc picker: relative points beat noise).
 * Click centers the main camera on the clicked cell.
 *
 * Pure 2D-canvas, no Pixi: terrain colors come straight from the packed cell bits
 * (CLAUDE.md verified: terrain = v & 7, ground = (v >> 3) & 7 [3 = water],
 * forest = v >>> 26). Iso: isoX = x − y, isoY = (x + y) / 2 → the N×N cartesian
 * cell image is drawn through one canvas transform, so the diamond is exact.
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
    /** Canvas CSS WIDTH in px; the iso diamond is width × width/2. */
    size?: number;
    /** Click → center the main camera on the clicked cell. */
    clickToCenter?: boolean;
    /** Draw small colored dots for concrete map objects (terrain mode only). */
    showObjects?: boolean;
    /** "terrain" = full relief; "simple" = sea + cities only (see header). */
    mode?: "terrain" | "simple";
  }>(),
  {
    highlightId: null,
    size: 160,
    clickToCenter: true,
    showObjects: false,
    mode: "terrain",
  },
);

const emit = defineEmits<{
  (e: "centered", cell: { x: number; y: number }): void;
}>();

const editStore = useEditStore();
const viewStore = useViewStore();

const canvasRef = ref<HTMLCanvasElement | null>(null);

// ---------------------------------------------------------------------------
// Fixed palettes (canvas doesn't theme — these are literal map colors).
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
/** Simple mode: land is one muted tone — only the SEA reads as relief. */
const SIMPLE_LAND = hexRgb("#4c4a42");
const SIMPLE_SEA = hexRgb("#2b62a3");

/** Terrain-mode object dots (`showObjects`): color + radius (px) per type.
 *  Types NOT listed (landmark/mountains/location/unit/…) are noise — skipped. */
const OBJECT_DOTS: Readonly<Record<string, { color: string; r: number }>> = {
  capital: { color: "#ffd700", r: 1.5 },
  village: { color: "#ffa640", r: 1.5 },
  stack: { color: "#e05555", r: 1 },
  merchant: { color: "#7fd0ff", r: 1 },
  mage: { color: "#7fd0ff", r: 1 },
  trainer: { color: "#7fd0ff", r: 1 },
  mercenary: { color: "#7fd0ff", r: 1 },
  ruin: { color: "#b08fd0", r: 1 },
  crystal: { color: "#6fe0c0", r: 1 },
};
/** Simple-mode dots: ONLY the orientation anchors (столицы и города), larger. */
const SIMPLE_DOTS: Readonly<Record<string, { color: string; r: number }>> = {
  capital: { color: "#ffd700", r: 3 },
  village: { color: "#ffc46e", r: 2 },
};

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------
function paint(): void {
  const el = canvasRef.value;
  if (!el) return;
  const ctx = el.getContext("2d");
  if (!ctx) return;

  const W = props.size;
  const H = Math.round(W / 2); // iso diamond is 2:1

  // Device-pixel-aware backing store; all drawing below is in CSS px.
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.max(1, Math.round(W * dpr));
  const bh = Math.max(1, Math.round(H * dpr));
  if (el.width !== bw || el.height !== bh) {
    el.width = bw;
    el.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const doc = editStore.liveDoc;
  if (!doc) return;
  const n = doc.size;
  if (n <= 0) return;
  /** px per iso unit: isoX spans [−n..n] → W, isoY spans [0..n] → H. */
  const s = W / (2 * n);
  /** Cartesian cell coords (fractional ok) → canvas CSS px. */
  const proj = (x: number, y: number): { px: number; py: number } => ({
    px: s * (x - y) + W / 2,
    py: (s * (x + y)) / 2,
  });

  // --- Terrain: one pixel per cell into an N×N image, drawn through the iso
  //     transform (rotate+shear in one setTransform) → the exact diamond. ---
  const simple = props.mode === "simple";
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
    let rgb: Rgb = simple ? SIMPLE_LAND : FALLBACK;
    if (cell) {
      const v = cell.value;
      const ground = (v >> 3) & 7;
      if (simple) {
        rgb = ground === 3 ? SIMPLE_SEA : SIMPLE_LAND;
      } else {
        const forest = v >>> 26;
        if (ground === 3) rgb = WATER;
        else if (ground === 4) rgb = MOUNTAIN;
        else if (forest > 0) rgb = FOREST;
        else rgb = RACE_COLORS[v & 7] ?? FALLBACK;
      }
    }
    const p = i * 4;
    data[p] = rgb[0];
    data[p + 1] = rgb[1];
    data[p + 2] = rgb[2];
    data[p + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  ctx.save();
  // image (x,y) → device: u = s(x−y)+W/2, v = s(x+y)/2 (then ×dpr).
  ctx.setTransform(s * dpr, (s / 2) * dpr, -s * dpr, (s / 2) * dpr, (W / 2) * dpr, 0);
  ctx.imageSmoothingEnabled = true; // rotated nearest-neighbour moirés — smooth it
  ctx.drawImage(off, 0, 0);
  ctx.restore();

  // --- Map bounds: a faint diamond outline so the shape reads at a glance. ---
  const c0 = proj(0, 0);
  const c1 = proj(n, 0);
  const c2 = proj(n, n);
  const c3 = proj(0, n);
  ctx.beginPath();
  ctx.moveTo(c0.px, c0.py);
  ctx.lineTo(c1.px, c1.py);
  ctx.lineTo(c2.px, c2.py);
  ctx.lineTo(c3.px, c3.py);
  ctx.closePath();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.stroke();

  // --- Object dots: orientation anchors. Simple mode always shows its (small)
  //     set; terrain mode keeps the opt-in showObjects layer. ---
  const dots = simple ? SIMPLE_DOTS : props.showObjects ? OBJECT_DOTS : null;
  if (dots) {
    for (const o of doc.objects) {
      const dot = dots[o.type];
      if (!dot) continue;
      const { px, py } = proj(o.pos.x + 0.5, o.pos.y + 0.5);
      ctx.beginPath();
      ctx.arc(px, py, dot.r, 0, Math.PI * 2);
      ctx.fillStyle = dot.color;
      ctx.fill();
      if (simple) {
        // hairline outline keeps the dots readable over both land and sea
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.stroke();
      }
    }
  }

  // --- Highlighted object: accent dot + iso ELLIPSE ring (a location of radius r
  //     covers the (2r+1)² cell square → half-extent r+0.5 → iso rx = (2r+1)·s). ---
  const hi = props.highlightId
    ? doc.objects.find((o) => o.id === props.highlightId)
    : undefined;
  if (hi) {
    const { px, py } = proj(hi.pos.x + 0.5, hi.pos.y + 0.5);
    const rCells = hi.type === "location" ? hi.radius + 0.5 : 1;
    const rx = Math.max(2 * rCells * s, 4);
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(px, py, rx, rx / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.ellipse(px, py, rx + 2.5, (rx + 2.5) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // --- Main-camera viewport: the cartesian cell rect projects to a diamond. ---
  const vc = viewStore.visibleCells;
  if (vc) {
    const v0 = proj(vc.x, vc.y);
    const v1 = proj(vc.x + vc.w, vc.y);
    const v2 = proj(vc.x + vc.w, vc.y + vc.h);
    const v3 = proj(vc.x, vc.y + vc.h);
    ctx.beginPath();
    ctx.moveTo(v0.px, v0.py);
    ctx.lineTo(v1.px, v1.py);
    ctx.lineTo(v2.px, v2.py);
    ctx.lineTo(v3.px, v3.py);
    ctx.closePath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#ffffff88";
    ctx.stroke();
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
    () => props.showObjects,
    () => props.mode,
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
// Click → center the MAIN camera on the clicked cell (inverse iso projection).
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
  const W = props.size;
  const s = W / (2 * n);
  const px = ((ev.clientX - rect.left) / rect.width) * W;
  const py = ((ev.clientY - rect.top) / rect.height) * (W / 2);
  // invert: px = s(x−y)+W/2, py = s(x+y)/2
  const dx = (px - W / 2) / s; // x − y
  const sy = (2 * py) / s; // x + y
  const clamp = (v: number): number => Math.min(Math.max(Math.floor(v), 0), n - 1);
  const x = clamp((dx + sy) / 2);
  const y = clamp((sy - dx) / 2);
  const w = cellToWorld(x + 0.5, y + 0.5);
  getScene()?.centerOn(w.x, w.y); // centers AND paints now (rAF is throttled off-canvas)
  emit("centered", { x, y });
}
</script>

<template>
  <canvas
    ref="canvasRef"
    class="minimap"
    :class="{ clickable: clickToCenter }"
    :style="{ width: `${size}px`, height: `${Math.round(size / 2)}px` }"
    @click="onClick"
  />
</template>

<style scoped>
.minimap {
  display: block;
  border: var(--d2-hairline, 1px solid var(--el-border-color));
  border-radius: var(--d2-radius);
  /* Neutral backdrop behind the diamond (canvas corners stay transparent). */
  background: var(--el-fill-color-darker, #1a1c20);
}
.minimap.clickable {
  cursor: crosshair;
}
</style>
