<script setup lang="ts">
/** Diplomacy editor: the relation between each pair of the scenario's players (by their race).
 *  MidDiplomacy stores race-vs-race entries; the relation is the 0..100 meter (presets
 *  Мир=100 / Нейтралитет=49 / Война=0), high-bit flags preserved. Each change commits a whole
 *  setDiplomacy op (one block). */
import { computed } from "vue";
import { ElSelect, ElOption, ElInputNumber, ElEmpty } from "element-plus";
import { useEventStore } from "../stores/eventStore";
import { useEditStore } from "../stores/editStore";

const store = useEventStore();
const edit = useEditStore();

const players = computed(() => edit.liveDoc?.players ?? []);

interface Pair { aName: string; bName: string; race1: number; race2: number; relation: number }

const relationOf = (r1: number, r2: number): number => {
  const [x, y] = r1 <= r2 ? [r1, r2] : [r2, r1];
  const e = store.diplomacy.find((d) => {
    const [a, b] = d.race1 <= d.race2 ? [d.race1, d.race2] : [d.race2, d.race1];
    return a === x && b === y;
  });
  return e?.relation ?? 49; // default neutral if unset
};

const pairs = computed<Pair[]>(() => {
  const ps = players.value;
  const out: Pair[] = [];
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      out.push({
        aName: ps[i]!.name || `Игрок ${ps[i]!.playerNo}`,
        bName: ps[j]!.name || `Игрок ${ps[j]!.playerNo}`,
        race1: ps[i]!.race, race2: ps[j]!.race,
        relation: relationOf(ps[i]!.race, ps[j]!.race),
      });
    }
  }
  return out;
});

const PRESETS = [
  { value: 100, label: "Мир" }, { value: 49, label: "Нейтралитет" }, { value: 0, label: "Война" },
];
function set(p: Pair, relation: number): void {
  store.setDiplomacyRelation(p.race1, p.race2, relation);
}
</script>

<template>
  <div class="dp">
    <div class="dp-head"><strong>Дипломатия</strong><span class="dp-sub">{{ players.length }} игрок(ов)</span></div>
    <div class="dp-body">
      <el-empty v-if="pairs.length === 0" description="Нужно ≥ 2 игроков" :image-size="60" />
      <div v-for="p in pairs" :key="p.race1 + '-' + p.race2" class="dp-row">
        <span class="dp-pair">{{ p.aName }} <span class="dp-vs">↔</span> {{ p.bName }}</span>
        <el-select :model-value="p.relation" size="small" style="width: 130px"
          @update:model-value="set(p, $event)">
          <el-option v-for="o in PRESETS" :key="o.value" :value="o.value" :label="o.label" />
          <el-option v-if="!PRESETS.some(x => x.value === p.relation)" :value="p.relation" :label="`${p.relation}`" />
        </el-select>
        <el-input-number :model-value="p.relation" :min="0" :max="100" size="small" controls-position="right"
          style="width: 92px" @update:model-value="set(p, ($event as number) ?? 49)" />
      </div>
    </div>
    <p class="dp-hint">0 = война, 49 = нейтралитет, 100 = мир. Отношения хранятся по расам игроков.</p>
  </div>
</template>

<style scoped>
.dp { display: flex; flex-direction: column; height: 100%; }
.dp-head { display: flex; align-items: baseline; gap: 8px; padding: 8px 10px; }
.dp-head strong { font-weight: 600; }
.dp-sub { color: var(--el-text-color-secondary); font-size: 11px; }
.dp-body { flex: 1; overflow-y: auto; padding: 0 10px; }
.dp-row { display: flex; align-items: center; gap: 6px; margin: 5px 0; }
.dp-pair { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dp-vs { color: var(--el-text-color-secondary); margin: 0 3px; }
.dp-hint { color: var(--el-text-color-secondary); font-size: 11px; padding: 8px 10px; margin: 0; }
</style>
