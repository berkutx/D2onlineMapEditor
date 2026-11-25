<script setup lang="ts">
/**
 * The open map's MOD, in the top bar: which game data set the map is opened against, how
 * that was decided, and — when the map references ids the mod does not define — a warning
 * that opens the list. The owner of an uploaded map can re-assign the mod here; that starts
 * a fresh page session on the map (one mod's data per session, see modStore).
 */
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { ElMessage } from "element-plus";
import { WarningFilled } from "@element-plus/icons-vue";
import type { MapModSource } from "@d2/socket-contract";
import { useMapStore, reloadOnMap } from "../stores/mapStore";
import { useModStore } from "../stores/modStore";
import { setMapMod } from "../services/api";

const mapStore = useMapStore();
const modStore = useModStore();
const { currentMod, modEditable, currentScenarioId } = storeToRefs(mapStore);
const { openableMods } = storeToRefs(modStore);

const visible = ref(false);
const busy = ref(false);
/** The mod picked in the dialog ("" = let the server decide from the map's content). */
const picked = ref("");

watch(visible, (open) => {
  if (open) picked.value = currentMod.value?.source === "choice" ? currentMod.value.id : "";
});

const SOURCE_TEXT: Record<MapModSource, string> = {
  install: "карта лежит в папке сценариев этого мода",
  choice: "мод выбран явно",
  detected: "определён по содержимому карты",
  default: "по содержимому карты мод определить нельзя — взят мод по умолчанию",
};

/** Globals table behind each id table code. */
const TABLE_TEXT: Record<string, string> = {
  UU: "Юниты",
  IG: "Предметы",
  SS: "Заклинания",
  MG: "Объекты местности",
  UM: "Модификаторы",
  LR: "Лорды",
  RR: "Расы",
  BB: "Постройки",
};

const missing = computed(() => currentMod.value?.missing ?? 0);
const scriptMissing = computed(() => currentMod.value?.scriptMissing ?? 0);
const rows = (byTable: Record<string, string[]> | undefined) =>
  Object.entries(byTable ?? {}).map(([code, ids]) => ({ code, label: TABLE_TEXT[code] ?? code, ids }));
const missingRows = computed(() => rows(currentMod.value?.missingByTable));
const scriptRows = computed(() => rows(currentMod.value?.scriptMissingByTable));

/** Other mods the map was matched against (shown so a better fit is visible at a glance). */
const candidates = computed(() =>
  (currentMod.value?.candidates ?? []).map((c) => ({
    ...c,
    name: modStore.nameOf(c.modId),
    current: c.modId === currentMod.value?.id,
    dataOnly: modStore.mods.find((m) => m.id === c.modId)?.status === "data-only",
  })),
);

const changed = computed(() => {
  const now = currentMod.value?.source === "choice" ? currentMod.value.id : "";
  return picked.value !== now;
});

async function apply(): Promise<void> {
  const id = currentScenarioId.value;
  if (!id) return;
  busy.value = true;
  try {
    await setMapMod(id, picked.value || null);
    // the new mod's data replaces this session's: start a fresh one on the same map
    reloadOnMap(id);
  } catch (e) {
    busy.value = false;
    ElMessage.error(`Мод не изменён: ${e instanceof Error ? e.message : String(e)}`);
  }
}
</script>

