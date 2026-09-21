<script setup lang="ts">
// Browser-only fixture. Not imported by the app or shipped in the production bundle.
import { onMounted, reactive, ref } from 'vue';
import GarrisonEditor from '../src/layout/GarrisonEditor.vue';
import { useUnitStore, type UnitEntry } from '../src/stores/unitStore';

const units = useUnitStore();
const ready = ref(false);
type Member = { unit: string; level: number; hp: number; key?: string; modifiers?: string[] };
const state = reactive({
  garrison: Array<Member | null>(6).fill(null),
  army: Array<Member | null>(6).fill(null),
  visitor: Array<Member | null>(6).fill(null),
  template: Array<Member | null>(6).fill(null),
  groupId: 'first', disabled: false, leaderCell: 0, templateLeader: -1,
  emitted: [] as { kind: string; cell: number; value?: unknown }[],
});
const makeMember = (u: UnitEntry): Member => ({ unit: u.id, level: u.level, hp: u.hp });
onMounted(async () => {
  await units.load();
  if (units.error) throw new Error(units.error);
  const soldier = units.all.find(u => /Ашган/.test(u.name))!;
  const leader = units.all.find(u => /Рыцарь Смерти/.test(u.name) && units.isLeaderCategory(u.id))!;
  const large = units.all.find(u => u.large && u.catKey === 'L_SOLDIER')!;
  state.garrison[2] = makeMember(soldier);
  state.army[0] = makeMember(leader);
  state.army[2] = { ...makeMember(large), key: 'big' };
  state.army[3] = { ...makeMember(large), key: 'big' };
  state.visitor[2] = makeMember(leader);
  (window as any).__formationTest = { state, ids: { soldier: soldier.id, leader: leader.id, large: large.id } };
  ready.value = true;
});
function setUnit(group: 'garrison' | 'army' | 'template', cell: number, id: string) {
  state.emitted.push({ kind: 'setUnit', cell, value: id });
  const member = makeMember(units.get(id)!);
  if (units.isLarge(id)) {
    const front = cell & ~1;
    state[group][front] = { ...member, key: 'new-big' };
    state[group][front + 1] = { ...member, key: 'new-big' };
  } else state[group][cell] = member;
  if (group === 'template' && units.isLeaderCategory(id)) state.templateLeader = cell;
}
function stat(cell: number, key: 'level' | 'hp', value: number) {
  state.emitted.push({ kind: key, cell, value });
  if (state.garrison[cell]) state.garrison[cell]![key] = value;
}
</script>
<template>
  <main v-if="ready" class="fixture">
    <h1>Формация и свойства юнита</h1>
    <div class="fixture-grid">
      <section id="defense" class="fixture-panel">
        <h2>Оборона города</h2><p class="fixture-meta">Редактирование · 300 px</p>
        <el-form :disabled="state.disabled">
          <GarrisonEditor :key="state.groupId" :garrison="state.garrison" :count="state.garrison.filter(Boolean).length" roster="soldiers"
            @set-unit="(cell, id) => setUnit('garrison', cell, id)" @set-stat="stat"
            @clear="cell => { state.emitted.push({ kind: 'clear', cell }); state.garrison[cell] = null; }"
            @set-mods="(cell, value) => state.emitted.push({ kind: 'mods', cell, value })" />
        </el-form>
      </section>
      <section id="army" class="fixture-panel">
        <h2>Отряд</h2><p class="fixture-meta">Лидер и большой юнит</p>
        <GarrisonEditor :garrison="state.army" :count="3" :leader-cell="state.leaderCell"
          @set-unit="(cell, id) => setUnit('army', cell, id)"
          @set-stat="(cell, key, value) => state.emitted.push({ kind: key, cell, value })" />
      </section>
      <section id="visitor" class="fixture-panel">
        <h2>Гость столицы</h2><p class="fixture-meta">Только просмотр</p>
        <GarrisonEditor :garrison="state.visitor" :count="1" :leader-cell="2" readonly
          @set-unit="(cell, value) => state.emitted.push({ kind: 'unexpected', cell, value })" />
      </section>
      <section id="template" class="fixture-panel">
        <h2>Шаблон отряда</h2><p class="fixture-meta">Общий компонент · без HP</p>
        <GarrisonEditor :garrison="state.template" :count="state.template.filter(Boolean).length" :leader-cell="state.templateLeader" hide-hp
          @set-unit="(cell, id) => setUnit('template', cell, id)"
          @set-stat="(cell, key, value) => state.emitted.push({ kind: key, cell, value })" />
      </section>
    </div>
  </main>
</template>
<style>
body { margin: 0; background: var(--el-bg-color-page); }
.fixture { padding: 28px; color: var(--el-text-color-primary); }
.fixture h1 { font-size: 20px; margin: 0 0 24px; font-weight: 500; }
.fixture-grid { display: grid; grid-template-columns: repeat(4, 300px); gap: 16px; align-items: start; }
.fixture-panel { background: var(--el-bg-color); border: 1px solid var(--el-border-color-lighter); padding: 14px; border-radius: 10px; min-width: 0; }
.fixture h2 { font-size: 13px; font-weight: 600; margin: 0 0 4px; }
.fixture-meta { font-size: 11px; color: var(--el-text-color-secondary); margin: 0 0 18px; }
</style>
