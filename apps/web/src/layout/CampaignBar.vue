<script setup lang="ts">
/**
 * The campaign strip under the menu bar while a campaign is open: what it is, the mission
 * switcher (◀ missions ▶), what would break the open mission in the game, and the campaign's
 * actions — add the open map, the campaign window, export, close.
 */
import { computed } from "vue";
import { ArrowLeft, ArrowRight, Close, WarningFilled } from "@element-plus/icons-vue";
import { useCampaignStore, issueText } from "../stores/campaignStore";
import { useMapStore } from "../stores/mapStore";
import { useModStore } from "../stores/modStore";
import { useCampaignActions, raceLabel } from "../composables/campaignActions";
import { tr } from "../i18n";

const campaign = useCampaignStore();
const mapStore = useMapStore();
const modStore = useModStore();
const actions = useCampaignActions();

const c = computed(() => campaign.current);
const index = computed(() => campaign.missionIndex);
const issues = computed(() => (index.value >= 0 ? campaign.issuesOf(index.value) : []));
const issueHint = computed(() => issues.value.map(issueText).join(" "));
const issueShort = computed(() => {
  if (issues.value.includes("no-seat")) return tr("нет игрока расы кампании");
  if (issues.value.includes("no-capital-stack")) return tr("нет отряда в столице");
  return tr("миссия не читается");
});
const modName = computed(() => (modStore.mods.length > 1 && c.value?.mod ? modStore.nameOf(c.value.mod) : ""));
const canAdd = computed(
  () => index.value < 0 && !!c.value?.editable && !!mapStore.currentScenarioId && (c.value?.missions.length ?? 0) < 64,
);
</script>

<template>
  <div v-if="c" class="campaign-bar">
    <el-tag size="small" :type="c.source === 'install' ? 'info' : 'success'" effect="plain" round>
      {{ c.source === "install" ? tr("Сага мода") : tr("Своя кампания") }}
    </el-tag>
    <span class="cb-name" :title="c.header.description || c.header.name">{{ c.header.name }}</span>
    <span class="cb-meta">
      {{ raceLabel(c.header.race) }} · {{ tr("герой {level} ур.", { level: c.header.heroLevel }) }}<template v-if="modName"> · {{ modName }}</template>
    </span>

    <span class="cb-nav">
      <el-tooltip :content="tr('Предыдущая миссия')" placement="bottom" :show-after="300">
        <el-button size="small" :icon="ArrowLeft" :disabled="campaign.neighbour(-1) < 0" @click="actions.step(-1)" />
      </el-tooltip>
      <el-select
        class="cb-missions"
        size="small"
        :model-value="index >= 0 ? index : undefined"
        :placeholder="tr('Эта карта не из кампании')"
        @change="(i: number) => actions.openMission(i)"
      >
        <el-option
          v-for="(m, i) in c.missions"
          :key="i"
          :value="i"
          :label="`${i + 1}. ${m.title}`"
          :disabled="!m.mapId"
        >
          <span class="cb-opt">
            <span class="cb-opt-title">{{ i + 1 }}. {{ m.title }}</span>
            <span v-if="campaign.issuesOf(i).length" class="cb-warn" :title="campaign.issuesOf(i).map(issueText).join(' ')">⚠</span>
            <span v-if="m.mapSize" class="cb-size">{{ m.mapSize }}×{{ m.mapSize }}</span>
          </span>
        </el-option>
      </el-select>
      <el-tooltip :content="tr('Следующая миссия')" placement="bottom" :show-after="300">
        <el-button size="small" :icon="ArrowRight" :disabled="campaign.neighbour(1) < 0" @click="actions.step(1)" />
      </el-tooltip>
      <span v-if="index >= 0" class="cb-count">{{ tr("миссия {index} из {total}", { index: index + 1, total: c.missions.length }) }}</span>
    </span>

    <el-tooltip v-if="issues.length" :content="issueHint" placement="bottom">
      <span class="cb-issue"><el-icon><WarningFilled /></el-icon>{{ issueShort }}</span>
    </el-tooltip>

    <span class="cb-spacer" />

    <el-button v-if="canAdd" size="small" @click="actions.addMission(mapStore.currentScenarioId!)">
      {{ tr("Добавить эту карту") }}
    </el-button>
    <el-button size="small" @click="campaign.showEditor('edit')">
      {{ c.editable ? tr("Изменить…") : tr("Свойства…") }}
    </el-button>
    <el-button size="small" type="primary" plain :loading="campaign.busy" @click="actions.exportCsg()">
      {{ tr("Экспорт .csg") }}
    </el-button>
    <el-tooltip :content="tr('Закрыть кампанию (карты остаются)')" placement="bottom" :show-after="300">
      <el-button class="cb-close" size="small" text :icon="Close" @click="campaign.close()" />
    </el-tooltip>
  </div>
</template>

<style scoped>
.campaign-bar {
  display: flex;
  align-items: center;
  gap: var(--d2-sp-2);
  height: 34px;
  padding: 0 var(--d2-sp-3);
  background: var(--el-fill-color-lighter);
  border-bottom: var(--d2-hairline);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
}
.cb-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}
.cb-meta {
  color: var(--el-text-color-secondary);
}
.cb-nav {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: var(--d2-sp-2);
}
.cb-nav :deep(.el-button + .el-button) {
  margin-left: 0;
}
.cb-missions {
  width: 240px;
}
.cb-count {
  margin-left: 4px;
  color: var(--el-text-color-secondary);
}
.cb-opt {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cb-opt-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cb-warn {
  color: var(--el-color-warning);
}
.cb-size {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.cb-issue {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--el-color-warning);
  cursor: help;
}
.cb-spacer {
  flex: 1;
}
.cb-close {
  opacity: 0.7;
}
.cb-close:hover {
  opacity: 1;
}
</style>
