<script setup lang="ts">
/**
 * One picture change: A's picture | B's picture, its name and how it changed. A changed
 * picture is compared pixel by pixel: a third thumbnail paints the differing pixels and a
 * line says how many differ — or that none does. A click opens the picture up close.
 */
import { computed, ref, shallowRef, watch } from "vue";
import type { PictureChange } from "@d2/mod-diff";
import { intlLocale, tr, trn } from "../i18n";
import { useCompareStore } from "./compareStore";
import { drawable } from "./pictures";
import { comparable, comparePicture, sourcesFor, type PictureComparison } from "./pictureCompare";
import { changedShare, cropRaster, growBox, sizeChanged } from "./pixelDiff";
import { CHANGE_LABEL, PICTURE_KINDS } from "./labels";
import SpriteCrop from "./SpriteCrop.vue";
import ModIcon from "./ModIcon.vue";
import RasterCanvas from "./RasterCanvas.vue";
import PictureDiffViewer from "./PictureDiffViewer.vue";

const props = withDefaults(defineProps<{ change: PictureChange; size?: number; showName?: boolean }>(), { size: 64, showName: true });
const store = useCompareStore();

const picA = computed(() => drawable(props.change, props.change.a, store.side("a")?.manifest));
const picB = computed(() => drawable(props.change, props.change.b, store.side("b")?.manifest));
const iconA = computed(() => (props.change.kind === "icon" && props.change.a ? store.fileOf("a", props.change.name) : null));
const iconB = computed(() => (props.change.kind === "icon" && props.change.b ? store.fileOf("b", props.change.name) : null));
const layerText = (side: "a" | "b") => {
  const l = props.change[side]?.layer;
  if (!l) return "—";
  return `${l.picture} · z ${l.z}${l.rect ? ` · ${l.rect.join(", ")}` : ""}`;
};
const frameCount = computed(() => (props.change.kind === "animation" ? ((props.change.b ?? props.change.a)?.frames?.length ?? null) : null));
const tagType = computed(() => (props.change.change === "added" ? "success" : props.change.change === "removed" ? "danger" : "warning"));

// ---- the pixel comparison (a changed picture in a full-size pair)
const withDiff = computed(() => props.showName && comparable(props.change));
const cmp = shallowRef<PictureComparison | null>(null);
const cmpError = ref<string | null>(null);
watch(
  [() => props.change, withDiff],
  async ([change, wanted]) => {
    cmp.value = null;
    cmpError.value = null;
    if (!wanted) return;
    try {
      const r = await comparePicture(change, sourcesFor(store, change));
      if (change === props.change) cmp.value = r;
    } catch (e) {
      if (change === props.change) cmpError.value = e instanceof Error ? e.message : String(e);
    }
  },
  { immediate: true },
);
/** From this share of differing pixels on, the picture is called redrawn as a whole. */
const REDRAWN = 0.9;
/** The differences picture without its transparent margins, like the A and B thumbnails. */
const diffThumb = computed(() => {
  const c = cmp.value;
  if (!c) return null;
  const box = c.diff.content;
  return box ? cropRaster(c.highlight, growBox(box, 1, c.highlight.width, c.highlight.height)) : c.highlight;
});
const pct = (share: number) =>
  share > 0 && share < 0.001 ? "< 0.1%" : share.toLocaleString(intlLocale(), { style: "percent", maximumFractionDigits: 1 });
const dims = (s: [number, number] | null) => (s ? `${s[0]}×${s[1]}` : "—");

// ---- up close
const canOpen = computed(() => props.change.kind !== "capital-layer");
const viewer = ref(false);
const viewerMounted = ref(false);
function openViewer(): void {
  if (!canOpen.value) return;
  viewerMounted.value = true;
  viewer.value = true;
}
</script>

