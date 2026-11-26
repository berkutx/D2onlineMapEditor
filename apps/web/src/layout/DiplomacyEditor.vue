<script setup lang="ts">
/** MidDiplomacy pairs use race categories; edits replace only packed meter bits. */
import { computed, onMounted } from "vue";
import { ElSelect, ElOption, ElInputNumber, ElEmpty } from "element-plus";
import { diplomacyRaceCategory, readDiplomacyRelation } from "@d2/map-edit";
import { useEventStore } from "../stores/eventStore";
import { useEditStore } from "../stores/editStore";
import { useModStore } from "../stores/modStore";
import { tr, trn } from "../i18n";

const store = useEventStore();
const edit = useEditStore();
// which diplomacy row a player belongs to is a fact of the map's mod (its Grace table)
const mods = useModStore();
onMounted(() => void mods.loadProfile());
const players = computed(() => edit.liveDoc?.players ?? []);
interface Pair {
  key: string; aName: string; bName: string; aColor?: string; bColor?: string;
  race1: number | null; race2: number | null; relation: number; alwaysWar: boolean;
}
const pairs = computed<Pair[]>(() => {
  const ps = players.value, out: Pair[] = [];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const a = ps[i]!, b = ps[j]!;
    const cats = mods.raceCategoryById;
    const race1 = diplomacyRaceCategory(a, cats), race2 = diplomacyRaceCategory(b, cats);
    const state = race1 === null || race2 === null ? null : readDiplomacyRelation(store.diplomacy, race1, race2);
    out.push({ key: a.id + ':' + b.id, aName: a.name || tr("Игрок {n}", { n: a.playerNo }), bName: b.name || tr("Игрок {n}", { n: b.playerNo }),
      aColor: a.color, bColor: b.color, race1, race2, relation: state?.current ?? 0, alwaysWar: state?.alwaysWar ?? false });
  }
  return out;
});
const PRESETS = [{ value: 100, label: tr("Мир") }, { value: 49, label: tr("Нейтралитет") }, { value: 0, label: tr("Война") }];
function set(p: Pair, relation: unknown): void {
  if (p.alwaysWar || p.race1 === null || p.race2 === null || typeof relation !== 'number' || !Number.isInteger(relation) || relation < 0 || relation > 100) return;
  store.setDiplomacyRelation(p.race1, p.race2, relation);
}
</script>

<template>
  <div class="dp">
    <div class="dp-head"><span class="dp-sub">{{ trn("{n} игрок|{n} игрока|{n} игроков", players.length) }}</span></div>
    <div class="dp-body">
      <el-empty v-if="pairs.length === 0" :description="tr('Нужно ≥ 2 игроков')" :image-size="60" />
      <div v-for="p in pairs" :key="p.key" class="dp-entry">
        <div class="dp-row">
          <span class="dp-pair">
            <i v-if="p.aColor" class="dp-dot" :style="{ background: p.aColor }" />{{ p.aName }}
            <span class="dp-vs">↔</span>
            <i v-if="p.bColor" class="dp-dot" :style="{ background: p.bColor }" />{{ p.bName }}
          </span>
          <template v-if="p.race1 !== null && p.race2 !== null">
            <el-select :model-value="p.relation" :disabled="p.alwaysWar" size="small" style="width: 130px"
              :aria-label="tr('Отношение: {a} — {b}', { a: p.aName, b: p.bName })" @update:model-value="set(p, $event)">
              <el-option v-for="o in PRESETS" :key="o.value" :value="o.value" :label="o.label" />
              <el-option v-if="!PRESETS.some(x => x.value === p.relation)" :value="p.relation" :label="`${p.relation}`" />
            </el-select>
            <el-input-number v-if="p.relation <= 100" :model-value="p.relation" :disabled="p.alwaysWar" :min="0" :max="100" size="small" controls-position="right"
              :aria-label="tr('Значение отношения: {a} — {b}', { a: p.aName, b: p.bName })" style="width: 92px" @update:model-value="set(p, $event)" />
            <span v-else class="dp-source-value" :title="tr('Исходное значение сохранено. Новое значение выбирается в диапазоне 0–100.')">{{ tr("{value} (из файла)", { value: p.relation }) }}</span>
          </template>
        </div>
        <p v-if="p.race1 === null || p.race2 === null" class="dp-lock">{{ tr("Раса не распознана: изменение отношений недоступно.") }}</p>
        <p v-else-if="p.alwaysWar" class="dp-lock">{{ tr("Вечная война: изменение отношения запрещено условиями карты.") }}</p>
      </div>
    </div>
    <p class="dp-hint">{{ tr("0 = война, 49 = нейтралитет, 100 = мир. Отношения хранятся по расам игроков.") }}</p>
  </div>
</template>

<style scoped>
.dp { display: flex; flex-direction: column; height: 100%; font-size: 12px; }
.dp-head { display: flex; align-items: baseline; gap: 8px; padding: 10px 12px 4px; }
.dp-sub { color: var(--el-text-color-secondary); font-size: 11px; }
.dp-body { flex: 1; overflow-y: auto; padding: 0 12px; max-width: 540px; }
.dp-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: baseline; }
.dp-entry { margin: 6px 0; }
.dp-row { display: flex; align-items: center; gap: 6px; }
.dp-pair { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dp-vs { color: var(--el-text-color-secondary); margin: 0 3px; }
.dp-lock { color: var(--el-text-color-secondary); margin: 3px 0 7px; font-size: 11px; }
.dp-hint { color: var(--el-text-color-secondary); font-size: 11px; padding: 8px 12px; margin: 0; }
</style>
