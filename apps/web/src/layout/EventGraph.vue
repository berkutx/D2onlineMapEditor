<script setup lang="ts">
/**
 * EventGraph — the star topology of ONE scenario event, the visual heart of the scenario
 * window. Center = the event; left = its conditions (with entity satellites further left,
 * plus OTHER events that enable/disable this one, dashed); right = its effects (with entity
 * satellites further right — objects, players, vars, spells, items, templates BY NAME, and
 * enable-chain targets). Clicking an event satellite recenters the graph on it; clicking a
 * var satellite jumps to the Переменные tab; clicking an object satellite selects it on the
 * map (the overlay + inspector follow).
 *
 * Navigation is viewBox-based (trackpad-first, no mouse assumed): wheel = zoom toward the
 * cursor, pointer drag = pan (only after >4px so node clicks still work), floating +/−/⤢
 * cluster top-right; selecting another event re-fits to the content bbox.
 */
import { computed, ref, watch } from "vue";
import { ElEmpty, ElMessageBox, ElTooltip } from "element-plus";
import type { EventCondition, EventEffect } from "@d2/map-schema";
import { CONDITION_BY_KIND, EFFECT_BY_KIND } from "@d2/map-schema";
import { useEventStore } from "../stores/eventStore";
import { useToolStore } from "../stores/toolStore";
import { useRefNames, type ResolvedRef } from "../services/refNames";

const store = useEventStore();
const toolStore = useToolStore();
const names = useRefNames();

// ---- layout constants (viewBox units) ----------------------------------------------------
const W = 1080;
const COL = { satL: 14, cond: 236, center: 452, eff: 634, satR: 852 }; // x of column left edge
const BW = { sat: 210, cond: 198, center: 172, eff: 200 }; // box widths
const NODE_H = 34; // condition/effect/satellite box height
const GAP = 12;

interface GNode {
  x: number; y: number; w: number; h: number;
  title: string; sub?: string; icon?: string;
  cls: string; // css class: g-cond / g-eff / g-center / g-sat / g-evt
  click?: () => void;
  tip?: string;
}
/** a/b = indices into `nodes` — the hover highlight walks edges by node index. */
interface GEdge { x1: number; y1: number; x2: number; y2: number; cls: string; a: number; b: number }

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Stack `count` boxes of height NODE_H centered around cy. Returns each box's y. */
function stackYs(count: number, cy: number): number[] {
  const total = count * NODE_H + (count - 1) * GAP;
  const y0 = cy - total / 2;
  return Array.from({ length: count }, (_, i) => y0 + i * (NODE_H + GAP));
}

