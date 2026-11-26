<script setup lang="ts">
/**
 * The campaign windows, opened through the campaign store from the File menu and the
 * campaign bar:
 *  - «Открыть кампанию»: the sagas the mods ship with and this browser's own campaigns;
 *  - the campaign window: the header the game's saga menu shows (name, author, description,
 *    race, the hero's starting level) and the missions in play order. A new campaign and an
 *    own one are edited here; a mod's saga is shown as it is, with «Сделать свою копию».
 */
import { computed, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowDown, ArrowUp, Delete, WarningFilled } from "@element-plus/icons-vue";
import type { CampaignEntry, CampaignMissionIssue, CampaignRaceKey } from "@d2/socket-contract";
import { PLAYABLE_CAMPAIGN_RACES, campaignRaceOfPlayer } from "@d2/map-edit";
import { useCampaignStore, issueText } from "../stores/campaignStore";
import { useMapStore } from "../stores/mapStore";
import { useEditStore } from "../stores/editStore";
import { useModStore } from "../stores/modStore";
import { createNewMap } from "../services/api";
import { useCampaignActions, raceLabel, CAMPAIGN_RACE_LABELS } from "../composables/campaignActions";
import { tr, trc } from "../i18n";

const campaign = useCampaignStore();
const mapStore = useMapStore();
const editStore = useEditStore();
const modStore = useModStore();
const actions = useCampaignActions();

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// --- «Открыть кампанию» ------------------------------------------------------------------
const search = ref("");
watch(
  () => campaign.openVisible,
  (open) => {
    if (!open) return;
    search.value = "";
    void campaign.loadList().catch((e) => ElMessage.error(tr("Не удалось получить список: {error}", { error: message(e) })));
  },
);
/** Own campaigns first, then the sagas of the mod being worked on, then the other mods'. */
const shownCampaigns = computed(() => {
  const q = search.value.trim().toLowerCase();
  const rank = (c: CampaignEntry): number => (c.source === "own" ? 0 : c.mod === modStore.activeModId ? 1 : 2);
  return campaign.list
    .filter((c) => !q || `${c.header.name} ${c.header.author} ${c.fileName ?? ""}`.toLowerCase().includes(q))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
});
const readable = (c: CampaignEntry): number => c.missions.filter((m) => m.mapId).length;

async function chooseCampaign(row: CampaignEntry): Promise<void> {
  if (readable(row) === 0) {
    ElMessage.warning(tr("Миссии этой саги в старом формате — редактор их не открывает"));
    return;
  }
  campaign.openVisible = false;
  await actions.openCampaign(row.id);
}

async function uploadFromList(): Promise<void> {
  if (await actions.uploadCsg()) campaign.openVisible = false;
}

function newFromList(): void {
  campaign.openVisible = false;
  campaign.showEditor("create");
}

// --- the campaign window ------------------------------------------------------------------
interface DraftMission {
  mapId?: string;
  title: string;
  fileName?: string;
  mapSize?: number;
  /** As the server checked the saved campaign; absent for a mission added or moved since. */
  issues?: CampaignMissionIssue[];
}
interface Draft {
  name: string;
  description: string;
  author: string;
  race: CampaignRaceKey;
  heroLevel: number;
  missions: DraftMission[];
}

const draft = ref<Draft>({ name: "", description: "", author: "", race: "empire", heroLevel: 1, missions: [] });
/** The race the missions' issues were checked for (null: not checked). */
const checkedRace = ref<CampaignRaceKey | null>(null);
/** A new campaign, or an own one its owner may change; a mod's saga is only shown. */
const editable = computed(() => campaign.editorMode === "create" || campaign.current?.editable === true);
const isInstall = computed(() => campaign.editorMode === "edit" && campaign.current?.source === "install");
const title = computed(() =>
  campaign.editorMode === "create" ? tr("Новая кампания") : editable.value ? tr("Кампания") : tr("Сага мода"),
);
const raceOptions = PLAYABLE_CAMPAIGN_RACES.map((value) => ({ value, label: CAMPAIGN_RACE_LABELS[value] }));

