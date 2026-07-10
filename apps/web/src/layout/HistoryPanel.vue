<script setup lang="ts">
/**
 * Shared change history (collab). A floating, collapsible card listing the room's EditOp
 * log newest-first — each entry tagged with its author's colour + name. A row expands to
 * its detail + revert actions: «только это» (one entry, server-checked cherry-pick) and
 * «отсюда» (my entries from here on, conflict-aware server revert). Reverts are regular
 * forward commits — append-only and broadcast to peers; to cancel one, revert ITS new
 * history row (server-computed reverts do not enter the local Ctrl+Z stack). Local
 * undo/redo stays on the toolbar; shown only while connected to a room.
 */
import { ref, computed } from "vue";
import { storeToRefs } from "pinia";
import { ElButton, ElMessage, ElMessageBox } from "element-plus";
import { Clock, ArrowDown, ArrowUp } from "@element-plus/icons-vue";
import { useCollabStore, type HistoryEntry } from "../stores/collabStore";
import { useFloatingDock } from "../composables/useFloatingDock";
import { exportAt } from "../services/api";

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

/** rids whose detail is expanded (click a row to toggle). Row identity is `rid`, NEVER seq:
 *  my optimistic rows carry a provisional seq that can tie until the ack. */
const expanded = ref<Set<number>>(new Set());
function toggle(rid: number): void {
  const s = new Set(expanded.value);
  s.has(rid) ? s.delete(rid) : s.add(rid);
  expanded.value = s;
}

// --- revert actions (per expanded row) ------------------------------------------------------
/** Revertable = has a locally captured inverse, OR is server-confirmed while in a room (the
 *  server computes the cherry-pick itself — rows re-folded after a reload have no local
 *  inverse but ARE revertable that way). */
const revertable = (e: HistoryEntry): boolean =>
  (e.inverse?.length ?? 0) > 0 || (connected.value && e.acked);

/** «Только это» is allowed ONLY when nothing newer touches the same cells/objects —
 *  вырывать середину цепочки нельзя (поздние правки перезатёрлись бы молча). dependentsOf is
 *  memoised in the store, so calling it per row on re-render is cheap. Structural safety
 *  (occupancy / dangling refs) is a heavier check run once on click — and in a room the
 *  authoritative dependents+structure check runs SERVER-side on click anyway. */
const dependents = (e: HistoryEntry) => collab.dependentsOf(e.rid);
const formatDeps = (deps: { seq: number; byName: string; mine: boolean }[], max: number): string => {
  const list = deps.slice(0, max).map((d) => `#${d.seq} (${d.mine ? "вы" : d.byName})`).join(", ");
  return `${list}${deps.length > max ? ` и ещё ${deps.length - max}` : ""}`;
};
const revertOneTitle = (e: HistoryEntry): string => {
  if (!revertable(e)) return "Нет обратной правки (часть мазка — откатывайте с последней записи мазка)";
  const deps = dependents(e);
  if (!deps.length) return "Откатить только эту запись (проверю структуру при клике)";
  return `Нельзя вырвать из середины: тот же объект/клетки правились позже — ${formatDeps(deps, 3)}. Используйте «откатить моё отсюда».`;
};