const graph = computed<{ nodes: GNode[]; edges: GEdge[]; h: number } | null>(() => {
  const sel = store.selected;
  if (!sel) return null;

  const conds = sel.conditions.map((c: EventCondition) => ({
    spec: CONDITION_BY_KIND[c.kind],
    part: c as unknown as Record<string, unknown>,
    refs: names.refsOf(c as unknown as Record<string, unknown>, CONDITION_BY_KIND[c.kind]),
  }));
  const effs = sel.effects.map((e: EventEffect) => ({
    spec: EFFECT_BY_KIND[e.kind],
    part: e as unknown as Record<string, unknown>,
    refs: names.refsOf(e as unknown as Record<string, unknown>, EFFECT_BY_KIND[e.kind]),
  }));
  const enablers = names.enablersOf(sel.id);

  // left satellites: enabler events first (dashed into the CENTER), then the conditions'
  // entity refs (each linked to its condition box). Right satellites: the effects' refs.
  const leftSats: { ref?: ResolvedRef; evId?: string; owner: number | "center" }[] = [
    ...enablers.map((e) => ({ evId: e.id, owner: "center" as const })),
    ...conds.flatMap((c, i) => c.refs.map((r) => ({ ref: r, owner: i as number | "center" }))),
  ];
  const rightSats = effs.flatMap((e, i) => e.refs.map((r) => ({ ref: r, owner: i })));

  const rows = Math.max(conds.length, effs.length, leftSats.length, rightSats.length, 1);
  const h = Math.max(300, rows * (NODE_H + GAP) + 80);
  const cy = h / 2;

  const nodes: GNode[] = [];
  const edges: GEdge[] = [];

  // center event
  const centerH = 46;
  const center: GNode = {
    x: COL.center, y: cy - centerH / 2, w: BW.center, h: centerH,
    title: truncate(sel.name || "(без имени)", 22), sub: sel.id, icon: "⚑",
    cls: "g-center", tip: `${sel.name} · ${sel.id}`,
  };
  nodes.push(center);
  const centerIdx = 0;

  // conditions column (click = scroll the editor column to that card)
  const condYs = stackYs(conds.length, cy);
  const condIdx: number[] = [];
  conds.forEach((c, i) => {
    const y = condYs[i]!;
    nodes.push({
      x: COL.cond, y, w: BW.cond, h: NODE_H,
      title: truncate(c.spec?.label ?? "условие", 26),
      sub: c.refs.length ? truncate(c.refs.map((r) => r.text).join(", "), 30) : undefined,
      icon: "⚡", cls: "g-cond", tip: "к карточке условия →",
      click: () => store.revealCard("cond", i),
    });
    condIdx.push(nodes.length - 1);
    edges.push({ x1: COL.cond + BW.cond, y1: y + NODE_H / 2, x2: center.x, y2: cy, cls: "e-cond", a: condIdx[i]!, b: centerIdx });
  });

  // effects column (click = scroll the editor column to that card)
  const effYs = stackYs(effs.length, cy);
  const effIdx: number[] = [];
  effs.forEach((e, i) => {
    const y = effYs[i]!;
    nodes.push({
      x: COL.eff, y, w: BW.eff, h: NODE_H,
      title: truncate(`${i + 1}. ${e.spec?.label ?? "эффект"}`, 27),
      sub: e.refs.length ? truncate(e.refs.map((r) => r.text).join(", "), 30) : undefined,
      icon: "★", cls: "g-eff", tip: "к карточке эффекта →",
      click: () => store.revealCard("eff", i),
    });
    effIdx.push(nodes.length - 1);
    edges.push({ x1: center.x + center.w, y1: cy, x2: COL.eff, y2: y + NODE_H / 2, cls: "e-eff", a: centerIdx, b: effIdx[i]! });
  });

  // left satellites (enabler events + condition entities)
  const lYs = stackYs(leftSats.length, cy);
  leftSats.forEach((s, i) => {
    const y = lYs[i]!;
    if (s.evId) {
      const ev = s.evId;
      nodes.push({
        x: COL.satL, y, w: BW.sat, h: NODE_H,
        title: truncate(names.eventName(ev), 24), sub: "включает это событие", icon: "⚑",
        cls: "g-evt", click: () => store.navigate({ tab: "events", eventId: ev }), tip: ev,
      });
      edges.push({ x1: COL.satL + BW.sat, y1: y + NODE_H / 2, x2: center.x, y2: cy - 8, cls: "e-chain", a: nodes.length - 1, b: centerIdx });
    } else if (s.ref) {
      const r = s.ref;
      nodes.push({
        x: COL.satL, y, w: BW.sat, h: NODE_H,
        title: truncate(r.text, 24), sub: r.fieldLabel, icon: names.icon(r),
        cls: "g-sat", click: satClick(r), tip: String(r.value),
      });
      const oy = condYs[s.owner as number]! + NODE_H / 2;
      edges.push({ x1: COL.satL + BW.sat, y1: y + NODE_H / 2, x2: COL.cond, y2: oy, cls: "e-sat", a: nodes.length - 1, b: condIdx[s.owner as number]! });
    }
  });

  // right satellites (effect entities; event targets recenter, dashed)
  const rYs = stackYs(rightSats.length, cy);
  rightSats.forEach((s, i) => {
    const y = rYs[i]!;
    const r = s.ref;
    const isEvt = r.kind === "event";
    nodes.push({
      x: COL.satR, y, w: BW.sat, h: NODE_H,
      title: truncate(r.text, 24), sub: r.fieldLabel, icon: names.icon(r),
      cls: isEvt ? "g-evt" : "g-sat", click: satClick(r), tip: String(r.value),
    });
    const oy = effYs[s.owner]! + NODE_H / 2;
    edges.push({ x1: COL.eff + BW.eff, y1: oy, x2: COL.satR, y2: y + NODE_H / 2, cls: isEvt ? "e-chain" : "e-sat", a: effIdx[s.owner]!, b: nodes.length - 1 });
  });

  return { nodes, edges, h };
});

