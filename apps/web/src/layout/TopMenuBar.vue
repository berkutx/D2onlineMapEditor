<script setup lang="ts">
/**
 * Top menu bar:
 *   File ▸ Open map  -> dialog listing GET /api/scenarios, click to load.
 *   View ▸ Terrain / Objects layer toggles + Animation toggle.
 */
import { ref } from "vue";
import { storeToRefs } from "pinia";
import { ElMessage } from "element-plus";
import { Check } from "@element-plus/icons-vue";
import type { ScenarioEntry } from "@d2/socket-contract";
import type { OverlayTint } from "@d2/pixi-render";
import { useMapStore } from "../stores/mapStore";
import { useViewStore } from "../stores/viewStore";

const mapStore = useMapStore();
const viewStore = useViewStore();

const { scenarios, currentScenarioId, status } = storeToRefs(mapStore);
const {
  terrainVisible,
  objectsVisible,
  gridVisible,
  locationsVisible,
  animate,
  objectPanelVisible,
  debugOverlay,
  overlayTints,
} = storeToRefs(viewStore);

const dialogVisible = ref(false);
const listLoading = ref(false);

async function openDialog(): Promise<void> {
  dialogVisible.value = true;
  listLoading.value = true;
  try {
    await mapStore.loadScenarios();
  } catch (e) {
    ElMessage.error(
      `Failed to list scenarios: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    listLoading.value = false;
  }
}

async function chooseScenario(entry: ScenarioEntry): Promise<void> {
  dialogVisible.value = false;
  try {
    await mapStore.openMap(entry.id);
  } catch (e) {
    ElMessage.error(
      `Failed to open "${entry.name}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function onLayerCommand(command: string): void {
  if (command === "terrain") {
    viewStore.setLayerVisible("terrain", !terrainVisible.value);
  } else if (command === "objects") {
    viewStore.setLayerVisible("objects", !objectsVisible.value);
  } else if (command === "grid") {
    viewStore.toggleGrid();
  } else if (command === "locations") {
    viewStore.toggleLocations();
  } else if (command === "animate") {
    viewStore.toggleAnimate();
  } else if (command === "objectPanel") {
    viewStore.toggleObjectPanel();
  } else if (command === "debug") {
    viewStore.toggleDebugOverlay();
  } else if (command.startsWith("tint:")) {
    viewStore.toggleOverlayTint(command.slice(5) as OverlayTint);
  }
}
</script>

<template>
  <div class="menu-bar">
    <span class="app-title">Disciples II — Web Map Editor</span>

    <el-dropdown trigger="click" @command="(c: string) => c === 'open' && openDialog()">
      <span class="menu-trigger">File</span>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="open">Open map…</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <el-dropdown trigger="click" :hide-on-click="false" @command="onLayerCommand">
      <span class="menu-trigger">View</span>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="terrain">
            <el-icon v-if="terrainVisible"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Terrain layer
          </el-dropdown-item>
          <el-dropdown-item command="objects">
            <el-icon v-if="objectsVisible"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Objects layer
          </el-dropdown-item>
          <el-dropdown-item command="grid">
            <el-icon v-if="gridVisible"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Grid
          </el-dropdown-item>
          <el-dropdown-item command="locations">
            <el-icon v-if="locationsVisible"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Locations
          </el-dropdown-item>
          <el-dropdown-item command="animate" divided>
            <el-icon v-if="animate"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Animation
          </el-dropdown-item>
          <el-dropdown-item command="objectPanel" divided>
            <el-icon v-if="objectPanelVisible"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Objects panel
          </el-dropdown-item>
          <el-dropdown-item command="debug">
            <el-icon v-if="debugOverlay"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Debug overlay
          </el-dropdown-item>

          <el-dropdown-item command="tint:passable" divided>
            <el-icon v-if="overlayTints.passable"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Overlay: passability
          </el-dropdown-item>
          <el-dropdown-item command="tint:danger">
            <el-icon v-if="overlayTints.danger"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Overlay: danger
          </el-dropdown-item>
          <el-dropdown-item command="tint:terraform">
            <el-icon v-if="overlayTints.terraform"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Overlay: terraform
          </el-dropdown-item>
          <el-dropdown-item command="tint:forest">
            <el-icon v-if="overlayTints.forest"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Overlay: forest
          </el-dropdown-item>
          <el-dropdown-item command="tint:roads">
            <el-icon v-if="overlayTints.roads"><Check /></el-icon>
            <span class="check-spacer" v-else />
            Overlay: roads
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <el-button
      class="grid-toggle"
      size="small"
      :type="gridVisible ? 'primary' : 'info'"
      plain
      @click="viewStore.toggleGrid()"
    >
      {{ gridVisible ? "Hide grid" : "Show grid" }}
    </el-button>

    <span class="bar-spacer" />
    <el-tag v-if="status === 'loading'" size="small" type="warning" effect="plain">
      Loading…
    </el-tag>

    <el-dialog
      v-model="dialogVisible"
      title="Open map"
      width="640px"
      :close-on-click-modal="true"
    >
      <el-table
        v-loading="listLoading"
        :data="scenarios"
        height="360"
        highlight-current-row
        @row-click="chooseScenario"
      >
        <el-table-column prop="name" label="Name" min-width="200" />
        <el-table-column prop="campaign" label="Campaign" min-width="160" />
        <el-table-column label="Size" width="90">
          <template #default="{ row }">{{ row.mapSize }}×{{ row.mapSize }}</template>
        </el-table-column>
        <el-table-column prop="players" label="Players" width="90" />
        <el-table-column label="" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.id === currentScenarioId" size="small" type="success">
              open
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <span class="dialog-hint">Click a row to load the map.</span>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.menu-bar {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 12px;
  gap: 4px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-light);
}
.app-title {
  font-weight: 600;
  font-size: 13px;
  margin-right: 16px;
  color: var(--el-text-color-primary);
}
.menu-trigger {
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
  outline: none;
  color: var(--el-text-color-regular);
}
.menu-trigger:hover {
  background: var(--el-fill-color-light);
}
.grid-toggle {
  margin-left: 8px;
}
.bar-spacer {
  flex: 1;
}
.check-spacer {
  display: inline-block;
  width: 1em;
}
.dialog-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