async function revertOne(e: HistoryEntry): Promise<void> {
  const r = await collab.revertOne(e.rid);
  if (r.ok) {
    ElMessage.success(`Откачено: ${e.summary}`);
    return;
  }
  if (r.blocked === "dependents" && r.dependents?.length) {
    ElMessage.warning(`Нельзя откатить только эту запись — есть зависимые позже: ${formatDeps(r.dependents, 4)}`);
  } else if (r.blocked === "structure" && r.issues?.length) {
    ElMessage.warning(`Нельзя откатить — сломает карту: ${r.issues.slice(0, 3).join("; ")}${r.issues.length > 3 ? "…" : ""}`);
  } else if (r.blocked === "pending") {
    ElMessage.warning("Запись ещё синхронизируется (⟳) — дождитесь подтверждения сервера и повторите");
  } else if (r.blocked === "offline") {
    ElMessage.warning("Нет связи с комнатой — откат этой записи выполняет сервер. Проверьте историю после переподключения");
  } else {
    ElMessage.warning(r.reason || "Не удалось откатить — запись конфликтует с более поздними правками");
  }
}
function revertFrom(e: HistoryEntry): void {
  if (connected.value && e.rejected) {
    ElMessage.warning("Эта правка отклонена сервером и существует только локально — откатите её через «только это»");
    return;
  }
  if (connected.value && !e.acked) {
    ElMessage.warning("Запись ещё не подтверждена сервером — дождитесь синхронизации (⟳)");
    return;
  }
  void ElMessageBox.confirm(
    `Откатить ВАШИ правки с #${e.seq} и новее? Чужие правки останутся; откат остановится на первой клетке/объекте, которые изменил другой участник. Откат — обычная запись в истории: чтобы вернуть, откатите её саму.`,
    "Откатить моё отсюда",
    { confirmButtonText: "Откатить", cancelButtonText: "Отмена", type: "warning" },
  )
    .then(async () => {
      const r = await collab.revertRangeServer(e.seq);
      if (!r.ok) {
        ElMessage.warning(r.offline
          ? "Нет связи с комнатой — конфликт-осознанный откат выполняет сервер. Попробуйте после переподключения"
          : "Не удалось откатить");
        return;
      }
      const boundary = r.conflictAt
        ? ` Дальше конфликт — изменил другой участник (${r.conflictAt.keys.slice(0, 4).join(", ")}${r.conflictAt.keys.length > 4 ? "…" : ""}).`
        : "";
      const rejectedNote = r.rejectedLeft
        ? " Отклонённые сервером (локальные) правки не тронуты — откатите их через «только это»."
        : "";
      if (r.revertedCount === 0) {
        ElMessage.warning(`Нечего откатывать${r.conflictAt ? " — сразу конфликт." + boundary : "."}${rejectedNote}`);
      } else {
        ElMessage.success(`Откачено ваших правок: ${r.revertedCount}.${boundary}${rejectedNote}`);
      }
    })
    .catch(() => { /* отмена */ });
}

/** «Выкачать промежуток»: download the .sg of the map AS IT WAS at this history point. */
async function download(e: HistoryEntry): Promise<void> {
  const id = collab.mapId;
  if (!id) return;
  try {
    const r = await exportAt(id, collab.channel, e.seq);
    if (!r.ok || !r.blob) {
      ElMessage.warning(`Не удалось выкачать точку #${e.seq}${r.report && !r.report.ok ? " — карта на этой точке невалидна" : ""}`);
      return;
    }
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = r.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    ElMessage.success(`Выкачано состояние на точке #${e.seq}`);
  } catch (err) {
    ElMessage.warning("Не удалось выкачать: " + (err as Error).message);
  }
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
        <li v-for="e in rows" :key="e.rid" class="hist-item">
          <div class="hist-row d2-row" :class="{ active: expanded.has(e.rid) }" @click="toggle(e.rid)">
            <span class="dot" :style="{ background: e.byColor }" />
            <span class="seq" :title="e.acked ? '' : e.rejected ? 'Отклонена сервером — только локально' : 'Синхронизируется…'">#{{ e.seq }}{{ e.acked ? '' : e.rejected ? '✗' : '⟳' }}</span>
            <span class="who" :class="{ mine: e.mine }">{{ e.mine ? 'вы' : e.byName }}</span>
            <span class="what">{{ e.summary }}</span>
          </div>
          <template v-if="expanded.has(e.rid)">
            <pre class="hist-detail">{{ e.detail }}</pre>
            <div class="hist-actions">
              <button
                type="button"
                class="hist-act"
                :disabled="!revertable(e) || dependents(e).length > 0"
                :title="revertOneTitle(e)"
                @click.stop="revertOne(e)"
              >⎌ только это</button>
              <button
                type="button"
                class="hist-act"
                title="Откатить ВАШИ правки с этой записи и новее; чужие сохранятся, откат остановится на конфликте"
                @click.stop="revertFrom(e)"
              >⎌ откатить моё отсюда</button>
              <button
                type="button"
                class="hist-act"
                title="Скачать .sg карты в состоянии на этой записи («выкачать промежуток»)"
                @click.stop="download(e)"
              >⭳ выкачать</button>
            </div>
          </template>
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
/* revert buttons under the expanded detail */
.hist-actions {
  display: flex;
  gap: 6px;
  padding: 0 10px 6px 27px;
}
.hist-act {
  border: 1px solid var(--el-border-color);
  background: transparent;
  border-radius: var(--d2-radius);
  padding: 2px 8px;
  font-size: 11px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
}
.hist-act:hover:not(:disabled) {
  color: var(--el-color-danger);
  border-color: var(--el-color-danger);
}
.hist-act:disabled {
  opacity: 0.4;
  cursor: default;
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
