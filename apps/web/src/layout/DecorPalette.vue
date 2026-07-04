<script setup lang="ts">
/**
 * DecorPalette — the decoration picker (right dock, shown while the "decor" tool is active).
 *
 * UX model: the 615 raw sprites are collapsed into ~110 NAMED GROUPS (a "Провал" with 47
 * looks is one card, not 47). Pick a group, then choose its LOOK from the variant strip —
 * cycle, click a specific one, or 🎲 random (mirrors the game's "re-roll appearance"). A
 * global search + family chips + faction/biome filters make finding things fast.
 *
 * Picking writes toolStore.decorId (a specific variant); MapCanvasHost ghosts + places it.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { Refresh } from "@element-plus/icons-vue";
import {
  useDecorStore,
  DECOR_FAMILIES,
  DECOR_STYLES,
  DECOR_TONES,
  type DecorGroup,
  type DecorThumb as DecorThumbRect,
} from "../stores/decorStore";
import { useToolStore } from "../stores/toolStore";
import DecorThumb from "./DecorThumb.vue";
import ThumbPreview from "./ThumbPreview.vue";

const decorStore = useDecorStore();
const toolStore = useToolStore();
const { decorId } = storeToRefs(toolStore);

onMounted(() => void decorStore.load());

// Filters live in decorStore (the dock flyout presets family / focuses search).
const { activeFamily, search, faction, tone, focusSearchTick } = storeToRefs(decorStore);

const searchInput = ref<HTMLElement | { focus(): void } | null>(null);
watch(focusSearchTick, () => {
  void nextTick(() => (searchInput.value as { focus(): void } | null)?.focus());
});

function matchesSearch(g: DecorGroup, q: string): boolean {
  if (!q) return true;
  const hay = `${g.label} ${g.shape} ${g.variants.map((v) => v.tags.join(" ")).join(" ")}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

const filtered = computed<DecorGroup[]>(() =>
  decorStore.groups
    .filter((g) => activeFamily.value === "all" || g.family === activeFamily.value)
    .filter((g) => !faction.value || g.styles.has(faction.value))
    .filter((g) => !tone.value || g.tones.has(tone.value))
    .filter((g) => matchesSearch(g, search.value))
    .sort((a, b) => b.variants.length - a.variants.length || a.label.localeCompare(b.label)),
);

const selectedGroup = computed(() => decorStore.groupOf(decorId.value));

/** Other groups with the same shape + footprint (drop-in alternatives). */
const similar = computed<DecorGroup[]>(() => {
  const g = selectedGroup.value;
  if (!g) return [];
  return decorStore.groups
    .filter((o) => o.key !== g.key && o.shape === g.shape && o.cx === g.cx && o.cy === g.cy)
    .slice(0, 12);
});

function pickGroup(g: DecorGroup): void {
  // keep the current look if you re-click the same group, else jump to its representative
  if (selectedGroup.value?.key === g.key) return;
  toolStore.setDecor(g.rep.id);
}
function pickVariant(id: string): void {
  toolStore.setDecor(id);
}
function rollRandom(): void {
  const next = decorStore.randomVariant(decorId.value);
  if (next) toolStore.setDecor(next);
}

// one shared floating zoom for variant/catalog cells (see ThumbPreview.vue)
const preview = ref<InstanceType<typeof ThumbPreview> | null>(null);
function showPreview(e: MouseEvent, thumb: DecorThumbRect, name: string): void {
  preview.value?.show(e.currentTarget as HTMLElement, thumb, name);
}
function hidePreview(): void {
  preview.value?.hide();
}

const FAMILY_CHIPS = [{ key: "all", label: "Все" }, ...DECOR_FAMILIES];
const variantIndex = computed(() => {
  const g = selectedGroup.value;
  if (!g) return 0;
  return g.variants.findIndex((v) => v.id === decorId.value) + 1;
});
</script>

