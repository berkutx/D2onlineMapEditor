<script setup lang="ts">
/**
 * Object property inspector. Shows the selected object's properties and edits the ones
 * we can already persist to the .sg (fixed-width int32 fields: image / tier / priority /
 * morale / regen / growth) via an undoable patchObject. Variable-length fields (name,
 * description, reward, items, owner) are shown read-only until the M4 growable writer
 * lands. Scope: chests / ruins / cities — capitals + units are view-only here.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { Close, Lock } from "@element-plus/icons-vue";
import { useToolStore } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";

const toolStore = useToolStore();
const editStore = useEditStore();
const { selectedId } = storeToRefs(toolStore);

/** the live selected object (or null) */
const obj = computed(() =>
  selectedId.value ? editStore.liveDoc?.objects.find((o) => o.id === selectedId.value) ?? null : null,
);

const TYPE_LABEL: Record<string, string> = {
  treasure: "Сундук", ruin: "Руина", village: "Город", capital: "Столица",
  mountains: "Горы", landmark: "Декор", stack: "Отряд", crystal: "Кристалл",
  merchant: "Торговец", mage: "Маг", trainer: "Тренер", mercenary: "Наёмники",
  rod: "Жезл", tomb: "Могила", unit: "Юнит", location: "Локация",
};
const typeLabel = computed(() => (obj.value ? TYPE_LABEL[obj.value.type] ?? obj.value.type : ""));
const editable = computed(() => !!obj.value && ["treasure", "ruin", "village"].includes(obj.value.type));

/** Players for the owner dropdown (id is the full compound uid = the stored OWNER value). */
const NEUTRAL = "G000000000";
const players = computed(() =>
  (editStore.liveDoc?.players ?? []).map((p) => ({ id: p.id, label: p.name || `Игрок ${p.playerNo}` })),
);

/** Commit one undoable patch (int or string fields). */
function patch(fields: Record<string, number | string>): void {
  if (obj.value) editStore.commit([{ kind: "patchObject", id: obj.value.id, fields }]);
}

/** Parse a ruin CASH reward "G0600:R0000:Y0000:E0000:W0000:B0000" into labelled amounts. */
const REWARD_ORDER = ["G", "R", "Y", "E", "W", "B"] as const;
const REWARD_LABELS: Record<string, string> = { G: "Золото", R: "Инферно", Y: "Жизнь", E: "Природа", W: "Руны", B: "Смерть" };
const reward = computed(() => {
  const r = obj.value?.type === "ruin" ? obj.value.reward : undefined;
  if (!r) return null;
  return r.split(":").map((p) => ({ k: p[0] ?? "", label: REWARD_LABELS[p[0] ?? ""] ?? p[0] ?? "", v: parseInt(p.slice(1), 10) || 0 }))
    .filter((e) => e.label);
});

/** Change a city's owner; also refresh the live race/banner sprite (race is derived, not stored). */
function setOwner(v: string): void {
  const fields: Record<string, number | string> = { owner: v };
  const pr = (editStore.liveDoc?.players ?? []).find((p) => p.id === v)?.race;
  if (pr !== undefined) fields.race = pr; // live re-render only; applyBytes skips derived fields
  patch(fields);
}

/** Rebuild the fixed-width 35-char CASH string with one resource changed, then patch it. */
function setReward(k: string, v: number): void {
  const cur: Record<string, number> = {};
  for (const r of reward.value ?? []) cur[r.k] = r.v;
  cur[k] = Math.max(0, Math.min(9999, Math.round(v || 0))); // 4-digit field keeps CASH length constant
  patch({ reward: REWARD_ORDER.map((o) => o + String(cur[o] ?? 0).padStart(4, "0")).join(":") });
}

function close(): void {
  toolStore.setSelectedId(null);
}
</script>

