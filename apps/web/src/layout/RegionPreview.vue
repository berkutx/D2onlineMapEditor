<script setup lang="ts">
/**
 * RegionPreview — a small OVERLAY-FREE snapshot of the map region around a cell (terrain +
 * decor + buildings + chests + stacks; NO location circles/roles/threads/grid), produced by
 * Scene.renderRegionPreview. On top of the snapshot it draws its OWN thin markers:
 *   - mark   — a red cross at the location's anchor cell («вот эта точка»);
 *   - bounds — the location's (2r+1)² area outline (an iso diamond-square);
 *   - cells  — a zone's cell mask («зона» = набор локаций) as translucent diamonds.
 * A 🔍 button (zoomable) opens an enlarged dialog with an adjustable «охват» slider.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { cellToWorld, HALF_W, HALF_H } from "@d2/pixi-render";
import { getScene } from "../canvas/sceneHolder";

interface Cell { x: number; y: number }
interface Bounds { x0: number; y0: number; x1: number; y1: number }

const props = withDefaults(
  defineProps<{
    cell: Cell | null;
    radius?: number;
    width?: number;
    /** красный крестик — якорная клетка локации */
    mark?: Cell | null;
    /** контур области локации (включительно, в клетках) */
    bounds?: Bounds | null;
    /** маска клеток зоны ("x,y") — полупрозрачные ромбы */
    cells?: readonly string[] | null;
    /** показать кнопку-лупу (диалог с увеличением) */
    zoomable?: boolean;
  }>(),
  { radius: 4, width: 240, mark: null, bounds: null, cells: null, zoomable: false },
);

const box = ref<HTMLDivElement | null>(null);
const ok = ref(false);

/** Draw the markers over the snapshot. The transform mirrors renderRegionPreview:
 *  scale z fits (2r+1) cells into the canvas width; the view centres on cell+0.5. */
function drawOverlays(canvas: HTMLCanvasElement): void {
  if (!props.cell) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const r = Math.max(1, props.radius);
  const pxW = canvas.width, pxH = canvas.height;
  const z = pxW / (2 * (2 * r + 1) * HALF_W);
  const c = cellToWorld(props.cell.x + 0.5, props.cell.y + 0.5);
  const toPx = (wx: number, wy: number): [number, number] =>
    [(wx - c.x) * z + pxW / 2, (wy - c.y) * z + pxH / 2];
  const corner = (x: number, y: number): [number, number] => {
    const w = cellToWorld(x, y); // top vertex of cell (x,y) — the grid corner point
    return toPx(w.x, w.y);
  };
  ctx.save();
  ctx.lineJoin = "round";

  // zone mask — translucent diamonds per cell
  if (props.cells?.length) {
    ctx.fillStyle = "rgba(64,158,255,0.24)";
    ctx.strokeStyle = "rgba(64,158,255,0.55)";
    ctx.lineWidth = 1;
    for (const key of props.cells) {
      const [xs, ys] = key.split(",");
      const x = Number(xs), y = Number(ys);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      ctx.beginPath();
      const p0 = corner(x, y), p1 = corner(x + 1, y), p2 = corner(x + 1, y + 1), p3 = corner(x, y + 1);
      ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
  }

  // границы локации — жёлтый контур области (двойной штрих для читаемости на любом рельефе)
  if (props.bounds) {
    const b = props.bounds;
    const pts = [corner(b.x0, b.y0), corner(b.x1 + 1, b.y0), corner(b.x1 + 1, b.y1 + 1), corner(b.x0, b.y1 + 1)];
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.strokeStyle = "rgba(0,0,0,0.75)"; ctx.lineWidth = 3.5; ctx.stroke();
    ctx.strokeStyle = "#f7ba2a"; ctx.lineWidth = 1.8; ctx.stroke();
  }

  // крестик — якорная точка локации
  if (props.mark) {
    const w = cellToWorld(props.mark.x + 0.5, props.mark.y + 0.5);
    const [mx, my] = toPx(w.x, w.y);
    const a = 7;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(mx - a, my - a); ctx.lineTo(mx + a, my + a); ctx.moveTo(mx + a, my - a); ctx.lineTo(mx - a, my + a); ctx.stroke();
    ctx.strokeStyle = "#f56c6c"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(mx - a, my - a); ctx.lineTo(mx + a, my + a); ctx.moveTo(mx + a, my - a); ctx.lineTo(mx - a, my + a); ctx.stroke();
  }
  ctx.restore();
}

function render(): void {
  const host = box.value;
  if (!host) return;
  host.replaceChildren();
  ok.value = false;
  if (!props.cell) return;
  const canvas = getScene()?.renderRegionPreview(props.cell, { radiusCells: props.radius, pxWidth: props.width });
  if (!canvas) return;
  drawOverlays(canvas);
  canvas.style.cssText = "width:100%;height:auto;display:block;image-rendering:pixelated";
  host.appendChild(canvas);
  ok.value = true;
}

watch(
  () => [props.cell?.x, props.cell?.y, props.radius, props.width, props.mark?.x, props.mark?.y,
         props.bounds?.x0, props.bounds?.x1, props.cells?.length],
  () => render(),
);
onMounted(render);
onBeforeUnmount(() => box.value?.replaceChildren());

// --- 🔍 лупа: увеличенный диалог с регулируемым охватом --------------------------------
const zoomOpen = ref(false);
const zoomRadius = ref(props.radius);
watch(zoomOpen, (v) => { if (v) zoomRadius.value = props.radius; });
const zoomSpan = computed(() => 2 * zoomRadius.value + 1);
</script>

<template>
  <div class="region-preview">
    <div ref="box" class="rp-box" />
    <p v-if="!ok" class="rp-empty">нет превью точки</p>
    <button v-if="zoomable && ok" class="rp-zoom" title="Увеличить" type="button" @click="zoomOpen = true">🔍</button>

    <el-dialog v-model="zoomOpen" width="700px" align-center append-to-body title="Точка на карте">
      <RegionPreview
        :cell="cell"
        :radius="zoomRadius"
        :width="660"
        :mark="mark"
        :bounds="bounds"
        :cells="cells"
      />
      <div class="rp-zoom-ctl">
        <span class="rp-zoom-lbl">Охват: {{ zoomSpan }}×{{ zoomSpan }} клеток</span>
        <el-slider v-model="zoomRadius" :min="2" :max="16" :step="1" style="flex:1" />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.region-preview {
  position: relative;
  border: 1px solid var(--el-border-color, #444);
  border-radius: var(--d2-radius-sm, 6px);
  overflow: hidden;
  background: #05070a;
}
.rp-box { line-height: 0; }
.rp-empty {
  margin: 0;
  padding: 12px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.rp-zoom {
  position: absolute;
  top: 4px;
  right: 4px;
  border: none;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.45);
  font-size: 13px;
  line-height: 1;
  padding: 4px 5px;
  cursor: pointer;
}
.rp-zoom:hover { background: rgba(0, 0, 0, 0.7); }
.rp-zoom-ctl {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.rp-zoom-lbl {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
