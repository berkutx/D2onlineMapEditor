<script setup lang="ts">
/**
 * LuaView — read-only Lua source with Prism syntax highlighting (the viewer twin of CodeInput,
 * which is the editable overlay). Tokens are painted with Element Plus variables so light/dark
 * chrome both look native. Scrolls inside its own box; the page never scrolls horizontally.
 */
import { computed } from "vue";
import Prism from "prismjs";
import "prismjs/components/prism-lua";

const props = defineProps<{ code: string }>();

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const highlighted = computed<string>(() => {
  const lua = Prism.languages["lua"];
  return lua ? Prism.highlight(props.code ?? "", lua, "lua") : escapeHtml(props.code ?? "");
});
</script>

<template>
  <pre class="lv"><code class="lv-code" v-html="highlighted"></code></pre>
</template>

<style scoped>
.lv {
  margin: 0;
  padding: 8px 10px;
  max-height: 420px;
  overflow: auto;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--d2-radius, 4px);
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  tab-size: 4;
  white-space: pre;
  color: var(--el-text-color-primary);
}
.lv-code { font: inherit; background: transparent; padding: 0; white-space: inherit; }
.lv-code :deep(.token.comment) { color: var(--el-text-color-secondary); font-style: italic; }
.lv-code :deep(.token.keyword) { color: var(--el-color-primary); }
.lv-code :deep(.token.string) { color: var(--el-color-success); }
.lv-code :deep(.token.number) { color: var(--el-color-warning); }
.lv-code :deep(.token.function) { color: var(--el-color-danger); }
.lv-code :deep(.token.operator),
.lv-code :deep(.token.punctuation) { color: var(--el-text-color-regular); }
</style>
