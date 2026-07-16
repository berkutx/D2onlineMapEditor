<script setup lang="ts">
/**
 * GarrisonEditor — a garrison as the in-game VERTICAL formation: 2 columns × 3 rows, with the
 * RIGHT column = FRONT line (even cells 0/2/4) and the LEFT column = BACK line (odd cells 1/3/5);
 * rows top→bottom = formation column index (cell/2). Verified vs D2RSG/D2ModdingToolset
 * (even cell = front, cell/2 = column). DOM order for the 2-col row-major grid = [1,0,3,2,5,4].
 * Presentational only: emits intent; the parent (ObjectInspector) owns the undoable patchObject.
 */
import { computed } from "vue";
import UnitPicker from "./UnitPicker.vue";
import UnitIcon from "./UnitIcon.vue";
import ModifierListEditor from "./ModifierListEditor.vue";
import { useUnitStore } from "../stores/unitStore";

// full-entity member (GarrisonUnit superset): extra persisted fields (xp/name/key/slot/…)
// ride along untouched — the editor reads unit/level/hp/modifiers and emits intents only
type GarrUnit = { unit: string; level: number; hp: number; modifiers?: string[] };

const props = withDefaults(
  defineProps<{
    garrison: (GarrUnit | null)[]; // length 6, by formation cell
    count: number;
    readonly?: boolean; // visitor garrison is shown read-only until the full Отряд editor lands
    leaderCell?: number; // when set (stack mode), shows a ★ leader toggle on filled cells
    /** Roster for NON-leader cells in stack mode / all cells otherwise: city/ruin garrisons
     *  pass "soldiers" (the reference editor never offers heroes there). Default keeps the
     *  old unfiltered behavior for surfaces not yet audited. */
    roster?: "soldiers" | "all";
    /** Hide the HP field — the stack-TEMPLATE format has no per-unit HP (level only). */
    hideHp?: boolean;
    /** Level cap for the ур. input (garrison 50, template 10). */
    maxLevel?: number;
    /** Optional per-cell clear gate: return false to forbid emptying a cell (the template's
     *  leader lock — can't remove the leader while soldiers remain). Default: all clearable. */
    cellClearable?: (cell: number) => boolean;
  }>(),
  { readonly: false, leaderCell: undefined, roster: "all", hideHp: false, maxLevel: 50, cellClearable: undefined },
);
const emit = defineEmits<{
  setUnit: [cell: number, unitId: string];
  clear: [cell: number];
  setStat: [cell: number, key: "level" | "hp", value: number];
  setLeader: [cell: number];
  setMods: [cell: number, mods: string[]];
}>();

const unitStore = useUnitStore();

// Layout slots in DOM order (row-major, 2 cols; left=back/odd, right=front/even). Normally a
// formation row is two cells [back, front]. A 2-cell "double" unit (dragon, big hero) is ONE
// entity filling BOTH cells of a row (they share a `key`); it is shown as a SINGLE WIDE slot
// spanning both columns — physically one unit, so one picker + one set of stats (edits sync both
// cells via the parent's entityCells). A freshly-placed unit has no `key` yet → shown as normal.
const slots = computed<{ cell: number; wide: boolean }[]>(() => {
  const g = props.garrison;
  const keyOf = (i: number): string | undefined => (g[i] as { key?: string } | null)?.key ?? undefined;
  const out: { cell: number; wide: boolean }[] = [];
  for (let r = 0; r < 3; r++) {
    const front = 2 * r;
    const back = 2 * r + 1;
    const k = keyOf(front);
    if (g[front] && g[back] && k && keyOf(back) === k) out.push({ cell: front, wide: true });
    else { out.push({ cell: back, wide: false }); out.push({ cell: front, wide: false }); }
  }
  return out;
});

/** Stack mode: does the formation already have a LEADER-category unit in the leader cell?
 *  Mirrors the reference Stack.qml binding `unitsView.leader: !garrison.hasLeader`. */