/** The race a new campaign starts with: the open map's first playable race. */
function defaultRace(): CampaignRaceKey {
  for (const p of editStore.liveDoc?.players ?? []) {
    const race = campaignRaceOfPlayer(p);
    if (race && race !== "neutral") return race;
  }
  return "empire";
}

function openMapAsMission(): DraftMission | null {
  const id = mapStore.currentScenarioId;
  if (!id || mapStore.readOnly) return null;
  return { mapId: id, title: editStore.liveDoc?.header.name || mapStore.mapName || id, mapSize: mapStore.mapSize || undefined };
}

/** The draft of what the window shows: a new campaign, or the current one. */
function loadDraft(): void {
  const c = campaign.editorMode === "edit" ? campaign.current : null;
  if (!c) {
    const first = openMapAsMission();
    draft.value = { name: trc("Новая кампания"), description: "", author: "", race: defaultRace(), heroLevel: 1, missions: first ? [first] : [] };
    checkedRace.value = null;
    return;
  }
  draft.value = {
    name: c.header.name,
    description: c.header.description,
    author: c.header.author,
    race: c.header.race && c.header.race !== "neutral" ? c.header.race : "empire",
    heroLevel: c.header.heroLevel,
    missions: c.missions.map((m, i) => ({ ...m, issues: campaign.issuesOf(i) })),
  };
  checkedRace.value = c.header.race;
}

watch(
  () => campaign.editorVisible,
  (open) => {
    if (!open) return;
    newMapName.value = "";
    picked.value = undefined;
    loadDraft();
    void mapStore.loadScenarios().catch(() => []);
  },
);

const issuesShown = (m: DraftMission): CampaignMissionIssue[] =>
  draft.value.race === checkedRace.value ? (m.issues ?? []) : [];
/** Some mission's issues are not known for this order and race: they are checked on saving. */
const pendingCheck = computed(
  () =>
    editable.value &&
    draft.value.missions.some((m) => m.mapId && (m.issues === undefined || draft.value.race !== checkedRace.value)),
);

function move(index: number, dir: -1 | 1): void {
  const list = draft.value.missions;
  const to = index + dir;
  if (to < 0 || to >= list.length) return;
  [list[index], list[to]] = [list[to]!, list[index]!];
  for (const m of list) m.issues = undefined; // the place in the order decides what a mission must have
}
function removeMission(index: number): void {
  draft.value.missions.splice(index, 1);
  for (const m of draft.value.missions) m.issues = undefined;
}

const inDraft = (id: string): boolean => draft.value.missions.some((m) => m.mapId === id);
const openMap = computed(() => openMapAsMission());
const canAddOpen = computed(() => !!openMap.value && !inDraft(openMap.value.mapId!));
function addOpen(): void {
  if (openMap.value) draft.value.missions.push(openMap.value);
}

/** Maps of the list that can become a mission (not in the campaign yet). */
const pickable = computed(() => mapStore.scenarios.filter((s) => !inDraft(s.id)));
const picked = ref<string | undefined>(undefined);
function addPicked(id: string | undefined): void {
  const s = mapStore.scenarios.find((x) => x.id === id);
  picked.value = undefined;
  if (!s || inDraft(s.id)) return;
  draft.value.missions.push({ mapId: s.id, title: s.name, mapSize: s.mapSize });
}

