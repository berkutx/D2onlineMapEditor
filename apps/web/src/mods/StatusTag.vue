<script setup lang="ts">
/** A status in its colour: added green, changed amber, removed red, art-only blue, via-shared grey. */
import { computed } from "vue";
import type { EntityStatus } from "@d2/mod-diff";
import { STATUS_HINT, STATUS_LABEL } from "./labels";

const props = withDefaults(defineProps<{ status: EntityStatus | null | undefined; size?: "small" | "default" }>(), { size: "small" });
const type = computed(() => {
  switch (props.status) {
    case "added":
      return "success";
    case "changed":
      return "warning";
    case "removed":
      return "danger";
    case "art-only":
      return "primary";
    default:
      return "info";
  }
});
</script>

<template>
  <el-tag v-if="status" :type="type" :size="size" disable-transitions class="status-tag" :title="STATUS_HINT[status]">{{ STATUS_LABEL[status] }}</el-tag>
</template>

<style scoped>
.status-tag {
  white-space: nowrap;
}
</style>
