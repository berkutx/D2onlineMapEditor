<script setup lang="ts">
/** A linked entity: opens its card when the diff has it, plain text when it did not change. */
import { computed } from "vue";
import { tr } from "../i18n";
import { useCompareStore } from "./compareStore";

const props = defineProps<{ section: string | null; id: string; name?: string | null; showId?: boolean }>();
const store = useCompareStore();
const openable = computed(() => store.canOpen(props.section, props.id));
const text = computed(() => props.name || props.id);
</script>

<template>
  <a v-if="openable" class="entity-link" href="#" @click.prevent="store.openEntity(section!, id)">{{ text }}</a>
  <span v-else class="entity-plain" :title="tr('Не изменилось')">{{ text }}</span>
  <span v-if="showId && name" class="mono dim id-after">{{ id }}</span>
</template>

<style scoped>
.entity-link {
  color: var(--el-color-primary);
  text-decoration: none;
  cursor: pointer;
}
.entity-link:hover {
  text-decoration: underline;
}
.id-after {
  margin-left: 6px;
  font-size: 11px;
}
</style>
