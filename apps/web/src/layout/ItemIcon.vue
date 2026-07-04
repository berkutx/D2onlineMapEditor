<script setup lang="ts">
/**
 * ItemIcon — a small item thumbnail. Renders the extracted inventory icon
 * (/assets/itemicons/<id>.png, keyed by ITEM_ID) and falls back to a category-coloured
 * dot when the item has no icon asset (generic potions/orbs share UI icons the game does
 * not ship as per-item PNGs).
 */
import { ref, computed, watch } from "vue";
import { assetUrl } from "../services/api";

const props = withDefaults(defineProps<{ id?: string | null; cat?: number; size?: number }>(), {
  id: null,
  cat: -1,
  size: 22,
});

const failed = ref(false);
watch(() => props.id, () => { failed.value = false; });

const src = computed(() => (props.id ? assetUrl(`itemicons/${props.id.toLowerCase()}.png`) : ""));
const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
</script>

<template>
  <span class="item-icon" :style="box">
    <img
      v-if="src && !failed"
      :key="src"
      class="icon-img"
      :src="src"
      :width="size"
      :height="size"
      loading="lazy"
      decoding="async"
      alt=""
      @error="failed = true"
    />
    <span v-else class="icon-dot" :data-cat="cat" />
  </span>
</template>

<style scoped>
.item-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon-img {
  object-fit: contain;
  image-rendering: pixelated;
}
.icon-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--el-color-info);
}
.icon-dot[data-cat="0"] { background: #8d99ae; }
.icon-dot[data-cat="1"] { background: #c08457; }
.icon-dot[data-cat="2"] { background: #d1495b; }
.icon-dot[data-cat="3"] { background: #6a994e; }
.icon-dot[data-cat="4"] { background: #4895ef; }
.icon-dot[data-cat="5"] { background: #43aa8b; }
.icon-dot[data-cat="6"] { background: #90be6d; }
.icon-dot[data-cat="7"] { background: #577590; }
.icon-dot[data-cat="8"] { background: #b5838d; }
.icon-dot[data-cat="9"] { background: #9d4edd; }
.icon-dot[data-cat="10"] { background: #f9c74f; }
.icon-dot[data-cat="11"] { background: #4cc9f0; }
.icon-dot[data-cat="12"] { background: #f3722c; }
.icon-dot[data-cat="13"] { background: #adb5bd; }
.icon-dot[data-cat="14"] { background: #b08968; }
</style>
