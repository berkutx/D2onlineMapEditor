<script setup lang="ts">
/**
 * Поле кода с подсветкой синтаксиса Lua (Prism) — классический оверлей-редактор:
 * позади лежит <pre><code> с подсвеченным HTML, поверх — <textarea> с прозрачным
 * текстом. Шрифт/паддинги/межстрочный интервал у слоёв совпадают 1:1, поэтому
 * глифы выравниваются точно; скролл синхронизируется textarea → pre.
 * Тема Prism не импортируется: токены раскрашены переменными Element Plus,
 * так что и светлый, и тёмный chrome выглядят нативно.
 */
import { computed, ref, watch } from "vue";
import Prism from "prismjs";
import "prismjs/components/prism-lua";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

const preEl = ref<HTMLElement | null>(null);

// Local draft drives the LIVE highlight while typing but does NOT commit — the edit is emitted
// once on blur, so editing code in a big scenario doesn't fire the recompute cascade per keystroke.
const draft = ref(props.modelValue ?? "");
watch(() => props.modelValue, (v) => { draft.value = v ?? ""; });
function commit(): void {
  if (draft.value !== (props.modelValue ?? "")) emit("update:modelValue", draft.value);
}

const MIN_ROWS = 4;
const MAX_ROWS = 14;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const highlighted = computed<string>(() => {
  const code = draft.value ?? "";
  const lua = Prism.languages["lua"];
  const html = lua ? Prism.highlight(code, lua, "lua") : escapeHtml(code);
  // Хвостовой \n схлопывается в <pre> — добиваем пробелом, чтобы высоты слоёв совпадали.
  return code.endsWith("\n") ? `${html} ` : html;
});

/** Авторост по строкам: wrap="off" ⇒ визуальных строк ровно столько, сколько \n. */
const rows = computed<number>(() => {
  const n = (draft.value ?? "").split("\n").length;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, n));
});

function onInput(e: Event): void {
  draft.value = (e.target as HTMLTextAreaElement).value; // live highlight only; commit on blur
}

/** Держим слой подсветки приклеенным к позиции скролла textarea. */
function onScroll(e: Event): void {
  const t = e.target as HTMLTextAreaElement;
  const pre = preEl.value;
  if (pre) {
    pre.scrollTop = t.scrollTop;
    pre.scrollLeft = t.scrollLeft;
  }
}
</script>

<template>
  <div class="ci" :style="{ '--ci-rows': rows }">
    <pre ref="preEl" class="ci-pre" aria-hidden="true"><code class="ci-code" v-html="highlighted"></code></pre>
    <textarea
      class="ci-ta"
      :value="draft"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      wrap="off"
      @input="onInput"
      @blur="commit"
      @scroll="onScroll"
    ></textarea>
  </div>
</template>

<style scoped>
.ci {
  /* метрики, общие для ОБОИХ слоёв — менять только парой */
  --ci-font: ui-monospace, "Cascadia Code", Consolas, monospace;
  --ci-size: 12px;
  --ci-lh: 18px;
  --ci-pad-y: 6px;
  --ci-pad-x: 10px;

  position: relative;
  width: 100%;
  height: calc(var(--ci-rows) * var(--ci-lh) + 2 * var(--ci-pad-y));
  background: var(--el-fill-color-light);
  border-radius: var(--d2-radius);
  /* хейрлайн как у el-input (inset, чтобы не менять layout) */
  box-shadow: 0 0 0 1px var(--el-input-border-color, var(--el-border-color)) inset;
  transition: box-shadow var(--el-transition-duration-fast, 0.2s) ease;
}
.ci:hover {
  box-shadow: 0 0 0 1px var(--el-input-hover-border-color, var(--el-border-color-hover)) inset;
}
.ci:focus-within {
  box-shadow: 0 0 0 1px var(--el-input-focus-border-color, var(--el-color-primary)) inset;
}

/* оба слоя — один и тот же бокс с одинаковыми метриками текста */
.ci-pre,
.ci-ta {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: var(--ci-pad-y) var(--ci-pad-x);
  border: none;
  font-family: var(--ci-font);
  font-size: var(--ci-size);
  line-height: var(--ci-lh);
  font-variant-ligatures: none;
  letter-spacing: normal;
  tab-size: 4;
  white-space: pre;
  word-break: normal;
  overflow-wrap: normal;
  background: transparent;
  border-radius: var(--d2-radius);
}

.ci-pre {
  overflow: hidden;
  pointer-events: none;
  color: var(--el-text-color-primary);
}
.ci-code {
  font: inherit;
  letter-spacing: inherit;
  white-space: inherit;
  background: transparent;
  padding: 0;
}

.ci-ta {
  display: block;
  width: 100%;
  height: 100%;
  resize: none;
  overflow: auto;
  outline: none;
  color: transparent;
  caret-color: var(--el-text-color-primary);
}
.ci-ta::selection {
  background: var(--el-color-primary-light-7);
  color: transparent;
}

/* токены Prism — на переменных Element Plus, нативно в light и dark */
.ci-code :deep(.token.comment) {
  color: var(--el-text-color-secondary);
  font-style: italic;
}
.ci-code :deep(.token.keyword) {
  color: var(--el-color-primary);
}
.ci-code :deep(.token.string) {
  color: var(--el-color-success);
}
.ci-code :deep(.token.number) {
  color: var(--el-color-warning);
}
.ci-code :deep(.token.function) {
  color: var(--el-color-danger);
}
.ci-code :deep(.token.operator),
.ci-code :deep(.token.punctuation) {
  color: var(--el-text-color-regular);
}
</style>
