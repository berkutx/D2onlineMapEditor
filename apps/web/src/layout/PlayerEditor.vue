<script setup lang="ts">
/** Player roster editor — edits existing MidPlayers (человек/ИИ, отношение, стартовые ресурсы, ЛОРД)
 *  and ADDS / REMOVES a whole playable faction. A patch commits an undoable `patchPlayer`; add/remove
 *  commit `addPlayer` / `removePlayer` (the from-model export synthesises the player + subrace +
 *  capital + hero + satellites, and re-stamps the header `_playersData` / PLAYER_n — gold-checked in
 *  native ScenEdit). One player per race (the game keys players by race), so the add dialog only lists
 *  the races the map doesn't already have. Race stays derived (read-only) — change it via add/remove. */
import { computed, ref, watch, onMounted } from "vue";
import {
  ElSwitch, ElInputNumber, ElEmpty, ElTooltip, ElButton, ElSelect, ElOption, ElDialog, ElMessage, ElMessageBox,
} from "element-plus";
import { Plus, Delete } from "@element-plus/icons-vue";
import { useEditStore } from "../stores/editStore";
import { useLordStore } from "../stores/lordStore";
import { assetUrl } from "../services/api";
import {
  RACES, RACE_KEYS, raceAlreadyPresent, mintPlayerIds, findFreeCapitalSpot, type EditOp,
} from "@d2/map-edit";

/** Lord portrait PNG (built offline from Lords.ff by build_lord_icons.py). */
const lordUrl = (id: string | null | undefined): string => (id ? assetUrl(`lordicons/${id.toLowerCase()}.png`) : "");
/** Hide a portrait <img> whose file is missing (neutral lords / not-yet-built icons) rather than
 *  show a broken-image glyph. */
const onImgErr = (e: Event): void => { (e.target as HTMLImageElement).style.visibility = "hidden"; };

const edit = useEditStore();
const lord = useLordStore();
const players = computed(() => edit.liveDoc?.players ?? []);
onMounted(() => { if (!lord.loaded && !lord.loading) void lord.load(); });

/** Grace race INDEX (RR#### number, = p.race) → RU name, per the TARGET mod's Grace.dbf:
 *  1 = Кланы Гор, 2 = Легионы Проклятых, 3 = Орды Нежити (NOT the base-game order — #123). */
const RACE_NAMES: Record<number, string> = {
  0: "Империя", 1: "Кланы Гор", 2: "Легионы Проклятых", 3: "Орды Нежити", 4: "Нейтралы", 5: "Эльфийский Союз",
};
const raceName = (r: number): string => RACE_NAMES[r] ?? `Раса ${r}`;
const isNeutral = (p: { race: number }): boolean => p.race === 4;

// BANK / стартовые ресурсы: "G####:R####:Y####:E####:W####:B####" (letter + 4-digit amount).
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
/** The three lords (mage/warrior/diplomat) of a player's race — its lord-picker options. */
const lordOptions = (raceId: string | undefined): ReturnType<typeof lord.byRace> => lord.byRace(raceId);

