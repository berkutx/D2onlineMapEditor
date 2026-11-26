<script setup lang="ts">
/**
 * The strip shown above the generator bar while a generation is being tried out: what was
 * made and where, which variant is on the map, and the controls to step through variants,
 * make more or less of it, keep it or take it away. All of it drives genStore — a variant is
 * regenerated from its seed, so «предыдущий» really is the earlier picture.
 */
import { computed } from "vue";
import { ElMessage } from "element-plus";
import { AMOUNT_STEPS, useGenStore } from "../stores/genStore";
import { tr, trn } from "../i18n";

const gen = useGenStore();
const s = computed(() => gen.session);
const info = computed(() => (s.value ? gen.infoOf(s.value.recipeId) : undefined));
const seed = computed(() => (s.value ? s.value.seeds[s.value.index]! : 0));
const isLast = computed(() => !!s.value && s.value.index === s.value.seeds.length - 1);

/** A drawn stroke is so many cells; an area is its size (the mask of the visible screen is
 *  only what clips it). */
const where = computed(() => {
  const v = s.value;
  if (!v) return "";
  return v.stroke && v.cells ? trn("{n} кл.", v.cells.length) : `${v.region.w}×${v.region.h}`;
});

/** Would another seed give another picture? Not for a fill, nor for a path that follows the
 *  stroke cell for cell — there «другой вариант» would only repeat the same thing. */
const varies = computed(() => {
  const v = s.value;
  if (!v) return false;
  const i = info.value;
  return (v.stroke ? i?.strokeVaries : i?.varies) ?? true;
});

/** The nearest step of the «меньше … больше» control to the session's amount. */
const amountIndex = computed(() => {
  const a = s.value?.amount ?? 1;
  let best = 0;
  AMOUNT_STEPS.forEach((v, i) => {
    if (Math.abs(v - a) < Math.abs(AMOUNT_STEPS[best]! - a)) best = i;
  });
  return best;
});

/** The session ended under us (the user edited the map since): say so once, plainly. */
function gone(ok: boolean): void {
  if (!ok) ElMessage.info(tr("После генерации были другие правки — вариант оставлен на карте как есть."));
}
async function another(): Promise<void> { gone(await gen.another()); }
async function step(delta: number): Promise<void> { gone(await gen.step(delta)); }
async function retune(i: number): Promise<void> {
  if (i < 0 || i >= AMOUNT_STEPS.length || i === amountIndex.value) return;
  gone(await gen.retune(AMOUNT_STEPS[i]!));
}

/** A maze: build its walls the other way (the same maze, the same seed). */
async function rewall(value: boolean): Promise<void> {
  if (s.value && value !== s.value.sealed) gone(await gen.rewall(value));
}

async function copySeed(): Promise<void> {
  try {
    await navigator.clipboard.writeText(String(seed.value));
    ElMessage.success(tr("Зерно {seed} скопировано", { seed: seed.value }));
  } catch {
    ElMessage.info(tr("Зерно варианта: {seed}", { seed: seed.value }));
  }
}
</script>

