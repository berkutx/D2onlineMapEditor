<script setup lang="ts">
/**
 * Options of the «Туман» tool, floating at the top-left of the canvas while the tool is
 * active: whose fog, what the brush does, its size, and the two whole-map actions.
 * The (i) says what the game does with a drawn fog — it is easy to expect more of it.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { ElSegmented, ElSelect, ElOption, ElButton, ElTooltip, ElMessage } from "element-plus";
import { InfoFilled } from "@element-plus/icons-vue";
import { useToolStore } from "../stores/toolStore";
import { useFogStore, type FogBrush } from "../stores/fogStore";
import { useEditStore } from "../stores/editStore";
import { tr, trn, intlLocale } from "../i18n";

const toolStore = useToolStore();
const fogStore = useFogStore();
const editStore = useEditStore();
const { tool, size } = storeToRefs(toolStore);
const { players, playerId, brush, hiddenCells, totalCells } = storeToRefs(fogStore);

const BRUSHES: { label: string; value: FogBrush }[] = [
  { label: tr("Открывать"), value: "open" },
  { label: tr("Скрывать"), value: "hide" },
];
const SIZES = [
  { label: "1×1", value: 1 },
  { label: "3×3", value: 3 },
  { label: "5×5", value: 5 },
  { label: "9×9", value: 9 },
];
const GAME_NOTE = tr(
  "Туман хранится в файле карты отдельно для каждого игрока. При старте новой партии игра пересчитывает его сама: скрывает всю карту и открывает вокруг городов и отрядов игрока, поэтому нарисованное здесь действует только там, где туман не пересчитывают, — в сохранённой игре или в движке, который его учитывает. Чтобы открыть область на старте в оригинальной игре, используйте эффект события «Туман войны в зоне».",
);

const visible = computed(() => tool.value === "fog");
const readOnly = computed(() => editStore.readOnly);
const counter = computed(() =>
  trn("скрыта {n} клетка из {total}|скрыто {n} клетки из {total}|скрыто {n} клеток из {total}", hiddenCells.value, {
    n: hiddenCells.value.toLocaleString(intlLocale()),
    total: totalCells.value.toLocaleString(intlLocale()),
  }),
);

function onBrush(v: string | number | boolean): void {
  fogStore.setBrush(v as FogBrush);
}
function fill(hidden: boolean): void {
  if (!fogStore.fill(hidden)) ElMessage.info(hidden ? tr("Вся карта уже скрыта") : tr("Вся карта уже открыта"));
}
</script>

<template>
  <div v-if="visible" class="fog-bar d2-float">
    <template v-if="players.length">
      <el-select
        :model-value="playerId ?? ''"
        size="small"
        class="fog-player"
        :title="tr('Чей туман показан и редактируется')"
        @change="fogStore.setPlayer($event)"
      >
        <el-option v-for="p in players" :key="p.id" :value="p.id" :label="p.name">
          <span class="fog-dot" :style="{ background: p.color || 'var(--el-text-color-placeholder)' }" />
          {{ p.name }}
        </el-option>
      </el-select>
      <el-segmented :model-value="brush" :options="BRUSHES" size="small" :disabled="readOnly" @change="onBrush" />
      <el-segmented v-model="size" :options="SIZES" size="small" />
      <el-button size="small" :disabled="readOnly" @click="fill(true)">{{ tr("Скрыть всё") }}</el-button>
      <el-button size="small" :disabled="readOnly" @click="fill(false)">{{ tr("Открыть всё") }}</el-button>
      <span class="fog-count">{{ counter }}</span>
    </template>
    <span v-else class="fog-count">{{ tr("В этой карте нет блоков тумана") }}</span>
    <el-tooltip placement="bottom" :show-after="150">
      <template #content>
        <div class="fog-note">{{ GAME_NOTE }}</div>
      </template>
      <el-icon class="fog-info"><InfoFilled /></el-icon>
    </el-tooltip>
  </div>
</template>

<style scoped>
.fog-bar {
  position: absolute;
  top: var(--d2-sp-2);
  left: var(--d2-sp-2);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: var(--d2-sp-2);
  padding: var(--d2-sp-1) var(--d2-sp-2);
}
.fog-bar .el-button + .el-button {
  margin-left: 0;
}
.fog-player {
  width: 150px;
}
.fog-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 6px;
  border-radius: 50%;
  vertical-align: middle;
}
.fog-count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.fog-info {
  color: var(--el-color-warning);
  cursor: help;
}
.fog-note {
  max-width: 380px;
  line-height: 1.45;
}
</style>