// ── Add faction ──────────────────────────────────────────────────────────────
const addOpen = ref(false);
const addRaceKey = ref<string | null>(null);
const addLordId = ref<string | null>(null);
/** Playable races the map does NOT already have, labelled by their game (Grace) name. */
const availableRaces = computed(() => {
  const doc = edit.liveDoc;
  if (!doc) return [] as { key: string; raceId: string; name: string }[];
  return RACE_KEYS.filter((k) => !raceAlreadyPresent(doc, k)).map((k) => {
    const raceId = RACES[k].raceId;
    return { key: k, raceId, name: lord.byRace(raceId)[0]?.raceName || RACES[k].name };
  });
});
const addLordOptions = computed(() => (addRaceKey.value ? lord.byRace(RACES[addRaceKey.value as keyof typeof RACES].raceId) : []));
watch(addRaceKey, () => {
  const opts = addLordOptions.value;
  addLordId.value = opts.find((l) => l.category === 0)?.id ?? opts[0]?.id ?? null; // default = the race's mage
});
function openAdd(): void {
  const avail = availableRaces.value;
  if (!avail.length) { ElMessage.info("Все расы уже на карте — по одному игроку на расу (максимум 5 + нейтрал)"); return; }
  addRaceKey.value = avail[0]!.key;
  addOpen.value = true;
}
function confirmAdd(): void {
  const doc = edit.liveDoc;
  const key = addRaceKey.value;
  if (!doc || !key) return;
  const spot = findFreeCapitalSpot(doc);
  if (!spot) { ElMessage.warning("На карте нет свободного места 5×5 (суша) для новой столицы"); return; }
  const ids = mintPlayerIds(doc);
  const name = availableRaces.value.find((r) => r.key === key)?.name;
  try {
    edit.commit([{ kind: "addPlayer", spec: { race: key, x: spot.x, y: spot.y, lordId: addLordId.value ?? undefined, name, ids } } as unknown as EditOp]);
    addOpen.value = false;
    ElMessage.success(`Фракция добавлена — столица на клетке ${spot.x},${spot.y} (можно перетащить)`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// ── Remove faction ───────────────────────────────────────────────────────────
async function removeFaction(p: { id: string; name?: string; race: number }): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `Удалить фракцию «${p.name || raceName(p.race)}» вместе со всем, чем она владеет (столица, города, армии)?`,
      "Удаление игрока",
      { type: "warning", confirmButtonText: "Удалить", cancelButtonText: "Отмена" },
    );
  } catch { return; }
  try {
    edit.commit([{ kind: "removePlayer", id: p.id } as unknown as EditOp]);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <div class="pl">
    <div class="pl-head">
      <span class="pl-sub">{{ players.length }} игрок(ов)</span>
      <el-button size="small" :icon="Plus" @click="openAdd">Добавить фракцию</el-button>
    </div>
    <div class="pl-body">
      <el-empty v-if="players.length === 0" description="В сценарии нет игроков" :image-size="60" />
      <div v-for="p in players" :key="p.id" class="pl-card">
        <div class="pl-row pl-title">
          <span class="pl-name">
            <i v-if="p.color" class="pl-dot" :style="{ background: p.color }" />
            {{ p.name || `Игрок ${p.playerNo}` }}
          </span>
          <span class="pl-race muted">{{ raceName(p.race) }}</span>
          <el-button
            v-if="!isNeutral(p)" class="pl-del" size="small" text :icon="Delete"
            title="Удалить фракцию" @click="removeFaction(p)"
          />
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
        <div v-if="!isNeutral(p)" class="pl-row">
          <label>Лорд</label>
          <img v-if="lordUrl(p.lordId)" class="lord-pic" :src="lordUrl(p.lordId)" alt="" @error="onImgErr" />
          <el-select
            :model-value="p.lordId" size="small" placeholder="—" class="pl-lord"
            @update:model-value="(v: string) => patch(p.id, { lordId: v })"
          >
            <el-option v-for="l in lordOptions(p.raceId)" :key="l.id" :label="`${l.categoryName} — ${l.name}`" :value="l.id">
              <span class="lord-opt"><img class="lord-pic-sm" :src="lordUrl(l.id)" alt="" @error="onImgErr" />{{ l.categoryName }} — {{ l.name }}</span>
            </el-option>
          </el-select>
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
    <p class="pl-hint">Раса меняется добавлением/удалением фракции. Новая столица ставится на свободную сушу — перетащите её на нужное место.</p>

    <el-dialog v-model="addOpen" title="Добавить фракцию" width="380px" append-to-body>
      <div class="add-row">
        <label>Раса</label>
        <el-select v-model="addRaceKey" size="small" style="width: 220px">
          <el-option v-for="r in availableRaces" :key="r.key" :label="r.name" :value="r.key" />
        </el-select>
      </div>
      <div class="add-row">
        <label>Лорд</label>
        <img v-if="lordUrl(addLordId)" class="lord-pic" :src="lordUrl(addLordId)" alt="" @error="onImgErr" />
        <el-select v-model="addLordId" size="small" style="width: 220px">
          <el-option v-for="l in addLordOptions" :key="l.id" :label="`${l.categoryName} — ${l.name}`" :value="l.id">
            <span class="lord-opt"><img class="lord-pic-sm" :src="lordUrl(l.id)" alt="" @error="onImgErr" />{{ l.categoryName }} — {{ l.name }}</span>
          </el-option>
        </el-select>
      </div>
      <p class="add-hint muted">Игрок создаётся со столицей, героем и стражем (порт addRace). Столица встанет на свободную сушу.</p>
      <template #footer>
        <el-button size="small" @click="addOpen = false">Отмена</el-button>
        <el-button size="small" type="primary" :disabled="!addRaceKey" @click="confirmAdd">Добавить</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.pl { display: flex; flex-direction: column; height: 100%; font-size: 12px; }
.pl-head { padding: 10px 12px 4px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pl-sub { color: var(--el-text-color-secondary); font-size: 11px; }
.pl-body { flex: 1; overflow-y: auto; padding: 0 12px; max-width: 560px; }
.pl-card { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 8px 10px; margin: 8px 0; }
.pl-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.pl-row > label { min-width: 78px; color: var(--el-text-color-secondary); }
.pl-title { justify-content: flex-start; }
.pl-name { font-weight: 600; }
.pl-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; vertical-align: baseline; }
.pl-race { font-size: 11px; }
.pl-del { margin-left: auto; color: var(--el-color-danger); }
.pl-lord { flex: 1; max-width: 360px; }
.lord-pic { width: 34px; height: 42px; object-fit: cover; border-radius: 4px; border: 1px solid var(--el-border-color-lighter); flex: 0 0 auto; }
.lord-opt { display: inline-flex; align-items: center; gap: 8px; }
.lord-pic-sm { width: 26px; height: 32px; object-fit: cover; border-radius: 3px; flex: 0 0 auto; }
.pl-att { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.pl-att > label { color: var(--el-text-color-secondary); }
.pl-bank { flex-wrap: wrap; }
.pl-res { display: inline-flex; }
.pl-hint { color: var(--el-text-color-secondary); font-size: 11px; padding: 8px 12px; margin: 0; }
.add-row { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
.add-row > label { min-width: 48px; color: var(--el-text-color-secondary); }
.add-hint { font-size: 11px; margin: 6px 0 0; }
.muted { color: var(--el-text-color-secondary); }
</style>
