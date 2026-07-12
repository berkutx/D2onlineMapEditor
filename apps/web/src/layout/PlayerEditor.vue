<script setup lang="ts">
/** Player roster editor — edits an EXISTING MidPlayer's authorable fields (человек/ИИ, отношение
 *  к игроку, стартовые ресурсы = BANK). Each change commits an undoable `patchPlayer` op; the export
 *  re-serialises the MidPlayer block from the model. Adding/removing a player (which needs a capital
 *  + subrace) is a later op — this edits the players a scenario already has. Race is derived from the
 *  faction's forts/subrace, so it is shown read-only here (change it via the fort/subrace, not here). */
import { computed } from "vue";
import { ElSwitch, ElInputNumber, ElEmpty, ElTooltip } from "element-plus";
import { useEditStore } from "../stores/editStore";
import type { EditOp } from "@d2/map-edit";

const edit = useEditStore();
const players = computed(() => edit.liveDoc?.players ?? []);

/** Grace race index → RU name (base-game order; the owner IS its race, 1:1 per scenario). */
const RACE_NAMES: Record<number, string> = {
  0: "Империя", 1: "Нежить", 2: "Легионы", 3: "Кланы", 4: "Нейтралы", 5: "Эльфы",
};
const raceName = (r: number): string => RACE_NAMES[r] ?? `Раса ${r}`;

// BANK / стартовые ресурсы: "G####:R####:Y####:E####:W####:B####" (letter + 4-digit amount).
// Letter order = the resource enum (same as a ruin CASH reward): Gold, Inferno, Life, Death, Runic, Nature.
const BANK_ORDER = ["G", "R", "Y", "E", "W", "B"] as const;
const BANK_LABELS: Record<string, string> = { G: "Золото", R: "Инферно", Y: "Жизнь", E: "Смерть", W: "Руны", B: "Природа" };
const parseBank = (s: string | undefined): number[] => {
  const m = new Map((s ?? "").split(":").map((p) => [p[0] ?? "", parseInt(p.slice(1), 10) || 0] as const));
  return BANK_ORDER.map((k) => m.get(k) ?? 0);
};
const buildBank = (vals: number[]): string =>
  BANK_ORDER.map((k, i) => `${k}${String(Math.max(0, vals[i] ?? 0)).padStart(4, "0")}`).join(":");

function patch(id: string, fields: Record<string, unknown>): void {
  edit.commit([{ kind: "patchPlayer", id, fields } as EditOp]);
}
function setBankResource(p: { id: string; bank?: string }, idx: number, v: number): void {
  const vals = parseBank(p.bank);
  vals[idx] = v;
  patch(p.id, { bank: buildBank(vals) });
}
</script>

<template>
  <div class="pl">
    <div class="pl-head"><span class="pl-sub">{{ players.length }} игрок(ов)</span></div>
    <div class="pl-body">
      <el-empty v-if="players.length === 0" description="В сценарии нет игроков" :image-size="60" />
      <div v-for="p in players" :key="p.id" class="pl-card">
        <div class="pl-row pl-title">
          <span class="pl-name">
            <i v-if="p.color" class="pl-dot" :style="{ background: p.color }" />
            {{ p.name || `Игрок ${p.playerNo}` }}
          </span>
          <span class="pl-race muted">{{ raceName(p.race) }}</span>
        </div>
        <div class="pl-row">
          <label>Управление</label>
          <el-switch
            :model-value="!!p.isHuman"
            active-text="Человек" inactive-text="ИИ" inline-prompt
            @update:model-value="(v: string | number | boolean) => patch(p.id, { isHuman: !!v })"
          />
          <el-tooltip content="ATTITUDE — агрессивность ИИ" placement="top">
            <span class="pl-att">
              <label>Отношение</label>
              <el-input-number
                :model-value="p.attitude ?? 0" :min="0" :max="4" size="small" controls-position="right"
                style="width: 84px" @update:model-value="(v: number | undefined) => patch(p.id, { attitude: v ?? 0 })"
              />
            </span>
          </el-tooltip>
        </div>
        <div class="pl-row pl-bank">
          <label>Казна</label>
          <span v-for="(amt, i) in parseBank(p.bank)" :key="BANK_ORDER[i]" class="pl-res">
            <el-tooltip :content="BANK_LABELS[BANK_ORDER[i]!]" placement="top">
              <el-input-number
                :model-value="amt" :min="0" :max="9999" size="small" controls-position="right"
                :controls="false" style="width: 62px"
                @update:model-value="(v: number | undefined) => setBankResource(p, i, v ?? 0)"
              />
            </el-tooltip>
          </span>
        </div>
      </div>
    </div>
    <p class="pl-hint">Раса игрока меняется через владельца/знамя форта. Добавление игрока — отдельный шаг.</p>
  </div>
</template>

<style scoped>
.pl { display: flex; flex-direction: column; height: 100%; font-size: 12px; }
.pl-head { padding: 10px 12px 4px; }
.pl-sub { color: var(--el-text-color-secondary); font-size: 11px; }
.pl-body { flex: 1; overflow-y: auto; padding: 0 12px; max-width: 560px; }
.pl-card { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
.pl-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.pl-row > label { min-width: 78px; color: var(--el-text-color-secondary); }
.pl-title { justify-content: space-between; }
.pl-name { font-weight: 600; }
.pl-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; vertical-align: baseline; }
.pl-race { font-size: 11px; }
.pl-att { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.pl-att > label { color: var(--el-text-color-secondary); }
.pl-bank { flex-wrap: wrap; }
.pl-res { display: inline-flex; }
.pl-hint { color: var(--el-text-color-secondary); font-size: 11px; padding: 8px 12px; margin: 0; }
.muted { color: var(--el-text-color-secondary); }
</style>
