<script setup lang="ts">
/** Scenario variables editor (MidScenVariables): name + int value, add/remove. Referenced by
 *  events (VARIABLE_IS_IN_RANGE / COMPARE_VAR / MODIFY_VARIABLE) via the variable's numeric id.
 *  Edits commit as one setVariables op (the whole list is one block). */
import { ElInput, ElInputNumber, ElButton, ElScrollbar, ElEmpty } from "element-plus";
import { useEventStore } from "../stores/eventStore";

const store = useEventStore();
</script>

<template>
  <div class="var-editor">
    <div class="var-head">
      <strong>Переменные</strong>
      <span class="var-count">{{ store.variables.length }}</span>
      <el-button size="small" type="primary" @click="store.addVariable()">+ Переменная</el-button>
    </div>
    <el-scrollbar class="var-list">
      <div v-for="v in store.variables" :key="v.id" class="var-row">
        <span class="var-id">#{{ v.id }}</span>
        <el-input :model-value="v.name" size="small" placeholder="имя"
          @update:model-value="store.patchVariable(v.id, { name: $event })" />
        <el-input-number :model-value="v.value" size="small" controls-position="right" style="width: 110px"
          @update:model-value="store.patchVariable(v.id, { value: ($event as number) ?? 0 })" />
        <el-button size="small" text @click="store.removeVariable(v.id)">🗑</el-button>
      </div>
      <el-empty v-if="!store.variables.length" description="Нет переменных" :image-size="60" />
    </el-scrollbar>
    <p class="var-hint">Переменные — счётчики сценария. События их читают (условия «переменная в диапазоне» / «сравнение») и меняют (эффект «изменить переменную»), собирая цепочки и стейт-машины.</p>
  </div>
</template>

<style scoped>
.var-editor { display: flex; flex-direction: column; height: 100%; }
.var-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
.var-count { color: var(--el-text-color-secondary); margin-right: auto; }
.var-list { flex: 1; padding: 0 10px; }
.var-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
.var-id { color: var(--el-text-color-secondary); width: 34px; font-family: monospace; font-size: 11px; }
.var-hint { color: var(--el-text-color-secondary); font-size: 11px; padding: 8px 10px; margin: 0; }
</style>
