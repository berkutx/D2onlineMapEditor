<script setup lang="ts">
/** Counts by status as small coloured chips: +added ~changed −removed, art-only, via-shared. */
import { tr } from "../i18n";

withDefaults(defineProps<{ added?: number; changed?: number; removed?: number; artOnly?: number; viaShared?: number; zeros?: boolean }>(), {
  added: 0,
  changed: 0,
  removed: 0,
  artOnly: 0,
  viaShared: 0,
  zeros: false,
});
</script>

<template>
  <span class="count-chips">
    <span v-if="added || zeros" class="chip st-added" :title="tr('Добавлено')">+{{ added }}</span>
    <span v-if="changed || zeros" class="chip st-changed" :title="tr('Изменено')">~{{ changed }}</span>
    <span v-if="removed || zeros" class="chip st-removed" :title="tr('Удалено')">−{{ removed }}</span>
    <span v-if="artOnly" class="chip st-art" :title="tr('Только графика')">◩ {{ artOnly }}</span>
    <span v-if="viaShared" class="chip st-shared" :title="tr('Через общее')">↪ {{ viaShared }}</span>
  </span>
</template>

<style scoped>
.count-chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chip {
  font-size: 12px;
  line-height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
