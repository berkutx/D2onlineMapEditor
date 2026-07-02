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

const collab = useCollabStore();
const { history, connected, peerList } = storeToRefs(collab);

const open = ref(true);
/** Newest first, capped so the list stays light. */
const rows = computed(() => history.value.slice(-200).reverse());
const show = computed(() => connected.value && (history.value.length > 0 || peerList.value.length > 0));

/** seqs whose detail is expanded (click a row to toggle). */
const expanded = ref<Set<number>>(new Set());
function toggle(seq: number): void {
  const s = new Set(expanded.value);
  s.has(seq) ? s.delete(seq) : s.add(seq);
  expanded.value = s;
}
</script>

<template>
  <div v-if="show" class="history d2-float" :class="{ collapsed: !open }">
    <div class="hist-head" @click="open = !open">
      <el-icon class="hist-ico"><Clock /></el-icon>
      <span class="hist-title">История</span>
      <span class="hist-count">{{ history.length }}</span>
      <el-button text size="small" class="hist-toggle" :icon="open ? ArrowDown : ArrowUp" />
    </div>
    <div v-show="open" class="hist-body">
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
  </div>
</template>

<style scoped>
.history {
  position: absolute;
  right: 12px;
  bottom: 40px;
  width: 248px;
  z-index: 30;
  font-size: 12px;
  overflow: hidden;
}
/* single top header row: spacing separates it, no border-bottom */
.hist-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 6px;
  cursor: pointer;
  user-select: none;
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
.hist-body { max-height: 240px; overflow-y: auto; }
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