<template>
  <template v-if="currentMod">
    <el-tooltip :content="`Мод карты: ${SOURCE_TEXT[currentMod.source]}`" placement="bottom" :show-after="300">
      <el-tag class="mod-tag" size="small" effect="plain" round @click="visible = true">
        {{ modStore.nameOf(currentMod.id) }}
      </el-tag>
    </el-tooltip>
    <el-tooltip
      v-if="missing > 0 || scriptMissing > 0"
      content="Карта ссылается на данные, которых нет в этом моде"
      placement="bottom"
      :show-after="200"
    >
      <el-tag class="mod-tag" size="small" :type="missing > 0 ? 'danger' : 'warning'" effect="dark" round @click="visible = true">
        <el-icon class="mod-ico"><WarningFilled /></el-icon>
        нет в моде: {{ missing + scriptMissing }}
      </el-tag>
    </el-tooltip>

    <el-dialog v-model="visible" title="Мод карты" width="560px">
      <p class="mod-line">
        <b>{{ modStore.nameOf(currentMod.id) }}</b> — {{ SOURCE_TEXT[currentMod.source] }}.
      </p>

      <template v-if="missing > 0">
        <el-alert type="error" :closable="false" show-icon>
          <template #title>В моде нет {{ missing }} объектов, на которые ссылается карта</template>
          Игра и её редактор не загрузят такую карту с этим модом.
        </el-alert>
        <div v-for="r in missingRows" :key="r.code" class="mod-ids">
          <div class="mod-ids-head">{{ r.label }} — {{ r.ids.length }}</div>
          <div class="mod-ids-list">{{ r.ids.join(", ") }}</div>
        </div>
      </template>
      <template v-if="scriptMissing > 0">
        <el-alert type="warning" :closable="false" show-icon>
          <template #title>Скрипт карты упоминает {{ scriptMissing }} объектов, которых нет в моде</template>
          Карта загрузится, но скрипт может не сработать.
        </el-alert>
        <div v-for="r in scriptRows" :key="r.code" class="mod-ids">
          <div class="mod-ids-head">{{ r.label }} — {{ r.ids.length }}</div>
          <div class="mod-ids-list">{{ r.ids.join(", ") }}</div>
        </div>
      </template>
      <p v-if="currentMod.missing === 0 && !scriptMissing" class="mod-ok">
        Все объекты, на которые ссылается карта, в этом моде есть.
      </p>

      <template v-if="candidates.length > 1">
        <div class="mod-sub">Как карта подходит к установленным модам</div>
        <el-table :data="candidates" size="small" :show-header="true">
          <el-table-column label="Мод" min-width="200">
            <template #default="{ row }">
              {{ row.name }}
              <el-tag v-if="row.current" size="small" type="success" effect="plain">текущий</el-tag>
              <el-tag v-if="row.dataOnly" size="small" type="info" effect="plain">без графики</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="Нет в моде" width="110" prop="missing" />
          <el-table-column label="В скрипте" width="100" prop="scriptMissing" />
        </el-table>
      </template>

      <template v-if="modEditable">
        <div class="mod-sub">Сменить мод</div>
        <el-select v-model="picked" class="mod-select">
          <el-option value="" label="Определять по содержимому карты" />
          <el-option v-for="m in openableMods" :key="m.id" :value="m.id" :label="m.name" />
        </el-select>
        <div class="mod-hint">
          Сама карта не меняется: мод решает, какие юниты, предметы и графику показывает редактор.
          После смены страница перезагрузится.
        </div>
      </template>

      <template #footer>
        <el-button @click="visible = false">Закрыть</el-button>
        <el-button v-if="modEditable" type="primary" :loading="busy" :disabled="!changed" @click="apply()">
          Сменить мод
        </el-button>
      </template>
    </el-dialog>
  </template>
</template>

<style scoped>
.mod-tag {
  cursor: pointer;
}
.mod-ico {
  margin-right: 3px;
  vertical-align: -2px;
}
.mod-line {
  margin: 0 0 12px;
}
.mod-ok {
  margin: 0 0 12px;
  color: var(--el-color-success);
}
.mod-ids {
  margin: 8px 0 12px;
}
.mod-ids-head {
  font-weight: 600;
  font-size: 12px;
}
.mod-ids-list {
  max-height: 84px;
  overflow: auto;
  font-family: var(--el-font-family-monospace, monospace);
  font-size: 11px;
  color: var(--el-text-color-secondary);
  word-break: break-word;
}
.mod-sub {
  margin: 16px 0 6px;
  font-weight: 600;
}
.mod-select {
  width: 100%;
}
.mod-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