<template>
  <div v-if="s" class="gs-strip d2-float" role="group" :aria-label="tr('Варианты генерации')">
    <span class="gs-title">{{ gen.iconOf(s.recipeId) }} {{ gen.titleOf(s.recipeId) }}</span>
    <span class="gs-meta">{{ where }}</span>
    <span v-if="!s.valid" class="gs-warn" :title="tr('Этот вариант не прошёл проверку карты и не применён')">{{ tr("не применён") }}</span>
    <!-- nothing came out because the mod has nothing of the kind (a typed «камни» on a mod without rocks) -->
    <span v-else-if="s.opCount === 0 && info?.lacks" class="gs-warn" :title="tr('Ничего не поставлено: {reason}', { reason: tr(info.lacks) })">{{ tr(info.lacks) }}</span>
    <span v-else-if="s.opCount === 0" class="gs-warn" :title="tr('Вариант ничего не изменил: место занято или защищено')">{{ tr("ничего не изменил") }}</span>
    <!-- a maze that could not build some of its wall: even sealed, it lets through there -->
    <span v-else-if="info?.walls && s.wallGaps > 0" class="gs-warn"
      :title="tr('Там уже что-то стоит или местность защищена — в этих местах стены нет, и отряд пройдёт. Уберите помеху или сдвиньте зону.')">
      {{ trn("{n} просвет в стене|{n} просвета в стене|{n} просветов в стене", s.wallGaps) }}
    </span>

    <span class="gs-spring" />

    <!-- a maze: an obstacle, or for looks only — the same maze built the other way -->
    <span v-if="info?.walls" class="gs-walls" role="group" :aria-label="tr('Стены лабиринта')">
      <button class="gs-btn" :class="{ on: s.sealed }" :disabled="gen.busy" :aria-pressed="s.sealed"
        :title="tr('Стены — преграда: в каждом стыке закрыта каждая клетка, пройти можно только через входы')" @click="rewall(true)">{{ tr("🔒 Наглухо") }}</button>
      <button class="gs-btn" :class="{ on: !s.sealed }" :disabled="gen.busy" :aria-pressed="!s.sealed"
        :title="tr('Лабиринт для вида: стыки легче и чище, без подпорок у башен; что отряд нигде не просочится — не обещано')" @click="rewall(false)">{{ tr("👁 Только вид") }}</button>
    </span>

    <!-- more / less of it: the same variant (same seed), another amount -->
    <span v-if="info?.amountLabel" class="gs-amount" :title="tr('Больше или меньше: {what}', { what: tr(info.amountLabel) })">
      <button class="gs-btn" :disabled="gen.busy || amountIndex === 0" :aria-label="tr('Меньше')" @click="retune(amountIndex - 1)">−</button>
      <span class="gs-bars" aria-hidden="true">
        <i v-for="(_, i) in AMOUNT_STEPS" :key="i" :class="{ on: i <= amountIndex }" :style="{ height: 4 + i * 2 + 'px' }" />
      </span>
      <button class="gs-btn" :disabled="gen.busy || amountIndex === AMOUNT_STEPS.length - 1" :aria-label="tr('Больше')" @click="retune(amountIndex + 1)">+</button>
      <span class="gs-alabel">{{ tr(info.amountLabel) }}</span>
    </span>

    <!-- variants: back to an earlier one, forward again, or a new one -->
    <span v-if="varies || s.seeds.length > 1" class="gs-variants">
      <button class="gs-btn" :disabled="gen.busy || s.index === 0" :title="tr('Предыдущий вариант')" :aria-label="tr('Предыдущий вариант')" @click="step(-1)">◀</button>
      <button class="gs-seed" :title="tr('Вариант {i} из {total} · зерно {seed} (нажми — скопировать)', { i: s.index + 1, total: s.seeds.length, seed })" @click="copySeed">
        {{ s.index + 1 }}/{{ s.seeds.length }}
      </button>
      <button v-if="!isLast" class="gs-btn" :disabled="gen.busy" :title="tr('Следующий вариант')" :aria-label="tr('Следующий вариант')" @click="step(1)">▶</button>
      <button class="gs-btn gs-new" :disabled="gen.busy" :title="tr('Другой вариант (новое зерно)')" @click="another()">{{ tr("↻ Другой") }}</button>
    </span>

    <button class="gs-btn gs-drop" :disabled="gen.busy" :title="tr('Убрать сгенерированное с карты')" @click="gen.discard()">{{ tr("Убрать") }}</button>
    <button class="gs-btn gs-keep" :disabled="gen.busy" :title="tr('Оставить этот вариант')" @click="gen.keep()">{{ tr("✓ Оставить") }}</button>
  </div>
</template>

<style scoped>
.gs-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: auto;
}
.gs-title { font-weight: 600; }
.gs-meta { color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
.gs-warn { color: var(--el-color-warning); }
.gs-spring { flex: 1; min-width: 4px; }
.gs-amount, .gs-variants { display: inline-flex; align-items: center; gap: 4px; }
.gs-walls { display: inline-flex; align-items: center; }
.gs-walls .gs-btn:first-child { border-radius: 4px 0 0 4px; }
.gs-walls .gs-btn:last-child { border-radius: 0 4px 4px 0; margin-left: -1px; }
.gs-btn.on { border-color: var(--el-color-primary); color: var(--el-color-primary); background: var(--el-color-primary-light-9); position: relative; }
.gs-alabel { color: var(--el-text-color-secondary); max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.gs-bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 14px; }
.gs-bars i { width: 3px; border-radius: 1px; background: var(--el-border-color); }
.gs-bars i.on { background: var(--el-color-primary); }
.gs-btn, .gs-seed {
  height: 22px;
  min-width: 22px;
  padding: 0 6px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-primary);
  font: inherit;
  cursor: pointer;
}
.gs-btn:hover:not(:disabled), .gs-seed:hover { border-color: var(--el-color-primary); }
.gs-btn:focus-visible, .gs-seed:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
.gs-btn:disabled { opacity: 0.45; cursor: default; }
.gs-seed { font-variant-numeric: tabular-nums; color: var(--el-text-color-secondary); }
.gs-keep { border-color: var(--el-color-success); color: var(--el-color-success); }
.gs-drop:hover:not(:disabled) { border-color: var(--el-color-danger); color: var(--el-color-danger); }
</style>
