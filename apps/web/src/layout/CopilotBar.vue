<script setup lang="ts">
/**
 * Copilot — a light, frosted-glass floating command input docked at the bottom-centre of
 * the canvas (NOT a panel). Just a field: type a command, Enter to send. The chat log
 * floats above only while expanded (on focus / after a message). "/" focuses it (viewStore
 * focusCopilot); the ✕ hides it (and "/" brings it back). STUB responder for now (M6).
 */
import { ref, nextTick, watch } from "vue";
import { ElInput } from "element-plus";
import { MagicStick, Promotion, Close } from "@element-plus/icons-vue";
import { useViewStore } from "../stores/viewStore";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

const view = useViewStore();
const input = ref("");
const expanded = ref(false);
const inputRef = ref<InstanceType<typeof ElInput> | null>(null);
const scroller = ref<HTMLElement | null>(null);
const log = ref<Msg[]>([
  {
    role: "assistant",
    text: "Copilot (превью). Скоро: «залей водой», «добавь горы слева», «выдели участок и перегенерируй».",
  },
]);

function reply(prompt: string): string {
  return `🚧 Принял: «${prompt}». Команды пока не подключены — это заглушка (M6).`;
}

function send(): void {
  const text = input.value.trim();
  if (!text) return;
  log.value.push({ role: "user", text });
  input.value = "";
  log.value.push({ role: "assistant", text: reply(text) });
  expanded.value = true;
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
  });
}

function hide(): void {
  view.copilotVisible = false;
}

// "/" (viewStore.focusCopilot bumps the tick) -> reveal + focus the input.
watch(
  () => view.copilotFocusTick,
  () => {
    expanded.value = true;
    void nextTick(() => inputRef.value?.focus());
  },
);
</script>

<template>
  <div class="copilot-float">
    <transition name="cp-fade">
      <div v-if="expanded" ref="scroller" class="copilot-log">
        <div v-for="(m, i) in log" :key="i" class="cp-msg" :class="m.role">
          <span class="cp-who">{{ m.role === "user" ? "you" : "ai" }}</span>
          <span class="cp-text">{{ m.text }}</span>
        </div>
      </div>
    </transition>

    <div class="copilot-bar">
      <el-icon class="cp-spark"><MagicStick /></el-icon>
      <el-input
        ref="inputRef"
        v-model="input"
        class="cp-input"
        placeholder="Спросить карту…  ( / )"
        @focus="expanded = true"
        @keyup.enter="send()"
      />
      <el-button
        class="cp-send"
        text
        :icon="Promotion"
        :disabled="!input.trim()"
        title="Отправить (Enter)"
        @click="send()"
      />
      <el-icon class="cp-close" title="Скрыть ( / вернёт )" @click="hide()"><Close /></el-icon>
    </div>
  </div>
</template>

<style scoped>
.copilot-float {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  width: min(560px, 90%);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none; /* let the canvas receive events except on our controls */
}
.copilot-log,
.copilot-bar {
  pointer-events: auto;
  background: color-mix(in srgb, var(--el-bg-color) 68%, transparent);
  backdrop-filter: blur(14px) saturate(1.3);
  -webkit-backdrop-filter: blur(14px) saturate(1.3);
  border: 1px solid color-mix(in srgb, var(--el-border-color) 55%, transparent);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24);
}
.copilot-log {
  max-height: 220px;
  overflow-y: auto;
  padding: 8px 12px;
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.cp-msg {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.45;
}
.cp-who {
  flex: 0 0 20px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  padding-top: 2px;
  color: var(--el-text-color-secondary);
}
.cp-msg.user .cp-text {
  color: var(--el-text-color-primary);
}
.cp-msg.assistant .cp-text {
  color: var(--el-text-color-regular);
}
.copilot-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 999px;
}
.cp-spark {
  color: var(--el-color-primary);
  font-size: 16px;
  flex: 0 0 auto;
}
.cp-input {
  flex: 1;
}
.cp-input :deep(.el-input__wrapper) {
  background: transparent;
  box-shadow: none;
  padding: 2px 4px;
}
.cp-input :deep(.el-input__inner) {
  color: var(--el-text-color-primary);
}
.cp-send {
  flex: 0 0 auto;
}
.cp-close {
  flex: 0 0 auto;
  cursor: pointer;
  color: var(--el-text-color-secondary);
  padding: 2px;
}
.cp-close:hover {
  color: var(--el-text-color-primary);
}
.cp-fade-enter-active,
.cp-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.cp-fade-enter-from,
.cp-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
