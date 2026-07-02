<script setup lang="ts">
/**
 * Top menu bar — a real Element Plus el-menu (mode=horizontal): Файл / Правка /
 * Вид / Карта / Справка, plus a right-aligned cluster (map title, loading +
 * dirty tags, appearance toggle). No loose action buttons; view/grid/undo are
 * each defined in exactly one menu (their rapid surfaces live in the dock).
 */
import { ref, computed, onMounted, watch } from "vue";
import { storeToRefs } from "pinia";
import { ElMessage, ElNotification } from "element-plus";
import { Check, Moon, Sunny, Share } from "@element-plus/icons-vue";
import type { ScenarioEntry, ValidationReport } from "@d2/socket-contract";
import { createNewMap } from "../services/api";
import { useMapStore } from "../stores/mapStore";
import { useViewStore } from "../stores/viewStore";
import { useEditStore } from "../stores/editStore";
import { useCollabStore } from "../stores/collabStore";
import { getScene } from "../canvas/sceneHolder";

const mapStore = useMapStore();
const viewStore = useViewStore();
const editStore = useEditStore();
const collabStore = useCollabStore();

const { scenarios, currentScenarioId, status } = storeToRefs(mapStore);
const { peerList } = storeToRefs(collabStore);

/** Copy a share link (?map=<id>&room=<channel>): the guest opens the same map AND joins
 *  THIS session's collab channel (rooms are private per visitor otherwise). */
async function shareLink(): Promise<void> {
  const id = currentScenarioId.value;
  if (!id) return;
  const chan = collabStore.channel;
  const url = `${window.location.origin}${window.location.pathname}?map=${id}${chan ? `&room=${chan}` : ""}`;
  try {
    await navigator.clipboard.writeText(url);
    ElMessage.success("Ссылка для совместного редактирования скопирована");
  } catch {
    ElMessage.info(url);
  }
}

/** Two-letter initials for a peer avatar. */
const initials = (name: string): string =>
  name.replace(/[^\p{L}\p{N}]/gu, " ").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
const { dirty, undoable, redoable } = storeToRefs(editStore);
const {
  terrainVisible, objectsVisible, gridVisible, locationsVisible,
  animate, objectPanelVisible, debugOverlay, copilotVisible, dark, overlayTints,
} = storeToRefs(viewStore);

const dialogVisible = ref(false);
const listLoading = ref(false);
const shortcutsVisible = ref(false);

