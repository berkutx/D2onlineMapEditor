<script setup lang="ts">
/**
 * EventGraph — the star topology of ONE scenario event, the visual heart of the scenario
 * window. Center = the event; left = its conditions (with entity satellites further left,
 * plus OTHER events that enable/disable this one, dashed); right = its effects (with entity
 * satellites further right — objects, players, vars, spells, items, templates BY NAME, and
 * enable-chain targets). Clicking an event satellite recenters the graph on it; clicking a
 * var satellite jumps to the Переменные tab; clicking an object satellite selects it on the
 * map (the overlay + inspector follow).
 */
import { computed } from "vue";
import { ElEmpty } from "element-plus";
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
interface GEdge { x1: number; y1: number; x2: number; y2: number; cls: string }

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

  // conditions column
  const condYs = stackYs(conds.length, cy);
  conds.forEach((c, i) => {
    const y = condYs[i]!;
    nodes.push({
      x: COL.cond, y, w: BW.cond, h: NODE_H,
      title: truncate(c.spec?.label ?? "условие", 26),
      sub: c.refs.length ? truncate(c.refs.map((r) => r.text).join(", "), 30) : undefined,
      icon: "⚡", cls: "g-cond",
    });
    edges.push({ x1: COL.cond + BW.cond, y1: y + NODE_H / 2, x2: center.x, y2: cy, cls: "e-cond" });
  });

  // effects column
  const effYs = stackYs(effs.length, cy);
  effs.forEach((e, i) => {
    const y = effYs[i]!;
    nodes.push({
      x: COL.eff, y, w: BW.eff, h: NODE_H,
      title: truncate(`${i + 1}. ${e.spec?.label ?? "эффект"}`, 27),
      sub: e.refs.length ? truncate(e.refs.map((r) => r.text).join(", "), 30) : undefined,
      icon: "★", cls: "g-eff",
    });
    edges.push({ x1: center.x + center.w, y1: cy, x2: COL.eff, y2: y + NODE_H / 2, cls: "e-eff" });
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
        cls: "g-evt", click: () => store.select(ev), tip: ev,
      });
      edges.push({ x1: COL.satL + BW.sat, y1: y + NODE_H / 2, x2: center.x, y2: cy - 8, cls: "e-chain" });
    } else if (s.ref) {
      const r = s.ref;
      nodes.push({
        x: COL.satL, y, w: BW.sat, h: NODE_H,
        title: truncate(r.text, 24), sub: r.fieldLabel, icon: names.icon(r),
        cls: "g-sat", click: satClick(r), tip: String(r.value),
      });
      const oy = condYs[s.owner as number]! + NODE_H / 2;
      edges.push({ x1: COL.satL + BW.sat, y1: y + NODE_H / 2, x2: COL.cond, y2: oy, cls: "e-sat" });
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
    edges.push({ x1: COL.eff + BW.eff, y1: oy, x2: COL.satR, y2: y + NODE_H / 2, cls: isEvt ? "e-chain" : "e-sat" });
  });

  return { nodes, edges, h };
});

/** Satellite click: events recenter, vars jump to their tab, map objects get selected. */
function satClick(r: ResolvedRef): (() => void) | undefined {
  if (r.kind === "event") return () => store.select(String(r.value));
  if (r.kind === "var") return () => { store.panelTab = "vars"; };
  if (r.kind === "template") return () => { store.panelTab = "templates"; };
  if (r.kind === "object") return () => toolStore.setSelectedId(String(r.value));
  return undefined;
}

/** Slightly curved edge path (cubic, horizontal tangents). */
function edgePath(e: GEdge): string {
  const mx = (e.x1 + e.x2) / 2;
  return `M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`;
}
</script>

<template>
  <div class="ev-graph">
    <svg v-if="graph" :viewBox="`0 0 ${W} ${graph.h}`" preserveAspectRatio="xMidYMid meet">
      <path v-for="(e, i) in graph.edges" :key="'e' + i" :d="edgePath(e)" :class="e.cls" fill="none" />
      <g
        v-for="(n, i) in graph.nodes"
        :key="'n' + i"
        :class="[n.cls, { clickable: !!n.click }]"
        @click="n.click?.()"
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
    <el-empty v-else description="Выберите событие — здесь появится его карта связей" :image-size="70" />
  </div>
</template>

<style scoped>
.ev-graph {
  height: 100%;
  min-height: 0;
  overflow: auto;
  background:
    radial-gradient(circle at 1px 1px, var(--el-border-color-lighter) 1px, transparent 0) 0 0 / 22px 22px;
  border-radius: var(--d2-radius, 8px);
}
.ev-graph svg {
  display: block;
  width: 100%;
  min-height: 100%;
  font-family: inherit;
}
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
</style>
