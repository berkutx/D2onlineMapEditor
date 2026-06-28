<script setup lang="ts">
/**
 * Top menu bar:
 *   File ▸ Open map  -> dialog listing GET /api/scenarios, click to load.
 *   View ▸ Terrain / Objects layer toggles + Animation toggle.
 */
import { ref, computed, onMounted, watch } from "vue";
import { storeToRefs } from "pinia";
import { ElMessage, ElNotification } from "element-plus";
import { Check } from "@element-plus/icons-vue";
import type { ScenarioEntry, ValidationReport } from "@d2/socket-contract";
import type { OverlayTint } from "@d2/pixi-render";
import { createNewMap } from "../services/api";
import { useMapStore } from "../stores/mapStore";
import { useViewStore } from "../stores/viewStore";
import { useEditStore } from "../stores/editStore";

const mapStore = useMapStore();
const viewStore = useViewStore();
const editStore = useEditStore();

const { scenarios, currentScenarioId, status } = storeToRefs(mapStore);
const { busy: editBusy, dirty, undoable } = storeToRefs(editStore);
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

// --- Map switcher (direct dropdown; loads any map in realtime) ----------------
/** scenarios grouped by campaign, for the Map dropdown. */
const scenariosByCampaign = computed(() => {
  const groups = new Map<string, ScenarioEntry[]>();
  for (const s of scenarios.value) {
    const k = s.campaign || "—";
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  return [...groups.entries()].map(([campaign, maps]) => ({ campaign, maps }));
});

async function onMapCommand(id: string): Promise<void> {
  if (id === currentScenarioId.value) return;
  try {
    await mapStore.openMap(id);
  } catch (e) {
    ElMessage.error(`Failed to open map: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Editor: validate / export / undo / reset --------------------------------
// Keep an EditorProject alive for whichever map is open (restores persisted edits).
watch(
  currentScenarioId,
  (id) => {
    if (id) editStore.ensureProject(id);
  },
  { immediate: true },
);

const yn = (b: boolean): string => (b ? "✓" : "✗");

/** Show a validator report as a success/error notification. */
function showReport(r: ValidationReport): void {
  const lines = [
    `identity ${yn(r.identity)} · semantic ${yn(r.semantic.ok)} · structural ${yn(r.structural.ok)}`,
    `${r.opCount} edit(s) · ${r.byteLength.toLocaleString()} bytes`,
  ];
  if (!r.semantic.ok && r.semantic.reason) lines.push(`semantic: ${r.semantic.reason}`);
  if (r.structural.errors.length) lines.push(`errors: ${r.structural.errors.slice(0, 3).join("; ")}`);
  if (r.structural.warnings.length) {
    lines.push(`warnings (${r.structural.warnings.length}): ${r.structural.warnings.slice(0, 2).join("; ")}`);
  }
  ElNotification({
    title: r.ok ? "Map is valid" : "Map failed validation",
    message: lines.join("<br>"),
    dangerouslyUseHTMLString: true,
    type: r.ok ? "success" : "error",
    duration: r.ok ? 4000 : 0,
  });
}

async function doValidate(): Promise<void> {
  if (!currentScenarioId.value) {
    ElMessage.warning("Open a map first");
    return;
  }
  try {
    const r = await editStore.validate();
    if (r) showReport(r);
  } catch (e) {
    ElMessage.error(`Validate failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function doExport(): Promise<void> {
  if (!currentScenarioId.value) {
    ElMessage.warning("Open a map first");
    return;
  }
  try {
    const r = await editStore.exportSg();
    if (!r) return;
    if (r.ok) ElMessage.success(`Exported "${r.filename}" (validated)`);
    else {
      showReport(r.report);
      ElMessage.error("Export blocked — map failed validation");
    }
  } catch (e) {
    ElMessage.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- New Map (from-scratch terrain generation) -------------------------------
const newMapVisible = ref(false);
const newMapBusy = ref(false);
const newMap = ref<{ size: number; fill: string; name: string }>({
  size: 72,
  fill: "default",
  name: "New map",
});
/** Base fill options (land race themes + water); value = TerrainFill id. */
const fillOptions = [
  { value: "default", label: "Neutral land" },
  { value: "empire", label: "Empire (green)" },
  { value: "undead", label: "Undead (waste)" },
  { value: "legions", label: "Legions (infernal)" },
  { value: "elf", label: "Elves (forest)" },
  { value: "snow", label: "Mountain Clans (snow)" },
  { value: "water", label: "Water" },
];

async function doCreateNewMap(): Promise<void> {
  newMapBusy.value = true;
  try {
    const id = await createNewMap(newMap.value);
    await mapStore.openMap(id);
    editStore.ensureProject(id);
    newMapVisible.value = false;
    ElMessage.success(`Created ${newMap.value.size}×${newMap.value.size} ${newMap.value.fill} map`);
  } catch (e) {
    ElMessage.error(`New map failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    newMapBusy.value = false;
  }
}

function onEditorCommand(cmd: string): void {
  if (cmd === "new") newMapVisible.value = true;
  else if (cmd === "validate") void doValidate();
  else if (cmd === "export") void doExport();
  else if (cmd === "undo") editStore.undoEdit();
  else if (cmd === "reset") {
    editStore.reset();
    ElMessage.info("Edits discarded");
  }
}

// Populate the switcher up front so the dropdown is ready (best-effort).
onMounted(() => {
  void mapStore.loadScenarios().catch(() => {});
});
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

    <el-dropdown trigger="click" max-height="70vh" @command="onMapCommand">
      <span class="menu-trigger">Map</span>
      <template #dropdown>
        <el-dropdown-menu>
          <template v-for="g in scenariosByCampaign" :key="g.campaign">
            <el-dropdown-item disabled class="map-group">{{ g.campaign }}</el-dropdown-item>
            <el-dropdown-item v-for="m in g.maps" :key="m.id" :command="m.id">
              <el-icon v-if="m.id === currentScenarioId"><Check /></el-icon>
              <span class="check-spacer" v-else />
              {{ m.name }} <span class="map-size">{{ m.mapSize }}×{{ m.mapSize }}</span>
            </el-dropdown-item>
          </template>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <el-dropdown trigger="click" @command="onEditorCommand">
      <span class="menu-trigger">Editor</span>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="new">New map…</el-dropdown-item>
          <el-dropdown-item command="validate" divided>Validate map</el-dropdown-item>
          <el-dropdown-item command="export">Export .sg…</el-dropdown-item>
          <el-dropdown-item command="undo" divided :disabled="!undoable">Undo last edit</el-dropdown-item>
          <el-dropdown-item command="reset" :disabled="!dirty">Discard all edits</el-dropdown-item>
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

    <el-button
      class="validate-btn"
      size="small"
      type="success"
      plain
      :loading="editBusy"
      @click="doValidate()"
    >
      Validate{{ dirty ? " *" : "" }}
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

    <el-dialog v-model="newMapVisible" title="New map" width="380px">
      <el-form label-width="90px" label-position="left">
        <el-form-item label="Name">
          <el-input v-model="newMap.name" placeholder="New map" />
        </el-form-item>
        <el-form-item label="Size">
          <el-select v-model="newMap.size">
            <el-option v-for="s in [48, 72, 96, 120, 144]" :key="s" :label="`${s} × ${s}`" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="Fill">
          <el-select v-model="newMap.fill">
            <el-option v-for="o in fillOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="newMapVisible = false">Cancel</el-button>
        <el-button type="primary" :loading="newMapBusy" @click="doCreateNewMap()">Create</el-button>
      </template>
    </el-dialog>
  </div>
</template>


<style scoped>
.map-group {
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--el-text-color-secondary);
  opacity: 1 !important;
  cursor: default;
}
.map-size {
  margin-left: 6px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
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
