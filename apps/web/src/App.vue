<script setup lang="ts">
/**
 * Root component. On startup it auto-loads a scenario so the app shows a
 * rendered map immediately: list scenarios -> pick "Riders" (else the first)
 * -> open it. The asset manifest + spritesheets load lazily inside openMap and
 * are reused for every subsequent map.
 *
 * A full-screen el-loading overlay covers the first asset+map load (the only
 * heavy wait of the session).
 */
import { onMounted, ref } from "vue";
import { ElMessage, ElButton } from "element-plus";
import { useMapStore } from "./stores/mapStore";
import { useAssetStore } from "./stores/assetStore";
import AppLayout from "./layout/AppLayout.vue";

const mapStore = useMapStore();
const assetStore = useAssetStore();

const bootLoading = ref(true);
const bootMessage = ref("Loading assets and map…");
/** Set when startup ultimately fails (after getJson's own retries) — shows a Retry button
 *  so a backend that was briefly down doesn't leave a permanent blank screen. */
const bootError = ref<string | null>(null);

async function boot(): Promise<void> {
  bootError.value = null;
  bootLoading.value = true;
  bootMessage.value = "Loading assets and map…";
  try {
    const list = await mapStore.loadScenarios();
    const target = mapStore.pickDefaultScenario(list);
    if (!target) {
      bootMessage.value = "No scenarios available on the server.";
      ElMessage.warning("No scenarios found. Use File ▸ Open map once any exist.");
      bootLoading.value = false;
      return;
    }
    bootMessage.value = `Loading "${target.name}"…`;
    await mapStore.openMap(target.id);
    bootLoading.value = false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bootLoading.value = false;
    bootError.value = assetStore.error ? `${msg} (${assetStore.error})` : msg;
    ElMessage.error(`Startup failed: ${msg}`);
  }
}

onMounted(boot);
</script>

<template>
  <div
    v-loading.fullscreen.lock="bootLoading"
    :element-loading-text="bootMessage"
    class="app-shell"
  >
    <AppLayout />
    <div v-if="bootError" class="boot-error">
      <div class="boot-error-title">Не удалось загрузить карту</div>
      <div class="boot-error-msg">{{ bootError }}</div>
      <el-button type="primary" @click="boot()">Повторить</el-button>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  height: 100vh;
  width: 100vw;
}
.boot-error {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 4000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 20px 28px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--el-bg-color) 92%, transparent);
  border: 1px solid var(--el-border-color);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
  text-align: center;
}
.boot-error-title {
  font-weight: 700;
  color: var(--el-color-danger);
}
.boot-error-msg {
  max-width: 460px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  word-break: break-word;
}
</style>
