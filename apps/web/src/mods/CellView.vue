<script setup lang="ts">
/** One cell of a row in words; a link to an entity opens its card. The raw value on hover. */
import { computed } from "vue";
import { useCompareStore } from "./compareStore";
import { cellLink, cellText, type Cell } from "./display";

const props = defineProps<{ table: string; column: string; value: Cell; side: "a" | "b"; text?: string | null }>();
const store = useCompareStore();
const link = computed(() => cellLink(props.table, props.column, props.value));
const words = computed(() => props.text || cellText(props.table, props.column, props.value, store.extras(props.side)));
const raw = computed(() => (props.value === null || props.value === undefined ? "" : String(props.value)));
</script>

<template>
  <a v-if="link && store.canOpen(link.section, link.id)" href="#" class="cell-link" :title="raw" @click.prevent="store.openEntity(link.section, link.id)">{{ words }}</a>
  <span v-else class="cell" :title="raw !== words ? raw : undefined">{{ words }}</span>
</template>

<style scoped>
.cell-link {
  color: var(--el-color-primary);
  text-decoration: none;
}
.cell-link:hover {
  text-decoration: underline;
}
.cell {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