// ---- hover highlight: a node lights up its edges + neighbours, the rest dims -------------
const hoverNode = ref<number | null>(null);
const hotEdges = computed<Set<number>>(() => {
  const g = graph.value;
  const hv = hoverNode.value;
  if (!g || hv === null) return new Set();
  const out = new Set<number>();
  g.edges.forEach((e, i) => {
    if (e.a === hv || e.b === hv) out.add(i);
  });
  return out;
});
const hotNodes = computed<Set<number>>(() => {
  const g = graph.value;
  const hv = hoverNode.value;
  if (!g || hv === null) return new Set();
  const out = new Set<number>([hv]);
  for (const i of hotEdges.value) {
    const e = g.edges[i]!;
    out.add(e.a);
    out.add(e.b);
  }
  return out;
});

/** Satellite click: events recenter, vars jump to their tab, map objects get selected.
 *  Every in-window jump goes through navigate() so «← Назад» / breadcrumbs can return. */
function satClick(r: ResolvedRef): (() => void) | undefined {
  if (r.kind === "event") return () => store.navigate({ tab: "events", eventId: String(r.value) });
  if (r.kind === "var") return () => store.navigate({ tab: "vars" });
  if (r.kind === "template")
    return () => {
      store.selectTemplate(String(r.value)); // open the tab WITH the template selected
      store.navigate({ tab: "templates" });
    };
  if (r.kind === "object") return () => toolStore.setSelectedId(String(r.value));
  return undefined;
}

/** «➜ следующее в цепочке»: auto-creates a disabled follow-up + the enableEvent wire. */
function chainNext(): void {
  if (store.selectedId) store.createChainedEvent(store.selectedId);
}

/** «⏱ после N раз…»: prompts for N and builds a counter gate — a HIDDEN auto-variable,
 *  «+1» on this event, and a new event firing once the counter reaches N. One undo step. */
function gateAfterN(): void {
  const fromId = store.selectedId;
  if (!fromId) return;
  void ElMessageBox.prompt("Через сколько срабатываний этого события создать продолжение?", "После N раз", {
    confirmButtonText: "Создать",
    cancelButtonText: "Отмена",
    inputValue: "3",
    inputPattern: /^[1-9]\d{0,2}$/,
    inputErrorMessage: "Число от 1 до 999",
  })
    .then(({ value }) => {
      store.createCounterGate(fromId, Number(value));
    })
    .catch(() => {
      /* отмена — ничего не делаем */
    });
}

/** «⊻ или-ветка»: альтернатива — сработает только одна из веток (общий скрытый гейт). */
function orBranch(): void {
  if (store.selectedId) store.createOrBranch(store.selectedId);
}

/** «⏲ через N дней…»: скрытый дневной тикер + продолжение при счётчике ≥ N. */
function timerAfter(): void {
  const fromId = store.selectedId;
  if (!fromId) return;
  void ElMessageBox.prompt("Через сколько дней после этого события создать продолжение?", "Через N дней", {
    confirmButtonText: "Создать",
    cancelButtonText: "Отмена",
    inputValue: "7",
    inputPattern: /^[1-9]\d{0,2}$/,
    inputErrorMessage: "Число от 1 до 999",
  })
    .then(({ value }) => {
      store.createTimerAfter(fromId, Number(value));
    })
    .catch(() => { /* отмена */ });
}

/** «⚑ фаза K»: событие срабатывает только в фазе K (общая скрытая AUTO_фаза). */
function bindPhase(): void {
  const id = store.selectedId;
  if (!id) return;
  void ElMessageBox.prompt("В какой фазе сценария должно работать это событие? (фаза — общий скрытый счётчик, старт = 0)", "Привязать к фазе", {
    confirmButtonText: "Привязать",
    cancelButtonText: "Отмена",
    inputValue: "1",
    inputPattern: /^\d{1,3}$/,
    inputErrorMessage: "Число 0..999",
  })
    .then(({ value }) => {
      store.bindEventToPhase(id, Number(value));
    })
    .catch(() => { /* отмена */ });
}

/** «⚑➜ в фазу K»: эффект-переход — событие присваивает фазе значение K. */
function gotoPhase(): void {
  const id = store.selectedId;
  if (!id) return;
  void ElMessageBox.prompt("В какую фазу переводит сценарий это событие?", "Переход в фазу", {
    confirmButtonText: "Добавить эффект",
    cancelButtonText: "Отмена",
    inputValue: "1",
    inputPattern: /^\d{1,3}$/,
    inputErrorMessage: "Число 0..999",
  })
    .then(({ value }) => {
      store.addGotoPhaseEffect(id, Number(value));
    })
    .catch(() => { /* отмена */ });
}

