<script setup lang="ts">
/**
 * Options of the «Туман» tool, floating at the top-left of the canvas while the tool is
 * active: whose fog is on the map, what the brush does, its size — and «Игроки», the table
 * that sets every player's fog in one step (hidden, open, around what the player owns, the
 * same as another player's). The table also says what an unset fog means: it is easy to
 * leave one side with the whole map open without noticing.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { ElSegmented, ElSelect, ElOption, ElButton, ElPopover, ElInputNumber, ElDropdown, ElDropdownMenu, ElDropdownItem, ElMessage } from "element-plus";
import { InfoFilled, EditPen, ArrowDown } from "@element-plus/icons-vue";
import { useToolStore } from "../stores/toolStore";
import { useFogStore, type FogBrush, type FogPlayer, type FogPreset } from "../stores/fogStore";
import { useEditStore } from "../stores/editStore";
import { tr, trn, trx, intlLocale } from "../i18n";

const toolStore = useToolStore();
const fogStore = useFogStore();
const editStore = useEditStore();
const { tool, size } = storeToRefs(toolStore);
const { players, playerId, brush, hiddenCells, totalCells, aroundRadius } = storeToRefs(fogStore);

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
const UNSET_NOTE = tr(
  "«Не задан» — в файле у игрока открыты все клетки: так выглядит новая карта. Там, где туман берут из файла, такой игрок видит всю карту с первого хода. Если туман для карты важен, задайте его каждой стороне.",
);

const visible = computed(() => tool.value === "fog");
const readOnly = computed(() => editStore.readOnly);
const num = (n: number): string => n.toLocaleString(intlLocale());
const counter = computed(() =>
  trn("скрыта {n} клетка из {total}|скрыто {n} клетки из {total}|скрыто {n} клеток из {total}", hiddenCells.value, {
    n: num(hiddenCells.value),
    total: num(totalCells.value),
  }),
);
const sides = computed(() => players.value.filter((p) => !p.neutral));
const unsetSides = computed(() => sides.value.filter((p) => p.state === "unset").length);

function stateText(p: FogPlayer): string {
  if (p.state === "unset") return tr("не задан");
  if (p.state === "hidden") return tr("вся карта скрыта");
  return tr("открыто {open} из {total}", { open: num(totalCells.value - p.hidden), total: num(totalCells.value) });
}

function onBrush(v: string | number | boolean): void {
  fogStore.setBrush(v as FogBrush);
}
function preset(p: FogPlayer, kind: FogPreset): void {
  if (!fogStore.applyPreset(p.id, kind)) ElMessage.info(tr("Туман игрока «{name}» уже такой", { name: p.name }));
}
function presetAll(kind: FogPreset): void {
  if (!fogStore.applyPresetToAll(kind)) ElMessage.info(tr("Туман всех сторон уже такой"));
}
function copyFrom(to: FogPlayer, fromId: string): void {
  if (!fogStore.copyFog(fromId, to.id)) ElMessage.info(tr("Туман игрока «{name}» уже такой", { name: to.name }));
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

      <el-popover placement="bottom-start" trigger="click" :width="620" popper-class="fog-pop">
        <template #reference>
          <el-button size="small" :type="unsetSides ? 'warning' : ''" plain>
            {{ tr("Игроки") }}<span v-if="unsetSides" class="fog-badge">{{ unsetSides }}</span>
            <el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
        </template>
        <div class="fog-table">
          <div class="fog-thead">{{ tr("Туман каждой стороны") }}</div>
          <div v-for="p in players" :key="p.id" class="fog-trow" :class="{ current: p.id === playerId }">
            <span class="fog-who">
              <span class="fog-dot" :style="{ background: p.color || 'var(--el-text-color-placeholder)' }" />{{ p.name }}
            </span>
            <span class="fog-state" :class="{ unset: p.state === 'unset' && !p.neutral }">{{ stateText(p) }}</span>
            <span class="fog-acts">
              <el-button size="small" text :disabled="readOnly" @click="preset(p, 'hide')">{{ trx("fog", "Скрыть") }}</el-button>
              <el-button size="small" text :disabled="readOnly" @click="preset(p, 'around')">{{ tr("Вокруг своих") }}</el-button>
              <el-button size="small" text :disabled="readOnly" @click="preset(p, 'open')">{{ trx("fog", "Открыть") }}</el-button>
              <el-dropdown v-if="players.length > 1" trigger="click" :disabled="readOnly" @command="(from: string) => copyFrom(p, from)">
                <el-button size="small" text :disabled="readOnly">{{ tr("Как у…") }}</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item v-for="q in players.filter((x) => x.id !== p.id)" :key="q.id" :command="q.id">{{ q.name }}</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button size="small" text :icon="EditPen" :title="tr('Показать и рисовать туман этого игрока')" @click="fogStore.setPlayer(p.id)" />
            </span>
          </div>
          <div class="fog-tfoot">
            <span class="fog-flabel">{{ tr("«Вокруг своих» — на сколько клеток от городов и отрядов") }}</span>
            <el-input-number :model-value="aroundRadius" :min="0" :max="24" size="small" controls-position="right" class="fog-radius" @change="(v: number | undefined) => fogStore.setAroundRadius(v ?? 0)" />
            <span class="fog-spring" />
            <el-button size="small" :disabled="readOnly" @click="presetAll('around')">{{ tr("Всем сторонам: вокруг своих") }}</el-button>
            <el-button size="small" :disabled="readOnly" @click="presetAll('open')">{{ tr("Всем: не задан") }}</el-button>
          </div>
          <div class="fog-note">{{ UNSET_NOTE }}</div>
          <div class="fog-note">{{ GAME_NOTE }}</div>
        </div>
      </el-popover>

      <span class="fog-count">{{ counter }}</span>
    </template>
    <span v-else class="fog-count">{{ tr("В этой карте нет блоков тумана") }}</span>
    <el-icon class="fog-info" :title="GAME_NOTE"><InfoFilled /></el-icon>
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
.fog-badge {
  display: inline-block;
  min-width: 16px;
  margin-left: 6px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--el-color-warning);
  color: #1a1a1a;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
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
.fog-thead {
  margin-bottom: 6px;
  font-weight: 600;
}
.fog-trow {
  display: grid;
  grid-template-columns: minmax(110px, 1fr) minmax(130px, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 6px;
}
.fog-trow.current {
  background: var(--el-fill-color-light);
}
.fog-who {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fog-state {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.fog-state.unset {
  color: var(--el-color-warning);
}
.fog-acts {
  display: flex;
  align-items: center;
  white-space: nowrap;
}
.fog-acts .el-button {
  margin-left: 0;
  padding: 4px 6px;
}
.fog-tfoot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.fog-tfoot .el-button + .el-button {
  margin-left: 0;
}
.fog-flabel {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.fog-radius {
  width: 84px;
}
.fog-spring {
  flex: 1;
}
.fog-note {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--el-text-color-secondary);
}
</style>
