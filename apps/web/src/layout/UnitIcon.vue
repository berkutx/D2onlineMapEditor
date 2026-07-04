<script setup lang="ts">
/**
 * UnitIcon — a small unit portrait. Renders the extracted face icon
 * (/assets/uniticons/<id>.png, keyed by the Gunit id) and falls back to a level badge
 * coloured by subrace when the unit ships no face asset (~half the roster has none).
 */
import { ref, computed, watch } from "vue";
import { assetUrl } from "../services/api";

const props = withDefaults(
  defineProps<{ id?: string | null; level?: number; subraceId?: number; size?: number }>(),
  { id: null, level: 0, subraceId: -1, size: 28 },
);

const failed = ref(false);
watch(() => props.id, () => { failed.value = false; });

const src = computed(() => (props.id ? assetUrl(`uniticons/${props.id.toLowerCase()}.png`) : ""));
const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
</script>

<template>
  <span class="unit-icon" :style="box">
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
    <span v-else class="icon-badge" :data-sub="subraceId">{{ level || "?" }}</span>
  </span>
</template>

<style scoped>
.unit-icon {
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
.icon-badge[data-sub="1"] { background: #c9a227; } /* Империя */
.icon-badge[data-sub="2"] { background: #6a4c93; } /* Нежить */
.icon-badge[data-sub="3"] { background: #b5403a; } /* Проклятые */
.icon-badge[data-sub="4"] { background: #8d6e3a; } /* Кланы Гор */
.icon-badge[data-sub="5"] { background: #6c757d; } /* Нейтрал */
.icon-badge[data-sub="6"] { background: #5a8f5a; } /* Люди */
.icon-badge[data-sub="7"] { background: #3f8f6f; } /* Нейтр. эльфы */
.icon-badge[data-sub="8"] { background: #7a8c3a; } /* Зеленокожие */
.icon-badge[data-sub="9"] { background: #b5651d; } /* Драконы */
.icon-badge[data-sub="10"] { background: #4a7c59; } /* Болото */
.icon-badge[data-sub="11"] { background: #3a7ca5; } /* Море */
.icon-badge[data-sub="12"] { background: #9c5b3b; } /* Варвары */
.icon-badge[data-sub="13"] { background: #8a6d5b; } /* Звери */
.icon-badge[data-sub="14"] { background: #4895ef; } /* Эльфы */
</style>