/** Slightly curved edge path (cubic, horizontal tangents). */
function edgePath(e: GEdge): string {
  const mx = (e.x1 + e.x2) / 2;
  return `M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`;
}

// ---- viewBox navigation: wheel zoom, drag pan, fit ---------------------------------------
const svgRef = ref<SVGSVGElement | null>(null);
const view = ref({ x: 0, y: 0, w: W, h: 300 });
const ZOOM_MIN = 0.35; // scale relative to the fitted view
const ZOOM_MAX = 4;
const FIT_PAD = 36;

/** Content bbox of the current graph (nodes' extents + padding) — the "fitted" view. */
const contentBox = computed<{ x: number; y: number; w: number; h: number }>(() => {
  const g = graph.value;
  if (!g || !g.nodes.length) return { x: 0, y: 0, w: W, h: 300 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of g.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  let x = minX - FIT_PAD;
  let y = minY - FIT_PAD;
  let w = maxX - minX + FIT_PAD * 2;
  let h = maxY - minY + FIT_PAD * 2;
  // a near-empty graph shouldn't blow a lone box up to a comical scale
  const MIN_W = 560;
  const MIN_H = 240;
  if (w < MIN_W) { x -= (MIN_W - w) / 2; w = MIN_W; }
  if (h < MIN_H) { y -= (MIN_H - h) / 2; h = MIN_H; }
  return { x, y, w, h };
});

/** Reset to the fitted content view (the ⤢ button, and every event (re)selection). */
function fitToContent(): void {
  view.value = { ...contentBox.value };
}
watch(() => store.selected?.id, fitToContent, { immediate: true });

/** Screen (client) point → viewBox coords, honoring `xMidYMid meet` letterboxing. */
function clientToView(cx: number, cy: number): { x: number; y: number } {
  const svg = svgRef.value;
  const v = view.value;
  if (!svg) return { x: v.x + v.w / 2, y: v.y + v.h / 2 };
  const rect = svg.getBoundingClientRect();
  const s = Math.min(rect.width / v.w, rect.height / v.h) || 1; // screen px per viewBox unit
  const ox = (rect.width - v.w * s) / 2;
  const oy = (rect.height - v.h * s) / 2;
  return { x: v.x + (cx - rect.left - ox) / s, y: v.y + (cy - rect.top - oy) / s };
}

/** Zoom about a fixed viewBox point; factor > 1 zooms IN. Clamped to 0.35×..4× of the fit. */
function zoomAt(px: number, py: number, factor: number): void {
  const v = view.value;
  const base = contentBox.value.w;
  const w = Math.min(Math.max(v.w / factor, base / ZOOM_MAX), base / ZOOM_MIN);
  const k = w / v.w;
  view.value = { x: px - (px - v.x) * k, y: py - (py - v.y) * k, w, h: v.h * k };
}

function onWheel(ev: WheelEvent): void {
  const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY; // lines → px (Firefox)
  const p = clientToView(ev.clientX, ev.clientY);
  zoomAt(p.x, p.y, Math.exp(-dy * 0.0018));
}

function zoomStep(dir: 1 | -1): void {
  const v = view.value;
  zoomAt(v.x + v.w / 2, v.y + v.h / 2, dir > 0 ? 1.35 : 1 / 1.35);
}

// Pan: capture the pointer only AFTER >4px of travel, so a plain tap on a node still
// delivers its click; once a drag happened, the flag swallows the trailing node click.
let pan: { id: number; sx: number; sy: number; lx: number; ly: number; dragging: boolean } | null = null;
const panning = ref(false);
let dragMoved = false;

function onPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0) return;
  pan = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, lx: ev.clientX, ly: ev.clientY, dragging: false };
  dragMoved = false;
}
function onPointerMove(ev: PointerEvent): void {
  if (!pan || ev.pointerId !== pan.id) return;
  if (!pan.dragging) {
    if (Math.hypot(ev.clientX - pan.sx, ev.clientY - pan.sy) <= 4) return;
    pan.dragging = true;
    dragMoved = true;
    panning.value = true;
    svgRef.value?.setPointerCapture(ev.pointerId);
  }
  const a = clientToView(pan.lx, pan.ly);
  const b = clientToView(ev.clientX, ev.clientY);
  view.value = { ...view.value, x: view.value.x - (b.x - a.x), y: view.value.y - (b.y - a.y) };
  pan.lx = ev.clientX;
  pan.ly = ev.clientY;
}
function onPointerUp(ev: PointerEvent): void {
  if (!pan || ev.pointerId !== pan.id) return;
  pan = null;
  panning.value = false;
}

