<script setup lang="ts">
/**
 * One picture change up close: A | B | the differences side by side at a chosen zoom, or
 * A and B on one spot to flip between (a click, or blinking). The differing pixels are
 * counted and boxed; the view can close in on that box.
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type { PictureChange } from "@d2/mod-diff";
import { intlLocale, tr, trn } from "../i18n";
import { useCompareStore } from "./compareStore";
import { comparePicture, sourcesFor, type PictureComparison } from "./pictureCompare";
import { HIGHLIGHT, PIX_ONLY_A, PIX_ONLY_B, PIX_RECOLOURED, changedShare, cropRaster, fitZoom, growBox, padRaster, sizeChanged, type Box, type Raster } from "./pixelDiff";
import { CHANGE_LABEL, PICTURE_KINDS } from "./labels";
import RasterCanvas from "./RasterCanvas.vue";

const props = defineProps<{ modelValue: boolean; change: PictureChange }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
const store = useCompareStore();
const open = computed({ get: () => props.modelValue, set: (v: boolean) => emit("update:modelValue", v) });

const result = shallowRef<PictureComparison | null>(null);
const failed = ref<string | null>(null);

const ZOOMS = [1, 2, 4, 8, 16] as const;
const mode = ref<"side" | "flip">("side");
const zoom = ref<number>(4);
const zoomPicked = ref(false);
const closeIn = ref(false);
const outline = ref(true);
const shown = ref<"a" | "b">("b");
const blink = ref(false);

watch(
  () => props.change,
  async (change) => {
    result.value = null;
    failed.value = null;
    try {
      const r = await comparePicture(change, sourcesFor(store, change));
      if (change !== props.change) return;
      result.value = r;
      const d = r.diff;
      const c = d.content ?? { w: d.width, h: d.height };
      // a big picture with a small change opens on the change
      closeIn.value = !!d.bbox && Math.max(c.w, c.h) > 160 && d.bbox.w * d.bbox.h * 6 < c.w * c.h;
    } catch (e) {
      failed.value = e instanceof Error ? e.message : String(e);
    }
  },
  { immediate: true },
);

const both = computed(() => props.change.change === "changed");
const d = computed(() => result.value?.diff ?? null);
const box = computed<Box>(() => {
  const x = d.value;
  if (!x) return { x: 0, y: 0, w: 0, h: 0 };
  if (closeIn.value && x.bbox) return growBox(x.bbox, Math.max(4, Math.round(Math.max(x.bbox.w, x.bbox.h) * 0.25)), x.width, x.height);
  // the picture's own transparent margins are left out
  if (x.content) return growBox(x.content, 2, x.width, x.height);
  return { x: 0, y: 0, w: x.width, h: x.height };
});
const view = (r: Raster | null | undefined): Raster | null => {
  const x = d.value;
  if (!r || !x) return null;
  return cropRaster(padRaster(r, x.width, x.height), box.value);
};
const viewA = computed(() => view(result.value?.a));
const viewB = computed(() => view(result.value?.b));
const viewH = computed(() => view(result.value?.highlight));

const panels = computed(() => (both.value && mode.value === "side" ? 3 : 1));
const autoZoom = computed(() => fitZoom(box.value.w, box.value.h, 1060, 540, panels.value, ZOOMS));
watch([autoZoom, panels], () => {
  if (!zoomPicked.value) zoom.value = autoZoom.value;
}, { immediate: true });
function pickZoom(z: string | number | boolean | undefined): void {
  zoom.value = Number(z);
  zoomPicked.value = true;
}

const outlineStyle = computed(() => {
  const b = d.value?.bbox;
  if (!b || !outline.value) return null;
  const z = zoom.value;
  return { left: `${(b.x - box.value.x) * z - 1}px`, top: `${(b.y - box.value.y) * z - 1}px`, width: `${b.w * z + 2}px`, height: `${b.h * z + 2}px` };
});

let timer: ReturnType<typeof setInterval> | null = null;
watch(
  [blink, open, mode],
  () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (blink.value && open.value && mode.value === "flip") timer = setInterval(() => (shown.value = shown.value === "a" ? "b" : "a"), 600);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
function flip(): void {
  shown.value = shown.value === "a" ? "b" : "a";
}

const num = (n: number) => n.toLocaleString(intlLocale());
const pct = (share: number) => {
  if (share > 0 && share < 0.001) return `< ${(0.001).toLocaleString(intlLocale(), { style: "percent", maximumFractionDigits: 1 })}`;
  return share.toLocaleString(intlLocale(), { style: "percent", maximumFractionDigits: 1 });
};
const size = (s: [number, number] | null) => (s ? `${s[0]}×${s[1]}` : "—");
const colour = (cls: 1 | 2 | 3) => `rgb(${HIGHLIGHT[cls].join(",")})`;
const legend = computed(() => {
  const x = d.value;
  if (!x) return [];
  return [
    { cls: PIX_RECOLOURED as 1, label: tr("другой цвет"), n: x.recoloured },
    { cls: PIX_ONLY_A as 2, label: tr("было только в A"), n: x.onlyA },
    { cls: PIX_ONLY_B as 3, label: tr("появилось в B"), n: x.onlyB },
  ].filter((l) => l.n > 0);
});
const sameNote = computed(() =>
  props.change.kind === "icon"
    ? tr("Пиксели совпадают — отличается только файл картинки (сжатие или палитра).")
    : tr("Пиксели совпадают — изменилась только упаковка листа."),
);
const tagType = computed(() => (props.change.change === "added" ? "success" : props.change.change === "removed" ? "danger" : "warning"));
</script>

<template>
  <el-dialog v-model="open" width="min(1180px, 96vw)" top="4vh" append-to-body class="pic-viewer">
    <template #header>
      <div class="v-head">
        <span class="mono v-name">{{ change.name }}</span>
        <el-tag :type="tagType" size="small" disable-transitions>{{ CHANGE_LABEL[change.change] }}</el-tag>
        <span class="dim">{{ PICTURE_KINDS[change.kind] ?? change.kind }}<template v-if="change.archive"> · <span class="mono">{{ change.archive }}</span></template></span>
      </div>
    </template>

    <el-alert v-if="failed" type="error" :closable="false" :title="tr('Не удалось загрузить картинку: {error}', { error: failed })" />
    <div v-else-if="!result" class="v-loading dim">{{ tr("Сравниваю…") }}</div>
    <template v-else-if="d">
      <!-- what differs -->
      <div class="v-facts">
        <template v-if="both">
          <span v-if="d.changed" class="v-count">
            <b>{{ trn("{n} пиксель отличается|{n} пикселя отличаются|{n} пикселей отличаются", d.changed, { n: num(d.changed) }) }}</b>
            <span class="dim">{{ tr("из {total} видимых", { total: num(d.visible) }) }} · {{ pct(changedShare(d)) }}</span>
          </span>
          <el-alert v-else type="success" :closable="false" show-icon :title="sameNote" class="v-same" />
          <span v-for="l in legend" :key="l.cls" class="v-legend"><i :style="{ background: colour(l.cls) }" />{{ l.label }} <span class="dim">{{ num(l.n) }}</span></span>
          <span v-if="sizeChanged(d)" class="v-size">{{ tr("Размер: {a} → {b}", { a: size(d.sizeA), b: size(d.sizeB) }) }}</span>
          <span v-else class="dim">{{ size(d.sizeB) }}</span>
          <span v-if="d.bbox" class="dim">{{ tr("Область отличий: x {x}, y {y}, {w}×{h}", { x: d.bbox.x, y: d.bbox.y, w: d.bbox.w, h: d.bbox.h }) }}</span>
        </template>
        <span v-else class="dim">{{ change.change === "added" ? tr("Картинка есть только в B") : tr("Картинка есть только в A") }} · {{ size(d.sizeA ?? d.sizeB) }}</span>
        <span v-if="result.frame" class="dim">
          {{ tr("Сравнивается кадр {i} — первый, который отличается", { i: result.frame.index + 1 }) }}<template v-if="result.frame.countA !== result.frame.countB"> · {{ tr("кадров: {a} → {b}", { a: result.frame.countA, b: result.frame.countB }) }}</template>
        </span>
      </div>

      <!-- how to look -->
      <div class="v-tools">
        <el-radio-group v-if="both" v-model="mode" size="small">
          <el-radio-button value="side">{{ tr("Рядом") }}</el-radio-button>
          <el-radio-button value="flip">{{ tr("На одном месте") }}</el-radio-button>
        </el-radio-group>
        <span class="v-label dim">{{ tr("Масштаб") }}</span>
        <el-radio-group :model-value="zoom" size="small" @change="pickZoom">
          <el-radio-button v-for="z in ZOOMS" :key="z" :value="z">{{ z }}×</el-radio-button>
        </el-radio-group>
        <el-switch v-if="both && d.bbox" v-model="closeIn" size="small" :active-text="tr('Ближе к отличиям')" />
        <el-switch v-if="both && d.bbox" v-model="outline" size="small" :active-text="tr('Рамка')" />
        <template v-if="both && mode === 'flip'">
          <el-radio-group v-model="shown" size="small">
            <el-radio-button value="a">A</el-radio-button>
            <el-radio-button value="b">B</el-radio-button>
          </el-radio-group>
          <el-switch v-model="blink" size="small" :active-text="tr('Мигать')" />
        </template>
      </div>

      <div class="v-stage">
        <template v-if="both && mode === 'side'">
          <figure class="v-panel">
            <figcaption><span class="side-mark">A</span> {{ store.modA?.name }}</figcaption>
            <div class="v-pic">
              <RasterCanvas :raster="viewA" :zoom="zoom" checker />
              <span v-if="outlineStyle" class="v-box" :style="outlineStyle" />
            </div>
          </figure>
          <figure class="v-panel">
            <figcaption><span class="side-mark">B</span> {{ store.modB?.name }}</figcaption>
            <div class="v-pic">
              <RasterCanvas :raster="viewB" :zoom="zoom" checker />
              <span v-if="outlineStyle" class="v-box" :style="outlineStyle" />
            </div>
          </figure>
          <figure class="v-panel">
            <figcaption>{{ tr("Отличия") }}</figcaption>
            <div class="v-pic">
              <RasterCanvas :raster="viewH" :zoom="zoom" checker />
              <span v-if="outlineStyle" class="v-box" :style="outlineStyle" />
            </div>
          </figure>
        </template>
        <figure v-else-if="both" class="v-panel">
          <figcaption>
            <span class="side-mark">{{ shown === "a" ? "A" : "B" }}</span> {{ shown === "a" ? store.modA?.name : store.modB?.name }}
            <span class="dim"> · {{ tr("щелчок по картинке — другой мод") }}</span>
          </figcaption>
          <div class="v-pic flip" @click="flip">
            <RasterCanvas :raster="shown === 'a' ? viewA : viewB" :zoom="zoom" checker />
            <span v-if="outlineStyle" class="v-box" :style="outlineStyle" />
          </div>
        </figure>
        <figure v-else class="v-panel">
          <figcaption>
            <span class="side-mark">{{ change.change === "added" ? "B" : "A" }}</span> {{ change.change === "added" ? store.modB?.name : store.modA?.name }}
          </figcaption>
          <div class="v-pic">
            <RasterCanvas :raster="change.change === 'added' ? viewB : viewA" :zoom="zoom" checker />
          </div>
        </figure>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
/* the dialog lives in <body>, outside the page's own .mods-app styles */
.v-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--el-text-color-primary);
}
.mono {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.dim {
  color: var(--el-text-color-secondary);
}
.v-facts,
.v-tools,
.v-panel figcaption {
  color: var(--el-text-color-regular);
}
.v-name {
  font-size: 15px;
  font-weight: 600;
}
.v-loading {
  padding: 40px 0;
  text-align: center;
}
.v-facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 18px;
  margin-bottom: 10px;
}
.v-count b {
  margin-right: 6px;
}
.v-same {
  width: auto;
  flex: 0 1 auto;
}
.v-legend {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.v-legend i {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 2px;
}
.v-size {
  font-weight: 600;
}
.v-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  margin-bottom: 12px;
}
.v-label {
  margin-right: -6px;
}
.v-stage {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  overflow: auto;
  max-height: 66vh;
  padding-bottom: 4px;
}
.v-panel {
  margin: 0;
  flex: 0 0 auto;
}
.v-panel figcaption {
  font-size: 12px;
  margin-bottom: 4px;
  white-space: nowrap;
}
.v-pic {
  position: relative;
  display: inline-block;
  line-height: 0;
  border: var(--d2-hairline);
}
.v-pic.flip {
  cursor: pointer;
}
.v-box {
  position: absolute;
  pointer-events: none;
  outline: 1px dashed var(--el-color-danger);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.5);
}
.side-mark {
  font-size: 11px;
  font-weight: 700;
  color: var(--el-text-color-secondary);
}
</style>
