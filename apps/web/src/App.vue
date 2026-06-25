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
import { ElMessage } from "element-plus";
import { useMapStore } from "./stores/mapStore";
import { useAssetStore } from "./stores/assetStore";
import AppLayout from "./layout/AppLayout.vue";

const mapStore = useMapStore();
const assetStore = useAssetStore();

const bootLoading = ref(true);
const bootMessage = ref("Loading assets and map…");

onMounted(async () => {
  try {
    const list = await mapStore.loadScenarios();
    const target = mapStore.pickDefaultScenario(list);
    if (!target) {
      bootMessage.value = "No scenarios available on the server.";
      ElMessage.warning("No scenarios found. Use File ▸ Open map once any exist.");
      return;
    }
    bootMessage.value = `Loading "${target.name}"…`;
    await mapStore.openMap(target.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    bootMessage.value = `Startup failed: ${msg}`;
    ElMessage.error(`Startup failed: ${msg}`);
    // surface the asset error too if that was the cause
    if (assetStore.error) ElMessage.error(assetStore.error);
  } finally {
    bootLoading.value = false;
  }
});
</script>

<template>
  <div
    v-loading.fullscreen.lock="bootLoading"
    :element-loading-text="bootMessage"
    class="app-shell"
  >
    <AppLayout />
  </div>
</template>

<style scoped>
.app-shell {
  height: 100vh;
  width: 100vw;
}
</style>