function onNodeClick(n: GNode): void {
  if (dragMoved) {
    dragMoved = false;
    return;
  }
  n.click?.();
}
</script>

<template>
  <div class="ev-graph">
    <template v-if="graph">
      <svg
        ref="svgRef"
        :viewBox="`${view.x} ${view.y} ${view.w} ${view.h}`"
        preserveAspectRatio="xMidYMid meet"
        :class="{ panning }"
        @wheel.prevent="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <path
          v-for="(e, i) in graph.edges"
          :key="'e' + i"
          :d="edgePath(e)"
          :class="[e.cls, { hot: hotEdges.has(i), faded: hoverNode !== null && !hotEdges.has(i) }]"
          fill="none"
        />
        <g
          v-for="(n, i) in graph.nodes"
          :key="'n' + i"
          :class="[n.cls, { clickable: !!n.click, faded: hoverNode !== null && !hotNodes.has(i) }]"
          @click="onNodeClick(n)"
          @pointerenter="hoverNode = i"
          @pointerleave="hoverNode = null"
        >
          <title v-if="n.tip">{{ n.tip }}</title>
          <rect :x="n.x" :y="n.y" :width="n.w" :height="n.h" rx="7" />
          <text :x="n.x + 10" :y="n.y + (n.sub ? 15 : n.h / 2 + 4)" class="t-title">
            <tspan v-if="n.icon" class="t-icon">{{ n.icon }}</tspan>
            {{ n.title }}
          </text>
          <text v-if="n.sub" :x="n.x + 10" :y="n.y + n.h - 7" class="t-sub">{{ n.sub }}</text>
        </g>
      </svg>
      <div class="ev-nav d2-float">
        <button type="button" class="ev-nav-btn" title="Приблизить" @click="zoomStep(1)">+</button>
        <button type="button" class="ev-nav-btn" title="Отдалить" @click="zoomStep(-1)">−</button>
        <button type="button" class="ev-nav-btn" title="Вписать граф" @click="fitToContent()">⤢</button>
      </div>
      <!-- auto-wiring: hidden-variable constructions — one click each. The caption names
           the ANCHOR event so it is clear what the chips attach to. -->
      <div class="ev-actions">
        <span class="ev-actions-lbl">
          Пристроить к «{{ (store.selected?.name || store.selected?.id || "").slice(0, 24) }}»:
        </span>
        <el-tooltip content="Создать ПРОДОЛЖЕНИЕ: новое (выключенное) событие + эффект «Вкл/выкл событие» на него" :show-after="300">
          <button type="button" class="ev-chain d2-float" @click="chainNext()">➜ цепочка</button>
        </el-tooltip>
        <el-tooltip content="Счётчик: «+1» на этом событии, продолжение сработает ПОСЛЕ N срабатываний (переменная скрыта)" :show-after="300">
          <button type="button" class="ev-chain d2-float" @click="gateAfterN()">⏱ после N раз…</button>
        </el-tooltip>
        <el-tooltip content="ИЛИ-ветка: альтернативное событие — сработает только ОДНА из веток; повторный клик добавляет ещё ветку" :show-after="300">
          <button type="button" class="ev-chain d2-float" @click="orBranch()">⊻ или-ветка</button>
        </el-tooltip>
        <el-tooltip content="Таймер: продолжение сработает ЧЕРЕЗ N дней после этого события (скрытый дневной счётчик)" :show-after="300">
          <button type="button" class="ev-chain d2-float" @click="timerAfter()">⏲ через N дней…</button>
        </el-tooltip>
        <span class="ev-actions-div" />
        <el-tooltip content="Событие будет работать ТОЛЬКО в фазе K сценария (общая скрытая переменная фазы)" :show-after="300">
          <button type="button" class="ev-chain d2-float" @click="bindPhase()">⚑ только в фазе…</button>
        </el-tooltip>
        <el-tooltip content="Добавить эффект «перейти в фазу K» — это событие переключит сценарий в другую фазу" :show-after="300">
          <button type="button" class="ev-chain d2-float" @click="gotoPhase()">⚑➜ переключить фазу…</button>
        </el-tooltip>
      </div>
      <div class="ev-legend">
        <span><i class="lg lg-cond" />условия</span>
        <span><i class="lg lg-eff" />эффекты</span>
        <span><i class="lg lg-evt" />цепочки вкл/выкл</span>
      </div>
    </template>
    <el-empty v-else description="Выберите событие — здесь появится его карта связей" :image-size="70" />
  </div>
