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
  return v.stroke && v.cells ? `${v.cells.length} кл.` : `${v.region.w}×${v.region.h}`;
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
  if (!ok) ElMessage.info("После генерации были другие правки — вариант оставлен на карте как есть.");
}
async function another(): Promise<void> { gone(await gen.another()); }
async function step(delta: number): Promise<void> { gone(await gen.step(delta)); }
async function retune(i: number): Promise<void> {
  if (i < 0 || i >= AMOUNT_STEPS.length || i === amountIndex.value) return;
  gone(await gen.retune(AMOUNT_STEPS[i]!));
}

async function copySeed(): Promise<void> {
  try {
    await navigator.clipboard.writeText(String(seed.value));
    ElMessage.success(`Зерно ${seed.value} скопировано`);
  } catch {
    ElMessage.info(`Зерно варианта: ${seed.value}`);
  }
}
</script>

<template>
  <div v-if="s" class="gs-strip d2-float" role="group" aria-label="Варианты генерации">
    <span class="gs-title">{{ gen.iconOf(s.recipeId) }} {{ gen.titleOf(s.recipeId) }}</span>
    <span class="gs-meta">{{ where }}</span>
    <span v-if="!s.valid" class="gs-warn" title="Этот вариант не прошёл проверку карты и не применён">не применён</span>
    <!-- nothing came out because the mod has nothing of the kind (a typed «камни» on a mod without rocks) -->
    <span v-else-if="s.opCount === 0 && info?.lacks" class="gs-warn" :title="`Ничего не поставлено: ${info.lacks}`">{{ info.lacks }}</span>
    <span v-else-if="s.opCount === 0" class="gs-warn" title="Вариант ничего не изменил: место занято или защищено">ничего не изменил</span>

    <span class="gs-spring" />

    <!-- more / less of it: the same variant (same seed), another amount -->
    <span v-if="info?.amountLabel" class="gs-amount" :title="`Больше или меньше: ${info.amountLabel}`">
      <button class="gs-btn" :disabled="gen.busy || amountIndex === 0" aria-label="Меньше" @click="retune(amountIndex - 1)">−</button>
      <span class="gs-bars" aria-hidden="true">
        <i v-for="(_, i) in AMOUNT_STEPS" :key="i" :class="{ on: i <= amountIndex }" :style="{ height: 4 + i * 2 + 'px' }" />
      </span>
      <button class="gs-btn" :disabled="gen.busy || amountIndex === AMOUNT_STEPS.length - 1" aria-label="Больше" @click="retune(amountIndex + 1)">+</button>
      <span class="gs-alabel">{{ info.amountLabel }}</span>
    </span>

    <!-- variants: back to an earlier one, forward again, or a new one -->
    <span v-if="varies || s.seeds.length > 1" class="gs-variants">
      <button class="gs-btn" :disabled="gen.busy || s.index === 0" title="Предыдущий вариант" aria-label="Предыдущий вариант" @click="step(-1)">◀</button>
      <button class="gs-seed" :title="`Вариант ${s.index + 1} из ${s.seeds.length} · зерно ${seed} (нажми — скопировать)`" @click="copySeed">
        {{ s.index + 1 }}/{{ s.seeds.length }}
      </button>
      <button v-if="!isLast" class="gs-btn" :disabled="gen.busy" title="Следующий вариант" aria-label="Следующий вариант" @click="step(1)">▶</button>
      <button class="gs-btn gs-new" :disabled="gen.busy" title="Другой вариант (новое зерно)" @click="another()">↻ Другой</button>
    </span>

    <button class="gs-btn gs-drop" :disabled="gen.busy" title="Убрать сгенерированное с карты" @click="gen.discard()">Убрать</button>
    <button class="gs-btn gs-keep" :disabled="gen.busy" title="Оставить этот вариант" @click="gen.keep()">✓ Оставить</button>
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