<template>
  <div class="decor-palette d2-rail">
    <div class="dp-head">
      <span class="dp-title">Декорации</span>
      <el-tag size="small" type="info" effect="plain" round>{{ filtered.length }}</el-tag>
    </div>

    <el-input
      ref="searchInput"
      v-model="search"
      size="small"
      class="dp-search"
      placeholder="Найти декорацию…"
      clearable
    >
      <template #prefix><span class="dp-search-icon">⌕</span></template>
    </el-input>

    <div class="dp-chips">
      <button
        v-for="f in FAMILY_CHIPS"
        :key="f.key"
        type="button"
        class="dp-chip"
        :class="{ on: activeFamily === f.key }"
        @click="activeFamily = f.key"
      >
        {{ f.label }}
      </button>
    </div>

    <div class="dp-filters">
      <el-select v-model="faction" size="small" clearable placeholder="Фракция" class="dp-filter">
        <el-option v-for="s in DECOR_STYLES" :key="s.value" :label="s.label" :value="s.value" />
      </el-select>
      <el-select v-model="tone" size="small" clearable placeholder="Биом" class="dp-filter">
        <el-option v-for="t in DECOR_TONES" :key="t.value" :label="t.label" :value="t.value" />
      </el-select>
    </div>

    <!-- variant strip for the selected group (the "look" chooser) -->
    <div v-if="selectedGroup" class="dp-variants d2-card">
      <div class="dp-variants-head">
        <span class="dp-vlabel">{{ selectedGroup.label }}</span>
        <span class="dp-vcount">вид {{ variantIndex }}/{{ selectedGroup.variants.length }}</span>
        <el-button
          v-if="selectedGroup.variants.length > 1"
          class="dp-roll"
          size="small"
          :icon="Refresh"
          circle
          title="Случайный вид (R)"
          @click="rollRandom()"
        />
      </div>
      <el-scrollbar v-if="selectedGroup.variants.length > 1" class="dp-vstrip">
        <div class="dp-vstrip-row">
          <button
            v-for="v in selectedGroup.variants"
            :key="v.id"
            type="button"
            class="dp-vcell"
            :class="{ sel: v.id === decorId }"
            :title="v.desc_en"
            @click="pickVariant(v.id)"
            @mouseenter="showPreview($event, v.thumb, v.desc_en || selectedGroup.label)"
            @mouseleave="hidePreview()"
          >
            <DecorThumb :thumb="v.thumb" :size="40" />
          </button>
        </div>
      </el-scrollbar>
    </div>

    <!-- group grid -->
    <el-scrollbar class="dp-grid">
      <div v-if="decorStore.loading" class="dp-empty">Загрузка каталога…</div>
      <el-empty v-else-if="!filtered.length" description="Ничего не найдено" :image-size="60" />
      <div v-else class="dp-cards">
        <button
          v-for="g in filtered"
          :key="g.key"
          type="button"
          class="dp-card"
          :class="{ sel: selectedGroup?.key === g.key }"
          :title="`${g.label} · ${g.cx}×${g.cy}`"
          @click="pickGroup(g)"
          @mouseenter="showPreview($event, g.rep.thumb, g.label)"
          @mouseleave="hidePreview()"
        >
          <div class="dp-card-thumb">
            <DecorThumb :thumb="g.rep.thumb" :size="64" />
            <span v-if="g.variants.length > 1" class="dp-badge">×{{ g.variants.length }}</span>
          </div>
          <span class="dp-card-name">{{ g.label }}</span>
        </button>
      </div>

      <!-- similar (same shape + footprint) -->
      <div v-if="similar.length" class="dp-similar">
        <div class="d2-sec dp-similar-head">Похожие</div>
        <div class="dp-cards">
          <button
            v-for="g in similar"
            :key="g.key"
            type="button"
            class="dp-card sm"
            :title="`${g.label} · ${g.cx}×${g.cy}`"
            @click="pickGroup(g)"
            @mouseenter="showPreview($event, g.rep.thumb, g.label)"
            @mouseleave="hidePreview()"
          >
            <div class="dp-card-thumb">
              <DecorThumb :thumb="g.rep.thumb" :size="48" />
              <span v-if="g.variants.length > 1" class="dp-badge">×{{ g.variants.length }}</span>
            </div>
            <span class="dp-card-name">{{ g.label }}</span>
          </button>
        </div>
      </div>
    </el-scrollbar>

    <div v-if="selectedGroup" class="dp-sel">
      <DecorThumb class="dp-sel-thumb" :thumb="decorStore.get(decorId)?.thumb ?? selectedGroup.rep.thumb" :size="44" />
      <div class="dp-sel-info">
        <div class="dp-sel-name">{{ selectedGroup.label }}</div>
        <div class="dp-sel-meta">{{ selectedGroup.cx }}×{{ selectedGroup.cy }} · {{ selectedGroup.shape }}</div>
        <div class="dp-sel-hint">Клик — поставить · [ ] — вид · R — случайный · колесо — масштаб · Ctrl+тащить — карта</div>
      </div>
    </div>

    <ThumbPreview ref="preview" />
  </div>
