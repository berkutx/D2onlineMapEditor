<script setup lang="ts">
/**
 * PickerSortHeader — the sticky subcategory header shared by every catalog picker. Shows the
 * group label + count on the left and a compact sort control on the right: one small button per
 * SortKey, the active one carrying a ▲/▼ arrow. Clicking a key sorts the items WITHIN every group
 * (global sort state in the parent); clicking the active key flips direction. Trackpad-friendly
 * (real buttons, ~24px hit height, no hover-only affordance).
 */
defineProps<{
  label: string;
  count: number;
  sortKeys: { key: string; label: string }[];
  sortKey: string;
  sortDir: 1 | -1;
}>();
const emit = defineEmits<{ sort: [key: string] }>();
</script>

<template>
  <div class="pg-head">
    <span class="pg-label">{{ label }} <span class="pg-count">{{ count }}</span></span>
    <span class="pg-sort" role="group" aria-label="Сортировка">
      <button
        v-for="s in sortKeys"
        :key="s.key"
        type="button"
        class="pg-btn"
        :class="{ active: s.key === sortKey }"
        :title="`Сортировать по: ${s.label}`"
        @click="emit('sort', s.key)"
      >
        {{ s.label }}<span v-if="s.key === sortKey" class="pg-arr">{{ sortDir === 1 ? "▲" : "▼" }}</span>
      </button>
    </span>
  </div>
</template>

<style scoped>
.pg-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--el-bg-color);
  padding: 8px 6px 4px;
}
.pg-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pg-count {
  color: var(--el-text-color-placeholder);
  font-weight: 400;
}
.pg-sort {
  flex: 0 0 auto;
  display: inline-flex;
  gap: 2px;
}
.pg-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
  line-height: 1;
  padding: 4px 5px;
  min-height: 22px;
  border-radius: var(--d2-radius-sm, 5px);
  color: var(--el-text-color-placeholder);
}
.pg-btn:hover {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
}
.pg-btn.active {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  font-weight: 600;
}
.pg-arr {
  margin-left: 2px;
  font-size: 8px;
  vertical-align: 1px;
}
</style>
