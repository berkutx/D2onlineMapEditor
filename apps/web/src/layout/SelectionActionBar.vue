<script setup lang="ts">
/**
 * SelectionActionBar — floats while the select tool holds a MULTI-selection (⇧+клик /
 * ⇧+рамка): group to anchors, ungroup, delete, clear. Single-object selection keeps the
 * quiet inspector-only behavior (no bar).
 */
import { Delete, Close, Link } from "@element-plus/icons-vue";
import { useToolStore } from "../stores/toolStore";
import { useSelectionActions } from "../composables/selectionActions";

const toolStore = useToolStore();
const { count, groupSelected, ungroupSelected, deleteSelected, clearSelection } = useSelectionActions();
</script>

<template>
  <div v-if="count > 1" class="sel-actions d2-float">
    <div class="sa-info">
      <div class="sa-name">Выбрано: {{ count }}</div>
      <div class="sa-hint">⇧+клик — добавить/убрать · ⇧+рамка — область · 2×клик — перенести группу</div>
    </div>
    <el-button size="small" :icon="Link" title="Заякорить все к ПОСЛЕДНЕМУ выбранному (⚓ группа переноса)" @click="groupSelected()">
      Сгруппировать
    </el-button>
    <el-button size="small" title="Снять якоря с выделенных" @click="ungroupSelected()">Разгруппировать</el-button>
    <el-button size="small" type="danger" plain :icon="Delete" title="Удалить выделенные объекты (один undo)" @click="deleteSelected()">
      Удалить
    </el-button>
    <el-button size="small" :icon="Close" circle title="Снять выделение (Esc)" @click="clearSelection()" />
  </div>
</template>

<style scoped>
.sel-actions {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 25;
  max-width: min(720px, 94%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
}
.sa-info {
  min-width: 0;
}
.sa-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
}
.sa-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
</style>