<template>
  <div v-if="obj" class="inspector">
    <div class="ins-head">
      <span class="ins-title">{{ typeLabel }}</span>
      <span class="ins-id">{{ obj.id }}</span>
      <el-button class="ins-close" text :icon="Close" @click="close()" />
    </div>
    <div class="ins-sub">Клетка {{ obj.pos.x }}, {{ obj.pos.y }}</div>

    <div v-if="editable" class="ins-body">
      <!-- 🧰 CHEST -->
      <template v-if="obj.type === 'treasure'">
        <div class="row">
          <label>Картинка</label>
          <el-input-number :model-value="obj.image ?? 0" :min="0" size="small" controls-position="right" @change="(v: number) => patch({ image: v ?? 0 })" />
        </div>
        <div class="row">
          <label>Приоритет ИИ</label>
          <el-input-number :model-value="obj.priority ?? 3" :min="0" :max="6" size="small" controls-position="right" @change="(v: number) => patch({ priority: v ?? 0 })" />
        </div>
        <div class="ro-block">
          <div class="ro-label">Предметы <span class="muted">({{ obj.items?.length ?? 0 }})</span> <el-icon class="lock"><Lock /></el-icon></div>
          <div v-if="obj.items?.length" class="items">
            <span v-for="it in obj.items" :key="it" class="item-tag">{{ it }}</span>
          </div>
          <div v-else class="muted sm">пусто</div>
        </div>
      </template>

      <!-- 🏚 RUIN -->
      <template v-else-if="obj.type === 'ruin'">
        <div class="col">
          <label>Название</label>
          <el-input :model-value="obj.name" size="small" placeholder="без имени" @change="(v: string) => patch({ name: v })" />
        </div>
        <div v-if="obj.desc !== undefined" class="col">
          <label>Описание</label>
          <el-input :model-value="obj.desc" type="textarea" :rows="2" size="small" @change="(v: string) => patch({ desc: v })" />
        </div>
        <div class="row">
          <label>Картинка</label>
          <el-input-number :model-value="obj.image ?? 0" :min="0" size="small" controls-position="right" @change="(v: number) => patch({ image: v ?? 0 })" />
        </div>
        <div class="row">
          <label>Приоритет ИИ</label>
          <el-input-number :model-value="obj.priority ?? 3" :min="0" :max="6" size="small" controls-position="right" @change="(v: number) => patch({ priority: v ?? 0 })" />
        </div>
        <div v-if="reward" class="ro-block">
          <div class="ro-label">Награда (золото и мана)</div>
          <div class="reward-edit">
            <div v-for="r in reward" :key="r.k" class="rw-edit">
              <span class="rw-lbl">{{ r.label }}</span>
              <el-input-number :model-value="r.v" :min="0" :max="9999" size="small" controls-position="right" @change="(v: number) => setReward(r.k, v)" />
            </div>
          </div>
        </div>
        <div class="ro-row"><label>Артефакт</label><span class="ro-val">{{ obj.item || "—" }} <el-icon class="lock"><Lock /></el-icon></span></div>
        <div class="ro-row"><label>Разграблена</label><span class="ro-val">{{ obj.looted ? "да" : "нет" }} <el-icon class="lock"><Lock /></el-icon></span></div>
      </template>

      <!-- 🏘 CITY -->
      <template v-else-if="obj.type === 'village'">
        <div class="col">
          <label>Название</label>
          <el-input :model-value="obj.name" size="small" placeholder="без имени" @change="(v: string) => patch({ name: v })" />
        </div>
        <div v-if="obj.desc !== undefined" class="col">
          <label>Описание</label>
          <el-input :model-value="obj.desc" type="textarea" :rows="2" size="small" @change="(v: string) => patch({ desc: v })" />
        </div>
        <div class="row">
          <label>Владелец</label>
          <el-select :model-value="obj.owner ?? NEUTRAL" size="small" class="owner-sel" @change="setOwner">
            <el-option label="Нейтрал" :value="NEUTRAL" />
            <el-option v-for="p in players" :key="p.id" :label="p.label" :value="p.id" />
          </el-select>
        </div>
        <div class="row">
          <label>Уровень</label>
          <el-input-number :model-value="obj.tier ?? 1" :min="1" :max="5" size="small" controls-position="right" @change="(v: number) => patch({ tier: v ?? 1 })" />
        </div>
        <div class="row">
          <label>Приоритет ИИ</label>
          <el-input-number :model-value="obj.priority ?? 3" :min="0" :max="6" size="small" controls-position="right" @change="(v: number) => patch({ priority: v ?? 0 })" />
        </div>
        <div v-if="obj.morale !== undefined" class="row">
          <label>Мораль</label>
          <el-input-number :model-value="obj.morale" size="small" controls-position="right" @change="(v: number) => patch({ morale: v ?? 0 })" />
        </div>
        <div v-if="obj.regen !== undefined" class="row">
          <label>Реген. гарнизона</label>
          <el-input-number :model-value="obj.regen" :min="0" size="small" controls-position="right" @change="(v: number) => patch({ regen: v ?? 0 })" />
        </div>
        <div v-if="obj.growth !== undefined" class="row">
          <label>Прирост</label>
          <el-input-number :model-value="obj.growth" :min="0" size="small" controls-position="right" @change="(v: number) => patch({ growth: v ?? 0 })" />
        </div>
      </template>

      <p class="ins-note"><el-icon><Lock /></el-icon> поля с замком пока только для просмотра (владелец, артефакт, списки предметов) — скоро.</p>
    </div>

    <div v-else class="ins-body">
      <p class="muted sm">Свойства для «{{ typeLabel }}» пока не редактируются. Сейчас поддержаны сундуки, руины и города.</p>
    </div>
  </div>
</template>

<style scoped>
.inspector {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
  border-left: var(--d2-hairline);
  padding: var(--d2-sp-3);
  overflow-y: auto;
}
.ins-head {
  display: flex;
  align-items: center;
  gap: var(--d2-sp-2);
}
.ins-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.ins-id {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}
.ins-close {
  margin-left: auto;
  flex: 0 0 auto;
}
.ins-sub {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin: 2px 0 var(--d2-sp-3);
}
.ins-body {
  display: flex;
  flex-direction: column;
  gap: var(--d2-sp-2);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--d2-sp-2);
}
.row label {
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.col {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.col label {
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.reward-edit {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 8px;
}
.rw-edit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}
.rw-lbl {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.rw-edit :deep(.el-input-number) {
  width: 86px;
}
.ro-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--d2-sp-2);
}
.ro-row label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  flex: 0 0 auto;
}
.ro-val {
  font-size: 12px;
  color: var(--el-text-color-primary);
  text-align: right;
  word-break: break-word;
}
.ro-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ro-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.reward {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 12px;
}
.rw {
  color: var(--el-text-color-regular);
}
.rw b {
  color: var(--el-text-color-primary);
}
.rw.zero {
  opacity: 0.45;
}
.items {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 140px;
  overflow-y: auto;
}
.item-tag {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: 4px;
  padding: 1px 5px;
}
.lock {
  color: var(--el-text-color-secondary);
  font-size: 11px;
  vertical-align: -1px;
}
.muted {
  color: var(--el-text-color-secondary);
}
.sm {
  font-size: 12px;
}
.ins-note {
  margin-top: var(--d2-sp-3);
  padding-top: var(--d2-sp-3);
  border-top: var(--d2-hairline);
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.row :deep(.el-input-number) {
  width: 110px;
}
.owner-sel {
  width: 150px;
}
</style>