const hasLeader = computed(
  () =>
    props.leaderCell !== undefined &&
    props.leaderCell >= 0 &&
    unitStore.isLeaderCategory(props.garrison[props.leaderCell]?.unit),
);
/** Per-cell picker roster: while the stack lacks a leader, EVERY pick offers leaders
 *  (первый юнит = герой/вор); once led, the leader cell re-picks leaders, others soldiers. */
function rosterFor(cell: number): "leaders" | "soldiers" | "all" {
  if (props.leaderCell === undefined) return props.roster; // not a stack (city/ruin garrison)
  if (!hasLeader.value) return "leaders";
  return cell === props.leaderCell ? "leaders" : "soldiers";
}
/** Only a leader-category unit may wear the star (import validator's rule). */
const starAllowed = (cell: number): boolean =>
  unitStore.isLeaderCategory(props.garrison[cell]?.unit);

function onPick(cell: number, v: string | null): void {
  if (v) emit("setUnit", cell, v);
  else emit("clear", cell);
}

/** Reason a BIG (2-cell) unit can't be placed at `cell` ("" ⇒ allowed). A big unit fills both
 *  cells of its formation row (partner = cell ^ 1); placing it evicts whatever sits in the
 *  partner. That eviction is fine for a regular soldier (it happens honestly on export) — the ONE
 *  case we forbid is evicting the crowned LEADER, which the reference never allows. Small units
 *  are never blocked. Only fires in stack/visitor mode (city/ruin garrisons pass no leaderCell). */
function bigBlockedReason(cell: number, unitId: string): string {
  if (!unitStore.isLarge(unitId)) return ""; // only big candidates can ever be blocked
  const partner = cell ^ 1;
  const p = props.garrison[partner];
  if (!p) return ""; // empty partner → the big unit claims both cells freely
  const curKey = (props.garrison[cell] as { key?: string } | null)?.key;
  const pKey = (p as { key?: string }).key;
  if (curKey && pKey && curKey === pKey) return ""; // re-picking the SAME big entity (wide slot)
  if (props.leaderCell === partner)
    return "Соседняя линия занята лидером — большой юнит занял бы обе, а лидера выселять нельзя";
  return ""; // a regular soldier partner IS evictable (placeUnitInCells drops it honestly)
}
</script>

<template>
  <div class="ro-block">
    <div class="garr-cols"><span>Тыл</span><span>Фронт</span></div>
    <div class="garr-grid">
      <div v-for="{ cell, wide } in slots" :key="cell" class="garr-cell" :class="{ filled: !!garrison[cell], ro: readonly, wide }">
        <span v-if="wide" class="garr-double" title="Двойной юнит — занимает обе линии формации; правки применяются к нему целиком">⇔ двойной</span>
        <template v-if="readonly">
          <div class="garr-ro">
            <UnitIcon
              :id="garrison[cell]?.unit ?? null"
              :level="unitStore.get(garrison[cell]?.unit)?.level"
              :subrace-id="unitStore.get(garrison[cell]?.unit)?.subraceId ?? -1"
              :size="22"
            />
            <span class="garr-ro-name">{{ garrison[cell] ? unitStore.nameOf(garrison[cell]!.unit) : "—" }}</span>
          </div>
          <div v-if="garrison[cell]" class="garr-ro-stats">ур.{{ garrison[cell]!.level }} · {{ garrison[cell]!.hp }} HP</div>
        </template>
        <template v-else>
          <div class="garr-pick">
            <UnitPicker
              :model-value="garrison[cell]?.unit ?? null"
              :nullable="cellClearable ? cellClearable(cell) : true"
              :roster="rosterFor(cell)"
              :disabled-reason="(id) => bigBlockedReason(cell, id)"
              :title="rosterFor(cell) === 'leaders' ? 'Лидер отряда — герой или вор' : `Юнит — ${cell % 2 === 0 ? 'передняя' : 'задняя'} линия`"
              @update:model-value="(v) => onPick(cell, v)"
            />
            <button
              v-if="leaderCell !== undefined && garrison[cell]"
              type="button"
              class="garr-leader"
              :class="{ active: leaderCell === cell || (wide && leaderCell === cell + 1), blocked: !starAllowed(cell) }"
              :disabled="!starAllowed(cell)"
              :title="
                leaderCell === cell ? 'Лидер отряда'
                : starAllowed(cell) ? 'Сделать лидером'
                : 'Вести отряд может только герой или вор (категория лидера)'
              "
              @click="starAllowed(cell) && emit('setLeader', cell)"
            >★</button>
          </div>
          <div v-if="garrison[cell]" class="garr-stats">
          <span class="garr-stat">
            <label>ур.</label>
            <el-input-number
              :model-value="garrison[cell]!.level"
              :min="1"
              :max="maxLevel"
              size="small"
              :controls="false"
              @change="(v: number) => emit('setStat', cell, 'level', v ?? 1)"
            />
          </span>
          <span v-if="!hideHp" class="garr-stat">
            <label>HP</label>
            <el-input-number
              :model-value="garrison[cell]!.hp"
              :min="0"
              :max="unitStore.get(garrison[cell]!.unit)?.hp || 9999"
              size="small"
              :controls="false"
              @change="(v: number) => emit('setStat', cell, 'hp', v ?? 0)"
            />
          </span>
          <span v-if="!readonly" class="garr-stat garr-mods">
            <ModifierListEditor
              :model-value="garrison[cell]!.modifiers ?? []"
              :title="`${unitStore.nameOf(garrison[cell]!.unit)} — модификаторы`"
              :leader="leaderCell === cell"
              compact
              @update:model-value="(mods) => emit('setMods', cell, mods)"
            />
          </span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ro-block { display: flex; flex-direction: column; gap: 4px; }
