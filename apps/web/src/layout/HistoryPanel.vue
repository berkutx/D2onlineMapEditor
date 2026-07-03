<script setup lang="ts">
/**
 * Shared change history (collab). A floating, collapsible card listing the room's EditOp
 * log newest-first — each entry tagged with its author's colour + name. Read-only timeline
 * (revert-from-here is a planned follow-up); local undo/redo stays on the toolbar/Ctrl+Z.
 * Shown only while connected to a room with at least one recorded change.
 */
import { ref, computed } from "vue";
import { storeToRefs } from "pinia";
import { ElButton } from "element-plus";
import { Clock, ArrowDown, ArrowUp } from "@element-plus/icons-vue";
import { useCollabStore } from "../stores/collabStore";
import { useFloatingDock } from "../composables/useFloatingDock";

const collab = useCollabStore();
const { history, connected, peerList } = storeToRefs(collab);

const card = ref<HTMLElement | null>(null);
const { style, onHandlePointerDown } = useFloatingDock("history", card);

const open = ref(true);
/** Newest first, capped so the list stays light. */
const rows = computed(() => history.value.slice(-200).reverse());
const show = computed(() => connected.value && (history.value.length > 0 || peerList.value.length > 0));

// --- resizable body: drag the bottom edge to make the log taller/shorter (persisted) -------
const HIST_H_KEY = "d2.hist.h.v1";
function loadHeight(): number {
  try { const v = Number(localStorage.getItem(HIST_H_KEY)); return v >= 120 ? v : 240; } catch { return 240; }
}
const bodyHeight = ref(loadHeight());
let resizing = false;
let startY = 0;
let startH = 0;
function onResizeMove(e: PointerEvent): void {
  if (!resizing) return;
  const max = Math.max(200, Math.round(window.innerHeight * 0.7));
  bodyHeight.value = Math.max(120, Math.min(startH + (e.clientY - startY), max));
  e.preventDefault();
}
function endResize(): void {
  window.removeEventListener("pointermove", onResizeMove);
  window.removeEventListener("pointerup", endResize);
  if (!resizing) return;
  resizing = false;
  try { localStorage.setItem(HIST_H_KEY, String(Math.round(bodyHeight.value))); } catch { /* ignore */ }
}
function startResize(e: PointerEvent): void {
  if (e.button !== 0) return;
  resizing = true;
  startY = e.clientY;
  startH = bodyHeight.value;
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", endResize);
  e.preventDefault();
}

/** seqs whose detail is expanded (click a row to toggle). */
const expanded = ref<Set<number>>(new Set());
function toggle(seq: number): void {
  const s = new Set(expanded.value);
  s.has(seq) ? s.delete(seq) : s.add(seq);
  expanded.value = s;
}
</script>

<template>
  <div v-if="show" ref="card" class="history d2-float" :class="{ collapsed: !open }" :style="style">
    <div class="hist-head" title="Перетащите за заголовок" @pointerdown="onHandlePointerDown" @click="open = !open">
      <span class="hist-grip">⠿</span>
      <el-icon class="hist-ico"><Clock /></el-icon>
      <span class="hist-title">История</span>
      <span class="hist-count">{{ history.length }}</span>
      <el-button text size="small" class="hist-toggle" :icon="open ? ArrowDown : ArrowUp" />
    </div>
    <div v-show="open" class="hist-body" :style="{ height: bodyHeight + 'px' }">
      <div v-if="!rows.length" class="hist-empty">Пока нет правок в этой сессии.</div>
      <ul v-else class="hist-list">
        <li v-for="e in rows" :key="e.seq" class="hist-item">
          <div class="hist-row d2-row" :class="{ active: expanded.has(e.seq) }" @click="toggle(e.seq)">
            <span class="dot" :style="{ background: e.byColor }" />
            <span class="seq">#{{ e.seq }}</span>
            <span class="who" :class="{ mine: e.mine }">{{ e.mine ? 'вы' : e.byName }}</span>
            <span class="what">{{ e.summary }}</span>
          </div>
          <pre v-if="expanded.has(e.seq)" class="hist-detail">{{ e.detail }}</pre>
        </li>
      </ul>
    </div>
    <div
      v-show="open"
      class="hist-resize"
      title="Потяните, чтобы изменить высоту"
      @pointerdown="startResize"
    ><span class="hist-resize-grip">⣒</span></div>
  </div>
</template>

<style scoped>
/* Default corner = TOP-right of .app-main (Copilot owns bottom-centre, minimap bottom-right,
   so the top-right corner is free — no more three-way pile-up). Once dragged, useFloatingDock
   supplies inline left/top and this right/top is overridden. */
.history {
  position: absolute;
  right: 12px;
  top: 12px;
  width: 248px;
  z-index: 27;
  font-size: 12px;
  overflow: hidden;
}
/* single top header row: spacing separates it, no border-bottom */
.hist-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 6px;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.hist-head:active {
  cursor: grabbing;
}
.hist-grip {
  color: var(--el-text-color-secondary);
  opacity: 0.5;
  font-size: 12px;
  line-height: 1;
}
.hist-ico { font-size: 14px; color: var(--el-text-color-secondary); }
.hist-title { font-size: 13px; font-weight: 600; }
.hist-count {
  margin-left: 2px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}
.hist-toggle {
  margin-left: auto;
  opacity: 0.6;
  transition: opacity 0.12s ease;
}
.hist-head:hover .hist-toggle { opacity: 1; }
/* height is bound inline (resizable via the bottom grip) — scroll the overflow */
.hist-body { overflow-y: auto; }
/* bottom resize grip: a thin bar the user drags to grow/shrink the log height */
.hist-resize {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 12px;
  cursor: ns-resize;
  color: var(--el-text-color-secondary);
  opacity: 0.5;
  user-select: none;
  touch-action: none;
}
.hist-resize:hover { opacity: 1; }
.hist-resize-grip { font-size: 11px; line-height: 1; letter-spacing: 2px; }
.hist-empty { padding: 6px 12px 10px; color: var(--el-text-color-secondary); }
.hist-list { list-style: none; margin: 0; padding: 2px 6px 6px; }
/* rows are .d2-row (hover wash + inset accent when .active) — no per-row borders */
.hist-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  white-space: nowrap;
  cursor: pointer;
}
.hist-detail {
  margin: 2px 0 4px;
  padding: 6px 10px 8px 27px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--el-text-color-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  background: var(--el-fill-color-lighter);
  border-radius: var(--d2-radius);
}
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 0 1px rgba(0,0,0,.25); }
.seq { color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
.who { font-weight: 600; }
.who.mine { color: var(--el-color-primary); }
.what { color: var(--el-text-color-regular); overflow: hidden; text-overflow: ellipsis; }
</style>