// a new blank map as the next mission: the campaign's race gets the player, capital and hero
const newMapName = ref("");
const newMapSize = ref(72);
const newMapBusy = ref(false);
async function addNewMap(): Promise<void> {
  newMapBusy.value = true;
  const name = newMapName.value.trim() || trc("Миссия {index}", { index: draft.value.missions.length + 1 });
  try {
    const modId = campaign.current?.mod ?? modStore.activeModId ?? undefined;
    const id = await createNewMap({ size: newMapSize.value, fill: "default", name, races: [draft.value.race], modId });
    draft.value.missions.push({ mapId: id, title: name, mapSize: newMapSize.value });
    newMapName.value = "";
    void mapStore.loadScenarios().catch(() => []);
  } catch (e) {
    ElMessage.error(tr("Карта не создана: {error}", { error: message(e) }));
  } finally {
    newMapBusy.value = false;
  }
}

const problem = computed(() => {
  const d = draft.value;
  if (!d.name.trim()) return tr("У кампании должно быть название");
  if (!d.missions.some((m) => m.mapId)) return tr("Добавьте хотя бы одну миссию");
  return null;
});
const dropped = computed(() => draft.value.missions.filter((m) => !m.mapId).length);

async function submit(): Promise<void> {
  if (problem.value) return;
  const d = draft.value;
  const input = {
    header: { name: d.name.trim(), description: d.description, author: d.author.trim(), race: d.race, heroLevel: d.heroLevel },
    missions: d.missions.flatMap((m) => (m.mapId ? [m.mapId] : [])),
  };
  try {
    if (campaign.editorMode === "create") {
      const c = await campaign.create(input);
      ElMessage.success(tr("Создана кампания «{name}»", { name: c.header.name }));
    } else {
      await campaign.save(input);
      ElMessage.success(tr("Кампания сохранена"));
    }
    campaign.editorVisible = false;
  } catch (e) {
    ElMessage.error(tr("Не удалось сохранить кампанию: {error}", { error: message(e) }));
  }
}

async function makeCopy(): Promise<void> {
  try {
    const own = await campaign.copy();
    ElMessage.success(tr("Создана ваша копия «{name}» — её можно менять", { name: own.header.name }));
    loadDraft(); // the window now edits the copy
  } catch (e) {
    ElMessage.error(tr("Копия не создана: {error}", { error: message(e) }));
  }
}

async function removeCampaign(): Promise<void> {
  const c = campaign.current;
  if (!c) return;
  try {
    await ElMessageBox.confirm(
      tr("Удалить кампанию «{name}»? Её карты останутся в списке карт.", { name: c.header.name }),
      tr("Удаление кампании"),
      { type: "warning", confirmButtonText: tr("Удалить"), cancelButtonText: tr("Отмена") },
    );
  } catch {
    return;
  }
  try {
    await campaign.remove();
    campaign.editorVisible = false;
    ElMessage.success(tr("Кампания удалена"));
  } catch (e) {
    ElMessage.error(tr("Не удалось удалить кампанию: {error}", { error: message(e) }));
  }
}
</script>