async function openDialog(): Promise<void> {
  dialogVisible.value = true;
  listLoading.value = true;
  try {
    await mapStore.loadScenarios();
  } catch (e) {
    ElMessage.error(`Не удалось получить список: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    listLoading.value = false;
  }
}

async function chooseScenario(entry: ScenarioEntry): Promise<void> {
  dialogVisible.value = false;
  try {
    await mapStore.openMap(entry.id);
  } catch (e) {
    ElMessage.error(`Не удалось открыть «${entry.name}»: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** scenarios grouped by campaign, for the Карта submenu. */
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
    ElMessage.error(`Не удалось открыть карту: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Keep an EditorProject alive for whichever map is open (restores persisted edits).
watch(
  currentScenarioId,
  (id) => {
    if (id) editStore.ensureProject(id);
  },
  { immediate: true },
);

const yn = (b: boolean): string => (b ? "✓" : "✗");

function showReport(r: ValidationReport): void {
  const lines = [
    `identity ${yn(r.identity)} · semantic ${yn(r.semantic.ok)} · structural ${yn(r.structural.ok)}`,
    `${r.opCount} правок · ${r.byteLength.toLocaleString()} байт`,
  ];
  if (!r.semantic.ok && r.semantic.reason) lines.push(`semantic: ${r.semantic.reason}`);
  if (r.structural.errors.length) lines.push(`ошибки: ${r.structural.errors.slice(0, 3).join("; ")}`);
  if (r.structural.warnings.length) {
    lines.push(`предупреждения (${r.structural.warnings.length}): ${r.structural.warnings.slice(0, 2).join("; ")}`);
  }
  ElNotification({
    title: r.ok ? "Карта корректна" : "Карта не прошла проверку",
    message: lines.join("<br>"),
    dangerouslyUseHTMLString: true,
    type: r.ok ? "success" : "error",
    duration: r.ok ? 4000 : 0,
  });
}

async function doValidate(): Promise<void> {
  if (!currentScenarioId.value) return ElMessage.warning("Сначала откройте карту");
  try {
    const r = await editStore.validate();
    if (r) showReport(r);
  } catch (e) {
    ElMessage.error(`Проверка не удалась: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function doExport(): Promise<void> {
  if (!currentScenarioId.value) return ElMessage.warning("Сначала откройте карту");
  try {
    const r = await editStore.exportSg();
    if (!r) return;
    if (r.ok) ElMessage.success(`Экспортировано «${r.filename}» (проверено)`);
    else {
      showReport(r.report);
      ElMessage.error("Экспорт заблокирован — карта не прошла проверку");
    }
  } catch (e) {
    ElMessage.error(`Экспорт не удался: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- New Map -----------------------------------------------------------------
const newMapVisible = ref(false);
const newMapBusy = ref(false);
const newMap = ref<{ size: number; fill: string; name: string }>({ size: 72, fill: "default", name: "Новая карта" });
const fillOptions = [
  { value: "default", label: "Нейтральная земля" },
  { value: "empire", label: "Империя (зелень)" },
  { value: "undead", label: "Нежить (пустошь)" },
  { value: "legions", label: "Легионы (инферно)" },
  { value: "elf", label: "Эльфы (лес)" },
  { value: "snow", label: "Горные кланы (снег)" },
  { value: "water", label: "Вода" },
];

async function doCreateNewMap(): Promise<void> {
  newMapBusy.value = true;
  try {
    const id = await createNewMap(newMap.value);
    await mapStore.openMap(id);
    editStore.ensureProject(id);
    newMapVisible.value = false;
    ElMessage.success(`Создана карта ${newMap.value.size}×${newMap.value.size}`);
  } catch (e) {
    // PERSISTENT notification (not an auto-dismissing toast): a silent failure here left the
    // editor on the previous map with its "есть правки" tag — which read as "the new map
    // inherited the old edits". Be explicit that NOTHING changed.
    ElNotification({
      type: "error",
      title: "Карта НЕ создана",
      message: `Сервер не ответил (${e instanceof Error ? e.message : String(e)}). Открыта прежняя карта — её правки не тронуты. Попробуйте ещё раз.`,
      duration: 0,
    });
  } finally {
    newMapBusy.value = false;
  }
}

/** el-menu dispatcher — one place routes every menu-item index to its action. */
function onSelect(index: string): void {
  switch (index) {
    case "file:open": return void openDialog();
    case "file:new": newMapVisible.value = true; return;
    case "file:export": return void doExport();
    case "edit:undo": return editStore.undoEdit();
    case "edit:redo": return editStore.redoEdit();
    case "edit:validate": return void doValidate();
    case "edit:discard": editStore.reset(); ElMessage.info("Правки сброшены"); return;
    case "view:terrain": return viewStore.setLayerVisible("terrain", !terrainVisible.value);
    case "view:objects": return viewStore.setLayerVisible("objects", !objectsVisible.value);
    case "view:grid": return viewStore.toggleGrid();
    case "view:locations": return viewStore.toggleLocations();
    case "view:animate": return viewStore.toggleAnimate();
    case "view:objectPanel": return viewStore.toggleObjectPanel();
    case "view:debug": return viewStore.toggleDebugOverlay();
    case "view:fit": getScene()?.fitView(); return;
    case "view:copilot": return viewStore.toggleCopilot();
    case "view:appearance": return viewStore.toggleDark();
    case "help:keys": shortcutsVisible.value = true; return;
  }
  if (index.startsWith("view:tint:")) return viewStore.toggleOverlayTint(index.slice(10) as never);
  if (index.startsWith("map:")) return void onMapCommand(index.slice(4));
}

onMounted(() => void mapStore.loadScenarios().catch(() => {}));
</script>

<template>
  <div class="menu-bar">
    <span class="app-title"><span class="app-mark" />Disciples II</span>

    <el-menu class="topmenu" mode="horizontal" :ellipsis="false" :default-active="''" @select="onSelect">
      <el-sub-menu index="file">
        <template #title>Файл</template>
        <el-menu-item index="file:open">Открыть карту…<span class="mkbd">Ctrl+O</span></el-menu-item>
        <el-menu-item index="file:new">Новая карта…</el-menu-item>
        <el-menu-item index="file:export">Экспорт .sg…</el-menu-item>
      </el-sub-menu>

      <el-sub-menu index="edit">
        <template #title>Правка</template>
        <el-menu-item index="edit:undo" :disabled="!undoable">Отменить<span class="mkbd">Ctrl+Z</span></el-menu-item>
        <el-menu-item index="edit:redo" :disabled="!redoable">Вернуть<span class="mkbd">Ctrl+⇧Z</span></el-menu-item>
        <el-menu-item index="edit:validate">Проверить карту</el-menu-item>
        <el-menu-item index="edit:discard" :disabled="!dirty">Сбросить правки</el-menu-item>
      </el-sub-menu>

      <el-sub-menu index="view">
        <template #title>Вид</template>
        <el-menu-item index="view:terrain"><el-icon class="mck" :style="{ visibility: terrainVisible ? 'visible' : 'hidden' }"><Check /></el-icon>Слой рельефа<span class="mkbd">T</span></el-menu-item>
        <el-menu-item index="view:objects"><el-icon class="mck" :style="{ visibility: objectsVisible ? 'visible' : 'hidden' }"><Check /></el-icon>Слой объектов<span class="mkbd">O</span></el-menu-item>
        <el-menu-item index="view:grid"><el-icon class="mck" :style="{ visibility: gridVisible ? 'visible' : 'hidden' }"><Check /></el-icon>Сетка<span class="mkbd">G</span></el-menu-item>
        <el-menu-item index="view:locations"><el-icon class="mck" :style="{ visibility: locationsVisible ? 'visible' : 'hidden' }"><Check /></el-icon>Локации<span class="mkbd">L</span></el-menu-item>
        <el-menu-item index="view:animate"><el-icon class="mck" :style="{ visibility: animate ? 'visible' : 'hidden' }"><Check /></el-icon>Анимация<span class="mkbd">A</span></el-menu-item>
        <el-menu-item index="view:objectPanel"><el-icon class="mck" :style="{ visibility: objectPanelVisible ? 'visible' : 'hidden' }"><Check /></el-icon>Панель объектов<span class="mkbd">P</span></el-menu-item>
        <el-menu-item index="view:debug"><el-icon class="mck" :style="{ visibility: debugOverlay ? 'visible' : 'hidden' }"><Check /></el-icon>Отладка<span class="mkbd">D</span></el-menu-item>
        <el-sub-menu index="view:tints">
          <template #title>Подсветки</template>
          <el-menu-item index="view:tint:passable"><el-icon class="mck" :style="{ visibility: overlayTints.passable ? 'visible' : 'hidden' }"><Check /></el-icon>Проходимость</el-menu-item>
          <el-menu-item index="view:tint:danger"><el-icon class="mck" :style="{ visibility: overlayTints.danger ? 'visible' : 'hidden' }"><Check /></el-icon>Опасность</el-menu-item>
          <el-menu-item index="view:tint:terraform"><el-icon class="mck" :style="{ visibility: overlayTints.terraform ? 'visible' : 'hidden' }"><Check /></el-icon>Террформинг</el-menu-item>
          <el-menu-item index="view:tint:forest"><el-icon class="mck" :style="{ visibility: overlayTints.forest ? 'visible' : 'hidden' }"><Check /></el-icon>Лес</el-menu-item>
          <el-menu-item index="view:tint:roads"><el-icon class="mck" :style="{ visibility: overlayTints.roads ? 'visible' : 'hidden' }"><Check /></el-icon>Дороги</el-menu-item>
        </el-sub-menu>
        <el-menu-item index="view:fit">К размеру окна<span class="mkbd">F</span></el-menu-item>
        <el-menu-item index="view:copilot"><el-icon class="mck" :style="{ visibility: copilotVisible ? 'visible' : 'hidden' }"><Check /></el-icon>Copilot<span class="mkbd">/</span></el-menu-item>
        <el-menu-item index="view:appearance"><el-icon class="mck" :style="{ visibility: dark ? 'visible' : 'hidden' }"><Check /></el-icon>Тёмная тема</el-menu-item>
      </el-sub-menu>

      <el-sub-menu index="map">
        <template #title>Карта</template>
        <el-sub-menu v-for="g in scenariosByCampaign" :key="g.campaign" :index="'map:camp:' + g.campaign">
          <template #title>{{ g.campaign }}</template>
          <el-menu-item v-for="m in g.maps" :key="m.id" :index="'map:' + m.id">
            <el-icon class="mck" :style="{ visibility: m.id === currentScenarioId ? 'visible' : 'hidden' }"><Check /></el-icon>
            {{ m.name }} <span class="mkbd">{{ m.mapSize }}×{{ m.mapSize }}</span>
          </el-menu-item>
        </el-sub-menu>
      </el-sub-menu>

      <el-sub-menu index="help">
        <template #title>Справка</template>
        <el-menu-item index="help:keys">Горячие клавиши…</el-menu-item>
      </el-sub-menu>
    </el-menu>

    <span class="bar-spacer" />

    <span v-if="mapStore.mapName" class="map-title">{{ mapStore.mapName }}</span>
    <el-tag v-if="status === 'loading'" size="small" type="warning" effect="plain" round>Загрузка…</el-tag>
    <el-tag v-if="dirty" size="small" type="warning" effect="plain" round>есть правки</el-tag>

    <!-- collaborators present in this map's room (each in their assigned colour) -->
    <span v-if="peerList.length" class="peers">
      <el-tooltip
        v-for="p in peerList"
        :key="p.socketId"
        :content="p.name"
        placement="bottom"
        :show-after="200"
      >
        <span class="peer-avatar" :style="{ background: p.color }">{{ initials(p.name) }}</span>
      </el-tooltip>
    </span>
    <el-tooltip content="Скопировать ссылку для совместного редактирования" placement="bottom" :show-after="300">
      <el-button class="appearance" text :icon="Share" :disabled="!currentScenarioId" @click="shareLink()" />
    </el-tooltip>

    <el-tooltip :content="dark ? 'Светлая тема' : 'Тёмная тема'" placement="bottom" :show-after="300">
      <el-button class="appearance" text :icon="dark ? Sunny : Moon" @click="viewStore.toggleDark()" />
    </el-tooltip>

    <el-dialog v-model="dialogVisible" title="Открыть карту" width="640px" :close-on-click-modal="true">
      <el-table
        v-loading="listLoading"
        :data="scenarios"
        height="360"
        highlight-current-row
        @row-click="chooseScenario"
      >
        <el-table-column prop="name" label="Название" min-width="200" />
        <el-table-column prop="campaign" label="Кампания" min-width="160" />
        <el-table-column label="Размер" width="90">
          <template #default="{ row }">{{ row.mapSize }}×{{ row.mapSize }}</template>
        </el-table-column>
        <el-table-column prop="players" label="Игроки" width="90" />
        <el-table-column label="" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.id === currentScenarioId" size="small" type="success">открыта</el-tag>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <span class="dialog-hint">Кликните строку, чтобы загрузить карту.</span>
      </template>
    </el-dialog>

    <el-dialog v-model="newMapVisible" title="Новая карта" width="380px">
      <el-form label-width="90px" label-position="left">
        <el-form-item label="Название">
          <el-input v-model="newMap.name" placeholder="Новая карта" />
        </el-form-item>
        <el-form-item label="Размер">
          <el-select v-model="newMap.size">
            <el-option v-for="s in [48, 72, 96, 120, 144]" :key="s" :label="`${s} × ${s}`" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="Заливка">
          <el-select v-model="newMap.fill">
            <el-option v-for="o in fillOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="newMapVisible = false">Отмена</el-button>
        <el-button type="primary" :loading="newMapBusy" @click="doCreateNewMap()">Создать</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="shortcutsVisible" title="Горячие клавиши" width="420px">
      <div class="keys">
        <div class="krow"><kbd>T</kbd> <kbd>O</kbd> <kbd>G</kbd> <kbd>L</kbd> <span>слои: рельеф / объекты / сетка / локации</span></div>
        <div class="krow"><kbd>A</kbd> <kbd>P</kbd> <kbd>D</kbd> <span>анимация / панель объектов / отладка</span></div>
        <div class="krow"><kbd>F</kbd> <span>вписать карту в окно</span></div>
        <div class="krow"><kbd>/</kbd> <span>фокус на Copilot</span></div>
        <div class="krow"><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>⇧</kbd>+<kbd>Z</kbd> <span>отменить / вернуть</span></div>
        <div class="krow"><kbd>Ctrl</kbd>+тащить <span>двигать карту · колесо — масштаб</span></div>
        <div class="krow"><kbd>R</kbd> <kbd>[</kbd> <kbd>]</kbd> <span>облик декора (инструменты Декор / Двигать)</span></div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.menu-bar {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 var(--d2-sp-3);
  gap: var(--d2-sp-2);
  background: var(--el-bg-color);
  border-bottom: var(--d2-hairline);
}
.peers {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin: 0 2px;
}
.peer-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.5);
  box-shadow: 0 0 0 1.5px var(--el-bg-color);
}
.app-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 600;
  font-size: 13px;
  margin-right: var(--d2-sp-2);
  color: var(--el-text-color-primary);
  white-space: nowrap;
}
.app-mark {
  width: 16px;
  height: 16px;
  border-radius: 5px;
  background: var(--el-color-primary);
}
/* el-menu reset: flat, header-height, no underline, transparent so the bar bg shows */
.topmenu.el-menu--horizontal {
  height: var(--d2-header-h);
  border-bottom: none;
  background: transparent;
  --el-menu-bg-color: transparent;
  --el-menu-hover-bg-color: var(--el-fill-color-light);
  --el-menu-active-color: var(--el-text-color-primary);
}
.topmenu.el-menu--horizontal :deep(.el-sub-menu__title) {
  height: calc(var(--d2-header-h) - 6px);
  line-height: calc(var(--d2-header-h) - 6px);
  border-bottom: none !important;
  border-radius: var(--d2-radius);
  padding: 0 10px;
  font-size: 13px;
}
.topmenu.el-menu--horizontal :deep(.el-sub-menu) {
  margin: 0 1px;
}
.bar-spacer {
  flex: 1;
}
.map-title {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.appearance {
  flex: 0 0 auto;
}
.dialog-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.keys {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.krow {
  display: flex;
  align-items: center;
  gap: 6px;
}
.krow span {
  color: var(--el-text-color-secondary);
}
kbd {
  font-family: inherit;
  font-size: 11px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  padding: 1px 6px;
}
</style>

<!-- Menu popups teleport to <body>; style their items + checkmark column unscoped. -->
<style>
.el-menu--horizontal .el-menu .el-menu-item,
.el-menu--horizontal .el-menu .el-sub-menu__title {
  height: 34px;
  line-height: 34px;
  font-size: 13px;
}
.el-menu--horizontal .el-menu-item .mck,
.el-menu--horizontal .el-menu .mck {
  margin-right: 6px;
  color: var(--el-color-primary);
}
.el-menu--horizontal .el-menu-item .mkbd,
.el-menu .el-menu-item .mkbd {
  margin-left: auto;
  padding-left: 18px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
</style>