<template>
  <div class="pic-pair" :class="[`ch-${change.change}`, { wide: withDiff }]">
    <div v-if="change.kind === 'capital-layer'" class="layer">
      <div><span class="side-mark">A</span> {{ layerText("a") }}</div>
      <div><span class="side-mark">B</span> {{ layerText("b") }}</div>
    </div>
    <div v-else class="thumbs" :title="tr('Щёлкните, чтобы рассмотреть крупно')" @click="openViewer">
      <div class="thumb">
        <ModIcon v-if="change.kind === 'icon'" :url="iconA" :size="size" />
        <SpriteCrop v-else :pic="picA" :size="size" />
        <span class="side-mark">A</span>
      </div>
      <div class="thumb">
        <ModIcon v-if="change.kind === 'icon'" :url="iconB" :size="size" />
        <SpriteCrop v-else :pic="picB" :size="size" />
        <span class="side-mark">B</span>
      </div>
      <div v-if="withDiff" class="thumb">
        <RasterCanvas v-if="diffThumb" :raster="diffThumb" :fit="size" checker />
        <span v-else class="pending" :style="{ width: `${size}px`, height: `${size}px` }">{{ cmpError ? "?" : "…" }}</span>
        <span class="side-mark diff-mark">Δ</span>
      </div>
    </div>
    <div v-if="withDiff" class="diff-line">
      <template v-if="cmp">
        <template v-if="cmp.diff.changed">
          <span class="px-changed" @click="openViewer">
            {{ trn("{n} пиксель|{n} пикселя|{n} пикселей", cmp.diff.changed, { n: cmp.diff.changed.toLocaleString(intlLocale()) }) }} · {{ pct(changedShare(cmp.diff)) }}
          </span>
          <span v-if="changedShare(cmp.diff) >= REDRAWN" class="px-redrawn">{{ tr("перерисована целиком") }}</span>
        </template>
        <span v-else class="px-same" :title="change.kind === 'icon' ? tr('Пиксели совпадают — отличается только файл картинки (сжатие или палитра).') : tr('Пиксели совпадают — изменилась только упаковка листа.')">
          {{ tr("пиксели совпадают") }}
        </span>
        <span v-if="sizeChanged(cmp.diff)" class="px-size">{{ dims(cmp.diff.sizeA) }} → {{ dims(cmp.diff.sizeB) }}</span>
      </template>
      <span v-else-if="cmpError" class="dim" :title="cmpError">{{ tr("не удалось сравнить") }}</span>
      <span v-else class="dim">{{ tr("Сравниваю…") }}</span>
    </div>
    <div v-if="showName" class="caption">
      <el-tag :type="tagType" size="small" disable-transitions>{{ CHANGE_LABEL[change.change] }}</el-tag>
      <span class="mono name" :title="`${change.name} · ${change.archive ?? ''}`">{{ change.name }}</span>
      <span class="dim kind">{{ PICTURE_KINDS[change.kind] ?? change.kind }}{{ frameCount !== null ? ` · ${trn("{n} кадр|{n} кадра|{n} кадров", frameCount)}` : "" }}</span>
    </div>
    <PictureDiffViewer v-if="viewerMounted" v-model="viewer" :change="change" />
  </div>
</template>

<style scoped>
.pic-pair {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: var(--d2-hairline);
  border-radius: var(--d2-radius);
  background: var(--el-bg-color);
  min-width: 0;
}
.pic-pair.wide {
  grid-column: span 2;
  border-color: var(--el-color-warning-light-5);
}
.thumbs {
  display: flex;
  gap: 6px;
  justify-content: center;
  cursor: zoom-in;
}
.thumb {
  position: relative;
}
.thumb .side-mark {
  position: absolute;
  left: 2px;
  top: 1px;
}
.side-mark {
  font-size: 10px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}
.diff-mark {
  color: rgb(255, 140, 0);
}
.pending {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: var(--mods-pic-bg);
  color: var(--el-text-color-placeholder);
}
.diff-line {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 10px;
  font-size: 12px;
}
.px-changed {
  color: rgb(214, 110, 0);
  font-weight: 600;
  cursor: zoom-in;
}
.px-same {
  color: var(--el-color-success);
}
.px-redrawn {
  color: var(--el-text-color-secondary);
}
.px-size {
  font-weight: 600;
}
.caption {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.caption .el-tag {
  align-self: flex-start;
}
.name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kind {
  font-size: 11px;
}
.layer {
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: ui-monospace, Consolas, monospace;
}
</style>