</template>

<style scoped>
/* Root = right rail; .d2-rail owns the bg + single hairline seam. */
.decor-palette {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-size: 12px;
}
.dp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 6px;
}
.dp-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.dp-search {
  padding: 0 12px;
}
.dp-search-icon {
  font-size: 14px;
  color: var(--el-text-color-secondary);
}
.dp-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 12px 4px;
}
/* fills, not frames; active = the restrained primary wash */
.dp-chip {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: var(--d2-radius-pill);
  border: none;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.dp-chip:hover {
  background: var(--el-fill-color);
}
.dp-chip.on {
  background: var(--d2-active-bg);
  color: var(--d2-active-fg);
}
.dp-filters {
  display: flex;
  gap: 6px;
  padding: 6px 12px;
}
.dp-filter {
  flex: 1;
}
/* .d2-card owns fill + radius + padding — the strip floats as a soft card */
.dp-variants {
  margin: 6px 12px 2px;
}
.dp-variants-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.dp-vlabel {
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.dp-vcount {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.dp-roll {
  flex: 0 0 auto;
  opacity: 0.6;
}
.dp-roll:hover {
  opacity: 1;
}
.dp-vstrip {
  max-width: 100%;
}
.dp-vstrip-row {
  display: flex;
  gap: 4px;
  padding-bottom: 4px;
}
/* Checkerboard under every thumb is FIXED LIGHT in both themes: the sprites are
 * dark, they only read on a light backdrop. Hover/selection = soft rings, no frames. */
.dp-vcell {
  flex: 0 0 auto;
  padding: 2px;
  border: none;
  border-radius: var(--d2-radius);
  background: repeating-conic-gradient(#e9e5db 0% 25%, #f6f4ee 0% 50%) 0 / 12px 12px;
  cursor: pointer;
  transition: box-shadow 0.12s ease;
}
.dp-vcell:hover {
  box-shadow: 0 0 0 1px var(--el-border-color-lighter);
}
.dp-vcell.sel {
  box-shadow: 0 0 0 2px var(--d2-active-bar);
}
.dp-grid {
  flex: 1;
  min-height: 0;
}
.dp-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, 80px);
  gap: 6px;
  padding: 8px 12px;
}
/* soft card: fill only, no frame, no lift/shadow */
.dp-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 80px;
  padding: 5px 3px;
  background: var(--el-fill-color-light);
  border: none;
  border-radius: var(--d2-radius);
  cursor: pointer;
  overflow: hidden;
  transition: background 0.12s ease;
}
.dp-card:hover {
  background: var(--el-fill-color);
}
.dp-card.sel {
  background: var(--d2-active-bg);
  box-shadow: inset 0 0 0 1px var(--el-color-primary-light-5);
}
.dp-card.sm {
  width: 64px;
}
.dp-card-thumb {
  position: relative;
  border-radius: var(--d2-radius);
  overflow: hidden;
  background: repeating-conic-gradient(#e9e5db 0% 25%, #f6f4ee 0% 50%) 0 / 12px 12px;
}
.dp-badge {
  position: absolute;
  right: 2px;
  bottom: 2px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.4;
  color: #fff;
  background: rgba(0, 0, 0, 0.62);
  border-radius: 8px;
}
.dp-card-name {
  width: 100%;
  font-size: 10px;
  line-height: 1.15;
  text-align: center;
  color: var(--el-text-color-regular);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dp-similar {
  padding: 0 0 8px;
  margin-top: 4px;
}
/* .d2-sec owns the micro-caps look; just align it with the card grid */
.dp-similar-head {
  padding: 0 12px;
  margin-bottom: 0;
}
.dp-empty {
  padding: 16px;
  text-align: center;
  color: var(--el-text-color-secondary);
}
.dp-sel {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  background: var(--el-fill-color-lighter);
}
.dp-sel-thumb {
  border-radius: var(--d2-radius);
  overflow: hidden;
  background: repeating-conic-gradient(#e9e5db 0% 25%, #f6f4ee 0% 50%) 0 / 12px 12px;
}
.dp-sel-info {
  min-width: 0;
}
.dp-sel-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dp-sel-meta {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.dp-sel-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}
</style>
