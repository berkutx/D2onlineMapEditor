<script setup lang="ts">
/**
 * SpellIcon — a small spell icon. Renders the extracted icon (/assets/spellicons/<id>.png,
 * keyed by the Gspell id) and falls back to a level badge coloured by school when the
 * spell ships no icon asset.
 */
import { ref, computed, watch } from "vue";
import { assetUrl } from "../services/api";

const props = withDefaults(
  defineProps<{ id?: string | null; level?: number; cat?: number; size?: number }>(),
  { id: null, level: 0, cat: -1, size: 28 },
);

const failed = ref(false);
watch(() => props.id, () => { failed.value = false; });

const src = computed(() => (props.id ? assetUrl(`spellicons/${props.id.toLowerCase()}.png`) : ""));
const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
</script>

<template>
  <span class="spell-icon" :style="box">
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
    <span v-else class="icon-badge" :data-cat="cat">{{ level || "?" }}</span>
  </span>
</template>

<style scoped>
.spell-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  overflow: hidden;
}
.icon-img {
  object-fit: contain;
  image-rendering: pixelated;
}
.icon-badge {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: var(--el-color-info);
}
.icon-badge[data-cat="0"] { background: #d1495b; } /* L_ATTACK */
.icon-badge[data-cat="1"] { background: #4895ef; } /* L_BOOST */
.icon-badge[data-cat="2"] { background: #6a4c93; } /* L_LOWER */
.icon-badge[data-cat="3"] { background: #43aa8b; } /* L_HEAL */
.icon-badge[data-cat="4"] { background: #9d4edd; } /* L_SUMMON */
.icon-badge[data-cat="5"] { background: #577590; } /* L_FOG */
.icon-badge[data-cat="6"] { background: #90a955; } /* L_CHANGE_TERRAIN */
.icon-badge[data-cat="7"] { background: #f9c74f; color: #333; } /* L_RESTORE_MOVE */
.icon-badge[data-cat="8"] { background: #4cc9f0; color: #333; } /* L_UNFOG */
.icon-badge[data-cat="9"] { background: #adb5bd; color: #333; } /* L_INVISIBILITY */
.icon-badge[data-cat="10"] { background: #b5838d; } /* L_REMOVE_ROD */
</style>