<template>
  <el-dialog v-model="campaign.openVisible" :title="tr('Открыть кампанию')" width="720px" :close-on-click-modal="true">
    <el-input v-model="search" size="small" clearable class="cd-search" :placeholder="tr('Поиск по названию или автору')" />
    <el-table
      v-loading="campaign.listLoading"
      :data="shownCampaigns"
      height="380"
      highlight-current-row
      :empty-text="tr('Кампаний нет')"
      @row-click="chooseCampaign"
    >
      <el-table-column :label="tr('Название')" min-width="220">
        <template #default="{ row }">
          <div class="cd-name">{{ row.header.name || row.fileName }}</div>
          <div v-if="row.header.author" class="cd-sub">{{ row.header.author }}</div>
        </template>
      </el-table-column>
      <el-table-column v-if="modStore.mods.length > 1" :label="tr('Мод')" min-width="110">
        <template #default="{ row }">{{ row.mod ? modStore.nameOf(row.mod) : "—" }}</template>
      </el-table-column>
      <el-table-column :label="tr('Раса')" min-width="130">
        <template #default="{ row }">{{ raceLabel(row.header.race) }}</template>
      </el-table-column>
      <el-table-column :label="tr('Миссии')" width="90">
        <template #default="{ row }">
          <span v-if="readable(row) === row.missions.length">{{ row.missions.length }}</span>
          <el-tooltip v-else :content="tr('Часть миссий в старом формате — редактор их не открывает')" placement="top">
            <span class="cd-dim">{{ tr("{readable} из {total}", { readable: readable(row), total: row.missions.length }) }}</span>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="" width="110">
        <template #default="{ row }">
          <el-tag v-if="row.id === campaign.current?.id" size="small" type="success">{{ tr("открыта") }}</el-tag>
          <el-tag v-else-if="row.source === 'own'" size="small" effect="plain">{{ tr("своя") }}</el-tag>
        </template>
      </el-table-column>
    </el-table>
    <template #footer>
      <div class="cd-footer">
        <span class="cd-hint">{{ tr("Кликните строку, чтобы открыть кампанию.") }}</span>
        <span>
          <el-button size="small" :loading="campaign.busy" @click="uploadFromList">{{ tr("Загрузить .csg…") }}</el-button>
          <el-button size="small" type="primary" @click="newFromList">{{ tr("Новая кампания…") }}</el-button>
        </span>
      </div>
    </template>
  </el-dialog>

  <el-dialog v-model="campaign.editorVisible" :title="title" width="680px" top="4vh" :close-on-click-modal="!editable">
    <el-alert v-if="isInstall" type="info" :closable="false" show-icon class="cd-alert">
      {{ tr("Сагу мода нельзя изменить. Сделайте свою копию: в ней те же карты миссий, и ваши правки этих карт сохраняются.") }}
    </el-alert>
    <el-form label-width="120px" label-position="left" size="small" :disabled="!editable">
      <el-form-item :label="tr('Название')">
        <el-input v-model="draft.name" maxlength="32" show-word-limit />
      </el-form-item>
      <el-form-item :label="tr('Автор')">
        <el-input v-model="draft.author" maxlength="32" show-word-limit />
      </el-form-item>
      <el-form-item :label="tr('Описание')">
        <el-input v-model="draft.description" type="textarea" :rows="2" maxlength="255" show-word-limit />
      </el-form-item>
      <el-form-item :label="tr('Раса')">
        <el-select v-model="draft.race" class="cd-race">
          <el-option v-for="o in raceOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <div class="cd-hint cd-below">{{ tr("Человек играет первым игроком этой расы в каждой миссии.") }}</div>
      </el-form-item>
      <el-form-item :label="tr('Уровень героя')">
        <el-input-number v-model="draft.heroLevel" :min="1" :max="99" />
        <span class="cd-hint cd-side">{{ tr("с этим уровнем герой начинает первую миссию") }}</span>
      </el-form-item>
    </el-form>

    <div class="cd-missions-head">
      <span class="cd-missions-title">{{ tr("Миссии по порядку") }}</span>
      <span v-if="pendingCheck" class="cd-hint">{{ tr("миссии проверятся при сохранении") }}</span>
    </div>
    <el-table :data="draft.missions" size="small" max-height="220" :empty-text="tr('Миссий пока нет')">
      <el-table-column type="index" width="44" />
      <el-table-column :label="tr('Миссия')" min-width="220">
        <template #default="{ row }">
          <span class="cd-name">{{ row.title }}</span>
          <span v-if="row.fileName" class="cd-sub cd-file">{{ row.fileName }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="tr('Размер')" width="80">
        <template #default="{ row }">{{ row.mapSize ? `${row.mapSize}×${row.mapSize}` : "" }}</template>
      </el-table-column>
      <el-table-column label="" width="44">
        <template #default="{ row }">
          <el-tooltip v-if="issuesShown(row).length" :content="issuesShown(row).map(issueText).join(' ')" placement="top">
            <el-icon class="cd-warn"><WarningFilled /></el-icon>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column v-if="editable" label="" width="112">
        <template #default="{ $index }">
          <span class="cd-row-actions">
            <el-button size="small" text :icon="ArrowUp" :disabled="$index === 0" :title="tr('Выше')" @click="move($index, -1)" />
            <el-button size="small" text :icon="ArrowDown" :disabled="$index === draft.missions.length - 1" :title="tr('Ниже')" @click="move($index, 1)" />
            <el-button size="small" text :icon="Delete" :title="tr('Убрать из кампании (карта останется)')" @click="removeMission($index)" />
          </span>
        </template>
      </el-table-column>
    </el-table>
    <div v-if="dropped && editable" class="cd-hint cd-below">
      {{ tr("Миссии, которые редактор не открывает, при сохранении уйдут из кампании.") }}
    </div>

    <div v-if="editable" class="cd-add">
      <el-button size="small" :disabled="!canAddOpen" @click="addOpen">{{ tr("Добавить открытую карту") }}</el-button>
      <el-select
        v-model="picked"
        size="small"
        filterable
        class="cd-pick"
        :placeholder="tr('Добавить карту из списка…')"
        @change="addPicked"
      >
        <el-option v-for="s in pickable" :key="s.id" :value="s.id" :label="s.campaign ? `${s.name} — ${s.campaign}` : s.name" />
      </el-select>
    </div>
    <div v-if="editable" class="cd-add">
      <el-input v-model="newMapName" size="small" class="cd-newname" maxlength="64" :placeholder="tr('Название новой карты')" />
      <el-select v-model="newMapSize" size="small" class="cd-size">
        <el-option v-for="s in [48, 72, 96, 120, 144]" :key="s" :label="`${s} × ${s}`" :value="s" />
      </el-select>
      <el-button size="small" :loading="newMapBusy" @click="addNewMap">{{ tr("Новая карта миссией") }}</el-button>
    </div>

    <template #footer>
      <div class="cd-footer">
        <span>
          <el-button
            v-if="campaign.editorMode === 'edit' && campaign.current?.editable"
            size="small"
            type="danger"
            plain
            @click="removeCampaign"
          >{{ tr("Удалить кампанию") }}</el-button>
          <span v-if="problem && editable" class="cd-problem">{{ problem }}</span>
        </span>
        <span>
          <el-button size="small" @click="campaign.editorVisible = false">{{ editable ? tr("Отмена") : tr("Закрыть") }}</el-button>
          <el-button v-if="!editable" size="small" type="primary" :loading="campaign.busy" @click="makeCopy">
            {{ tr("Сделать свою копию") }}
          </el-button>
          <el-button
            v-else
            size="small"
            type="primary"
            :loading="campaign.busy"
            :disabled="!!problem"
            @click="submit"
          >{{ campaign.editorMode === "create" ? tr("Создать") : tr("Сохранить") }}</el-button>
        </span>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.cd-search {
  margin-bottom: 8px;
}
.cd-name {
  font-weight: 500;
}
.cd-sub {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.cd-file {
  margin-left: 6px;
}
.cd-dim {
  color: var(--el-text-color-secondary);
  cursor: help;
}
.cd-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.cd-below {
  display: block;
  width: 100%;
  margin-top: 2px;
  line-height: 1.4;
}
.cd-side {
  margin-left: 10px;
}
.cd-race {
  width: 220px;
}
.cd-alert {
  margin-bottom: 12px;
}
.cd-missions-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 4px 0 6px;
}
.cd-missions-title {
  font-weight: 600;
  font-size: 13px;
}
.cd-warn {
  color: var(--el-color-warning);
  cursor: help;
}
.cd-row-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
.cd-row-actions :deep(.el-button) {
  padding: 4px;
}
.cd-row-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.cd-add {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.cd-pick {
  flex: 1;
}
.cd-newname {
  flex: 1;
}
.cd-size {
  width: 110px;
}
.cd-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.cd-problem {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-color-danger);
}
</style>
