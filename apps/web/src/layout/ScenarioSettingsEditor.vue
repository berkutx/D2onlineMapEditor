<script setup lang="ts">
/** Scenario settings (ScenarioInfo): name / author / description, the objective + story +
 *  victory + defeat texts, difficulty, suggested level, and the MAX_* limits. Each field
 *  commits a partial setScenarioInfo op (undoable + collab). Name/desc/author also sync into
 *  the file header on export (handled in the writer). */
import { computed } from "vue";
import { ElInput, ElInputNumber, ElSelect, ElOption } from "element-plus";
import { useEventStore } from "../stores/eventStore";

const store = useEventStore();
const h = computed(() => store.header);

function set(fields: Record<string, unknown>): void {
  store.setScenarioInfo(fields);
}
function setLimit(key: "unit" | "spell" | "leader" | "city", v: number): void {
  const cur = h.value?.limits ?? { unit: 0, spell: 0, leader: 0, city: 0 };
  set({ limits: { ...cur, [key]: v } });
}
const DIFF = [
  { value: 0, label: "Легко" }, { value: 1, label: "Средне" },
  { value: 2, label: "Сложно" }, { value: 3, label: "Очень сложно" },
];
</script>

<template>
  <div v-if="h" class="ss">
    <div class="ss-head"><strong>Настройки сценария</strong></div>
    <div class="ss-body">
      <label class="ss-f"><span>Название</span>
        <el-input :model-value="h.name" size="small" @update:model-value="set({ name: $event })" /></label>
      <label class="ss-f"><span>Автор</span>
        <el-input :model-value="h.author" size="small" maxlength="21" @update:model-value="set({ author: $event })" /></label>
      <label class="ss-f col"><span>Описание</span>
        <el-input :model-value="h.description" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" size="small"
          @update:model-value="set({ description: $event })" /></label>

      <label class="ss-f col"><span>Цель (кратко)</span>
        <el-input :model-value="h.objective ?? ''" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" size="small"
          @update:model-value="set({ objective: $event })" /></label>
      <label class="ss-f col"><span>Вступление / сюжет</span>
        <el-input :model-value="h.story ?? ''" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" size="small"
          @update:model-value="set({ story: $event })" /></label>
      <label class="ss-f col"><span>Текст победы</span>
        <el-input :model-value="h.winText ?? ''" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" size="small"
          @update:model-value="set({ winText: $event })" /></label>
      <label class="ss-f col"><span>Текст поражения</span>
        <el-input :model-value="h.loseText ?? ''" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" size="small"
          @update:model-value="set({ loseText: $event })" /></label>

      <div class="ss-sec">Сложность и уровни</div>
      <label class="ss-f"><span>Сложность сценария</span>
        <el-select :model-value="h.difficulty?.scenario ?? 3" size="small" style="width: 150px"
          @update:model-value="set({ difficulty: { scenario: $event, game: h.difficulty?.game ?? 1 } })">
          <el-option v-for="d in DIFF" :key="d.value" :value="d.value" :label="d.label" /></el-select></label>
      <label class="ss-f"><span>Рекоменд. уровень</span>
        <el-input-number :model-value="h.suggestedLevel ?? 1" :min="1" :max="99" size="small" controls-position="right"
          style="width: 110px" @update:model-value="set({ suggestedLevel: ($event as number) ?? 1 })" /></label>

      <div class="ss-sec">Лимиты</div>
      <label class="ss-f"><span>Отрядов у игрока</span>
        <el-input-number :model-value="h.limits?.unit ?? 0" :min="0" :max="99" size="small" controls-position="right"
          style="width: 110px" @update:model-value="setLimit('unit', ($event as number) ?? 0)" /></label>
      <label class="ss-f"><span>Заклинаний</span>
        <el-input-number :model-value="h.limits?.spell ?? 0" :min="0" :max="99" size="small" controls-position="right"
          style="width: 110px" @update:model-value="setLimit('spell', ($event as number) ?? 0)" /></label>
      <label class="ss-f"><span>Уровень героя</span>
        <el-input-number :model-value="h.limits?.leader ?? 0" :min="0" :max="99" size="small" controls-position="right"
          style="width: 110px" @update:model-value="setLimit('leader', ($event as number) ?? 0)" /></label>
      <label class="ss-f"><span>Уровень города</span>
        <el-input-number :model-value="h.limits?.city ?? 0" :min="1" :max="5" size="small" controls-position="right"
          style="width: 110px" @update:model-value="setLimit('city', ($event as number) ?? 1)" /></label>
    </div>
  </div>
</template>

<style scoped>
.ss { display: flex; flex-direction: column; height: 100%; }
.ss-head { padding: 8px 10px; font-weight: 600; }
.ss-body { flex: 1; overflow-y: auto; padding: 0 10px 12px; }
.ss-f { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.ss-f > span { flex: 0 0 130px; color: var(--el-text-color-secondary); font-size: 12px; }
.ss-f.col { flex-direction: column; align-items: stretch; gap: 3px; }
.ss-f.col > span { flex: none; }
.ss-sec {
  margin: 12px 0 4px; font-weight: 600; font-size: 12px;
  border-top: 1px solid var(--el-border-color-lighter); padding-top: 8px;
}
</style>