.garr-cols {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--d2-sp-1, 4px);
}
.garr-cols span {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--el-text-color-placeholder);
  text-align: center;
}
.garr-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--d2-sp-1, 4px);
}
/* empty cell = soft-fill placeholder (no dashed frame); filled = .d2-card look
 * (fill only, no border) */
.garr-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px;
  min-width: 0;
  background: var(--el-fill-color-lighter);
  border-radius: var(--d2-radius);
}
.garr-cell.filled {
  background: var(--el-fill-color-light);
}
/* a 2-cell "double" unit is shown as ONE slot spanning both formation lines */
.garr-cell.wide { grid-column: 1 / -1; }
.garr-double {
  align-self: flex-start;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--el-color-warning);
  opacity: 0.85;
}
.garr-cell.ro {
  gap: 2px;
  padding: 4px 5px;
}
.garr-ro {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.garr-ro-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.garr-ro-stats {
  font-size: 10px;
  color: var(--el-text-color-secondary);
  padding-left: 27px;
}
.garr-cell :deep(.up-wrap) { width: 100%; }
/* min-width:0 lets the trigger shrink below its content (a long unit name) so the sibling
 * ⊗ clear button stays inside the (half-width) cell instead of overlapping the neighbour. */
.garr-cell :deep(.up-trigger) { width: 100%; min-width: 0; justify-content: flex-start; padding: 4px 6px; }
.garr-cell :deep(.up-trigger-text) { max-width: 100%; }
.garr-pick {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.garr-pick :deep(.up-wrap) { flex: 1 1 auto; min-width: 0; }
.garr-leader {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 2px;
  color: var(--el-text-color-placeholder);
}
.garr-leader:hover { color: var(--el-color-warning); }
.garr-leader.active { color: var(--el-color-warning); }
.garr-leader.blocked { opacity: 0.3; cursor: not-allowed; }
.garr-leader.blocked:hover { color: var(--el-text-color-placeholder); }
/* stat rows STACK vertically inside a (narrow, half-width) cell so HP always fits */
.garr-stats {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.garr-stat {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
}
.garr-stat label {
  flex: 0 0 22px;
  font-size: 10px;
  color: var(--el-text-color-secondary);
}
.garr-stat :deep(.el-input-number) {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}
.garr-stat :deep(.el-input-number .el-input__inner) {
  text-align: left;
  padding: 0 6px;
}
</style>