</template>

<style scoped>
.ev-graph {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden; /* the viewBox pans/zooms — no scrollbars */
  background:
    radial-gradient(circle at 1px 1px, var(--el-border-color-lighter) 1px, transparent 0) 0 0 / 22px 22px;
  border-radius: var(--d2-radius, 8px);
}
.ev-graph svg {
  display: block;
  width: 100%;
  height: 100%;
  font-family: inherit;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.ev-graph svg.panning {
  cursor: grabbing;
}
/* floating zoom cluster (elevation/glass come from the shared .d2-float) */
.ev-nav {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
}
.ev-nav-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--d2-radius);
  background: transparent;
  color: var(--el-text-color-regular);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s;
}
.ev-nav-btn:hover {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
}
/* construction builders (top-left cluster; wraps on narrow graphs) */
.ev-actions-lbl {
  flex: 0 0 100%;
  font-size: 10px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  text-shadow: 0 0 4px var(--el-bg-color);
}
.ev-actions-div {
  width: 1px;
  align-self: stretch;
  background: var(--el-border-color);
  margin: 0 2px;
}
.ev-actions {
  position: absolute;
  top: 10px;
  left: 10px;
  right: 52px; /* leave the zoom cluster free */
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
}
.ev-chain {
  padding: 5px 10px;
  border: none;
  font-size: 11px;
  color: var(--el-text-color-regular);
  cursor: pointer;
}
.ev-chain:hover {
  color: var(--el-color-primary);
}
/* color legend (bottom-left, non-interactive) */
.ev-legend {
  position: absolute;
  left: 10px;
  bottom: 8px;
  z-index: 5;
  display: flex;
  gap: 12px;
  font-size: 10px;
  color: var(--el-text-color-secondary);
  pointer-events: none;
}
.ev-legend span { display: inline-flex; align-items: center; gap: 4px; }
.lg { width: 14px; height: 0; border-top: 2px solid; display: inline-block; }
.lg-cond { border-color: var(--el-color-warning); }
.lg-eff { border-color: var(--el-color-success); }
.lg-evt { border-color: var(--el-color-primary); border-top-style: dashed; }
/* nodes */
rect {
  fill: var(--el-bg-color);
  stroke: var(--el-border-color);
  stroke-width: 1;
}
.g-center rect { fill: var(--el-color-primary-light-9); stroke: var(--el-color-primary); stroke-width: 1.4; }
.g-cond rect { stroke: var(--el-color-warning); }
.g-eff rect { stroke: var(--el-color-success); }
.g-evt rect { stroke: var(--el-color-primary); stroke-dasharray: 4 3; }
.clickable { cursor: pointer; }
.clickable:hover rect { fill: var(--el-fill-color-light); }
.t-title { font-size: 12px; font-weight: 600; fill: var(--el-text-color-primary); }
.t-icon { font-size: 11px; }
.t-sub { font-size: 10px; fill: var(--el-text-color-secondary); }
/* edges */
.e-cond { stroke: var(--el-color-warning); stroke-width: 1.4; opacity: 0.7; }
.e-eff { stroke: var(--el-color-success); stroke-width: 1.4; opacity: 0.7; }
.e-sat { stroke: var(--el-border-color); stroke-width: 1.1; opacity: 0.9; }
.e-chain { stroke: var(--el-color-primary); stroke-width: 1.3; stroke-dasharray: 5 4; opacity: 0.8; }
/* hover highlight: the hovered node's edges pop, everything else fades */
path, g { transition: opacity 0.14s ease; }
path.hot { stroke-width: 2.4; opacity: 1; }
path.faded { opacity: 0.12; }
g.faded { opacity: 0.3; }
</style>
