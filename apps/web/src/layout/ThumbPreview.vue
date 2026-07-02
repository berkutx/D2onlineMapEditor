<script setup lang="ts">
/**
 * ThumbPreview — ONE shared floating zoom of a decoration thumbnail. A parent keeps a
 * single <ThumbPreview ref> and calls show(cellEl, thumb, label) / hide() from its
 * cells' mouseenter/mouseleave. Renders a ~3x DecorThumb + the name on the fixed LIGHT
 * checkerboard (the sprites are dark — they must read on light in BOTH themes).
 *
 * position: fixed + teleported to <body> (a .d2-float ancestor's backdrop-filter would
 * otherwise become its containing block), pointer-events: none (never traps the
 * pointer), clamped to the viewport, hidden on any scroll (anchor rect goes stale).
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { DecorThumb as DecorThumbRect } from "../stores/decorStore";
import DecorThumb from "./DecorThumb.vue";

const PREVIEW_SIZE = 104; // ~3x of the 30–40px strip cells
const MARGIN = 8;

const visible = ref(false);
const placed = ref(false); // keep invisible until measured (avoids a 1-frame jump)
const thumb = ref<DecorThumbRect | null>(null);
const label = ref("");
const left = ref(0);
const top = ref(0);
const rootEl = ref<HTMLElement | null>(null);
let anchor: DOMRect | null = null;

function show(cell: HTMLElement, t: DecorThumbRect, text: string): void {
  anchor = cell.getBoundingClientRect();
  thumb.value = t;
  label.value = text;
  visible.value = true;
  placed.value = false;
  void nextTick(place);
}

function hide(): void {
  visible.value = false;
  anchor = null;
}

/** Measure the rendered card, then pin it under (or above) the cell, clamped on-screen. */
function place(): void {
  const el = rootEl.value;
  if (!el || !anchor) return;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let x = anchor.left + anchor.width / 2 - w / 2;
  x = Math.min(Math.max(x, MARGIN), Math.max(MARGIN, window.innerWidth - w - MARGIN));
  let y = anchor.bottom + MARGIN;
  if (y + h > window.innerHeight - MARGIN) y = anchor.top - h - MARGIN;
  y = Math.min(Math.max(y, MARGIN), Math.max(MARGIN, window.innerHeight - h - MARGIN));
  left.value = x;
  top.value = y;
  placed.value = true;
}

// capture:true also catches el-scrollbar's inner wrap (scroll events don't bubble)
onMounted(() => window.addEventListener("scroll", hide, { capture: true, passive: true }));
onBeforeUnmount(() => window.removeEventListener("scroll", hide, { capture: true }));

defineExpose({ show, hide });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible && thumb"
      ref="rootEl"
      class="thumb-preview d2-float"
      :style="{ left: `${left}px`, top: `${top}px`, visibility: placed ? 'visible' : 'hidden' }"
    >
      <div class="tp-thumb">
        <DecorThumb :thumb="thumb" :size="PREVIEW_SIZE" />
      </div>
      <div class="tp-name">{{ label }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.thumb-preview {
  position: fixed;
  z-index: 3000; /* above the strips/rails; a pure tooltip, never interactive */
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px;
  max-width: 220px;
}
/* fixed LIGHT checkerboard — theme-independent, dark sprites stay readable */
.tp-thumb {
  border-radius: var(--d2-radius);
  overflow: hidden;
  background: repeating-conic-gradient(#e9e5db 0% 25%, #f6f4ee 0% 50%) 0 / 12px 12px;
}
.tp-name {
  max-width: 200px;
  font-size: 11px;
  color: var(--el-text-color-regular);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
