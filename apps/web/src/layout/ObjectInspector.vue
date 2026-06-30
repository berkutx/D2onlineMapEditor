<script setup lang="ts">
/**
 * Object property inspector. Shows the selected object's properties and edits the ones
 * we can already persist to the .sg (fixed-width int32 fields: image / tier / priority /
 * morale / regen / growth) via an undoable patchObject. Variable-length fields (name,
 * description, reward, items, owner) are shown read-only until the M4 growable writer
 * lands. Scope: chests / ruins / cities — capitals + units are view-only here.
 */
import { computed, watch } from "vue";
import { storeToRefs } from "pinia";
import { Close, Delete } from "@element-plus/icons-vue";
import { useToolStore } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";
import { useItemStore } from "../stores/itemStore";
import { useUnitStore } from "../stores/unitStore";
import { useSpellStore } from "../stores/spellStore";
import ItemPicker from "./ItemPicker.vue";
import ItemIcon from "./ItemIcon.vue";
import UnitPicker from "./UnitPicker.vue";
import UnitIcon from "./UnitIcon.vue";
import SpellPicker from "./SpellPicker.vue";
import SpellIcon from "./SpellIcon.vue";
import GarrisonEditor from "./GarrisonEditor.vue";
import ImagePicker from "./ImagePicker.vue";
import SpriteThumb from "./SpriteThumb.vue";
import { useSpriteStore } from "../stores/spriteStore";

/** RuinObjectAccessor sprite key: "G000RU0000" + image(3) (base look; looted adds +100). */
const ruinImageKey = (i: number): string => `G000RU0000${String(i).padStart(3, "0")}`;

const toolStore = useToolStore();
const editStore = useEditStore();
const itemStore = useItemStore();
const unitStore = useUnitStore();
const spellStore = useSpellStore();
void itemStore.load();
const spriteStore = useSpriteStore();
const { selectedId } = storeToRefs(toolStore);

/** Retry the catalog loads when an object is selected but a catalog failed to load earlier
 *  (e.g. a transient error while the dev server was reloading). Unit/spell catalogs are
 *  needed eagerly so garrison cells + stock rows can show names without opening a picker. */
watch(selectedId, () => {
  if (!itemStore.loaded && !itemStore.loading) void itemStore.load();
  if (!unitStore.loaded && !unitStore.loading) void unitStore.load();
  if (!spellStore.loaded && !spellStore.loading) void spellStore.load();
});

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
const SITE_TYPES = ["merchant", "mage", "trainer", "mercenary"];
const editable = computed(
  () => !!obj.value && ["treasure", "ruin", "village", "capital", "crystal", "stack", ...SITE_TYPES].includes(obj.value.type),
);

/** Site sprite key: "G000SI0000" + 4-char type code + image(2). */
const SITE_CODE: Record<string, string> = { merchant: "MERH", mage: "MAGE", trainer: "TRAI", mercenary: "MERC" };
const siteImageKey = computed(() => {
  const code = obj.value ? SITE_CODE[obj.value.type] ?? "MERH" : "MERH";
  return (i: number): string => `G000SI0000${code}${String(i).padStart(2, "0")}`;
});

/** Mana-crystal: RESOURCE int 0-5 (CrystalIdByResource order) -> RU label + sprite suffix. */
const CRYSTAL_LABELS = ["Золото", "Инферно", "Жизнь", "Смерть", "Руны", "Природа"];
const CRYSTAL_SUFFIX = ["GL", "RD", "YE", "RG", "WH", "GR"];
const crystalKey = (r: number): string => `G000CR0000${CRYSTAL_SUFFIX[r] ?? "GL"}`;

/** Players for the owner dropdown (id is the full compound uid = the stored OWNER value). */
const NEUTRAL = "G000000000";
const players = computed(() =>
  (editStore.liveDoc?.players ?? []).map((p) => ({ id: p.id, label: p.name || `Игрок ${p.playerNo}` })),
);

/** Commit one undoable patch (int / string / derived-bool / list / structured fields).
 *  `unknown` covers the garrison + site-stock arrays ((GarrisonUnit|null)[], {id,count}[],
 *  {id,level,unique}[]) which the bytes writer resolves by field name. */
function patch(fields: Record<string, unknown>): void {
  if (obj.value) editStore.commit([{ kind: "patchObject", id: obj.value.id, fields }]);
}

/** Chest items are global GItem template ids (the parser resolves the MidItem instance
 *  indirection away); the picker + display work directly on templates. */
const chestItems = computed(() => {
  if (obj.value?.type !== "treasure") return [];
  return (obj.value.items ?? []).map((template, idx) => ({
    idx, key: `${template}#${idx}`, template, name: itemStore.nameOf(template) || template,
  }));
});

/** TreasureObjectAccessor key: "G000BG0000" + (water ? 0 : 1) + image(2). Water chests have
 *  4 looks, land chests 8; the picker filters to the variants that actually have a frame. */
function waterAt(x: number, y: number): boolean {
  const doc = editStore.liveDoc;
  const c = doc ? doc.terrain.cells[y * doc.size + x] : undefined;
  return !!c?.isWater;
}
const chestImageKey = computed(() => {
  const water = obj.value?.type === "treasure" ? waterAt(obj.value.pos.x, obj.value.pos.y) : false;
  return (i: number): string => `G000BG0000${water ? "0" : "1"}${String(i).padStart(2, "0")}`;
});

/** The selected object's own sprite key, for a thumbnail in the inspector header.
 *  Village uses the race-free fallback (G000FT0000NE<tier>); capitals/units have no key here. */
const headerSpriteKey = computed<string | null>(() => {
  const o = obj.value;
  if (!o) return null;
  if (o.type === "ruin") return ruinImageKey(o.image ?? 0);
  if (o.type === "treasure") return chestImageKey.value(o.image ?? 0);
  if (o.type === "village") return `G000FT0000NE${o.tier ?? 1}`;
  if (o.type === "crystal") return crystalKey(o.resource ?? 0);
  if (SITE_TYPES.includes(o.type)) return siteImageKey.value(o.image ?? 0);
  return null;
});
watch(headerSpriteKey, (k) => { if (k) void spriteStore.ensureKeys([k]); }, { immediate: true });

/** Chest item-list edits — each is one undoable patchObject (commit applies optimistically). */
function chestAddItem(template: string): void {
  patch({ items: [...(obj.value?.type === "treasure" ? obj.value.items ?? [] : []), template] });
}
function chestRemoveItem(idx: number): void {
  if (obj.value?.type !== "treasure") return;
  patch({ items: (obj.value.items ?? []).filter((_, i) => i !== idx) });
}
function chestMoveItem(idx: number, dir: number): void {
  if (obj.value?.type !== "treasure") return;
  const items = [...(obj.value.items ?? [])];
  const j = idx + dir;
  if (j < 0 || j >= items.length) return;
  [items[idx], items[j]] = [items[j]!, items[idx]!];
  patch({ items });
}

/** ── Garrisons. A city/capital has TWO armies (verified vs toolsqt + Riders bytes):
 *  • DEFENSE — the city's OWN embedded UNIT_/POS_ formation (editable here, on the city id);
 *  • VISITOR — a separate hero MidStack stationed inside (city.stackRef → that stack). Shown
 *    read-only for now; full editing comes with the Отряд (stack) editor. Each cell = a global
 *    Gunit id + level + HP; the writer re-creates the MidUnit instances + UNIT_/POS_ slots. */
type GarrUnit = { unit: string; level: number; hp: number };
function garr6(o: { garrison?: (GarrUnit | null)[] } | null | undefined): (GarrUnit | null)[] {
  const out: (GarrUnit | null)[] = [null, null, null, null, null, null];
  (o?.garrison ?? []).forEach((c, i) => { if (c && i < 6) out[i] = { unit: c.unit, level: c.level, hp: c.hp }; });
  return out;
}
/** the visiting hero stack stationed inside this city (city.stackRef → a MidStack), if any */
const visitorStack = computed(() => {
  const o = obj.value;
  const ref = o && (o.type === "capital" || o.type === "village") ? o.stackRef : undefined;
  return ref ? editStore.liveDoc?.objects.find((x) => x.id === ref) ?? null : null;
});
const defenseGarrison = computed(() => garr6(obj.value as { garrison?: (GarrUnit | null)[] } | null));
const visitorGarrison = computed(() => garr6(visitorStack.value as { garrison?: (GarrUnit | null)[] } | null));
const defenseCount = computed(() => defenseGarrison.value.filter(Boolean).length);
const visitorCount = computed(() => visitorGarrison.value.filter(Boolean).length);

/** commit a garrison change to a specific object id (the city, for its defense). */
function commitGarrison(targetId: string, g: (GarrUnit | null)[]): void {
  editStore.commit([{ kind: "patchObject", id: targetId, fields: { garrison: g } }]);
}
function setGarrisonUnitOn(targetId: string, cur: (GarrUnit | null)[], cell: number, unitId: string): void {
  const g = cur.map((c) => (c ? { ...c } : null));
  g[cell] = { unit: unitId, level: 1, hp: unitStore.get(unitId)?.hp ?? 0 };
  commitGarrison(targetId, g);
}
function clearGarrisonCellOn(targetId: string, cur: (GarrUnit | null)[], cell: number): void {
  const g = cur.map((c) => (c ? { ...c } : null));
  g[cell] = null;
  commitGarrison(targetId, g);
}
function setGarrisonStatOn(targetId: string, cur: (GarrUnit | null)[], cell: number, key: "level" | "hp", v: number): void {
  const g = cur.map((c) => (c ? { ...c } : null));
  const c = g[cell];
  if (!c) return;
  g[cell] = { ...c, [key]: Math.max(0, Math.round(v || 0)) };
  commitGarrison(targetId, g);
}

/** ── Merchant stock: a list of {id (global GItem), count}. */
const merchantItems = computed(() => (obj.value?.type === "merchant" ? obj.value.items ?? [] : []));
function merchantAddItem(id: string): void {
  patch({ items: [...merchantItems.value, { id, count: 1 }] });
}
function merchantRemove(i: number): void {
  patch({ items: merchantItems.value.filter((_, k) => k !== i) });
}
function merchantSetCount(i: number, v: number): void {
  patch({ items: merchantItems.value.map((it, k) => (k === i ? { ...it, count: Math.max(1, Math.round(v || 1)) } : it)) });
}

/** ── Mage stock: a list of global Gspell ids. */
const mageSpells = computed(() => (obj.value?.type === "mage" ? obj.value.spells ?? [] : []));
function mageAddSpell(id: string): void {
  patch({ spells: [...mageSpells.value, id] });
}
function mageRemove(i: number): void {
  patch({ spells: mageSpells.value.filter((_, k) => k !== i) });
}

/** ── Mercenary stock: a list of {id (global Gunit), level, unique}. */
const mercUnits = computed(() => (obj.value?.type === "mercenary" ? obj.value.units ?? [] : []));
function mercAddUnit(id: string): void {
  patch({ units: [...mercUnits.value, { id, level: unitStore.get(id)?.level ?? 1, unique: false }] });
}
function mercRemove(i: number): void {
  patch({ units: mercUnits.value.filter((_, k) => k !== i) });
}
function mercSetLevel(i: number, v: number): void {
  patch({ units: mercUnits.value.map((u, k) => (k === i ? { ...u, level: Math.max(1, Math.round(v || 1)) } : u)) });
}
function mercSetUnique(i: number, v: boolean): void {
  patch({ units: mercUnits.value.map((u, k) => (k === i ? { ...u, unique: v } : u)) });
}

/** ── Stack («Отряд»): formation (with leader) + order + leader equipment + inventory.
 *  Editing the formation rewrites UNIT_/POS_ (new MidUnit instances) + LEADER_ID; we always send
 *  garrison + leaderCell + the recomputed leaderImage so the live doc + writer stay in sync. */
const ORDER_OPTIONS = [
  { value: 1, label: "Обычный" }, { value: 2, label: "Стоять" }, { value: 3, label: "Охранять" },
  { value: 4, label: "Атаковать" }, { value: 7, label: "Бродить" }, { value: 8, label: "Идти" },
  { value: 9, label: "Защищать" }, { value: 10, label: "Берсерк" },
];
const EQUIP_SLOTS = [
  { key: "tome", label: "Книга" }, { key: "battle1", label: "Боевой 1" }, { key: "battle2", label: "Боевой 2" },
  { key: "artifact1", label: "Артефакт 1" }, { key: "artifact2", label: "Артефакт 2" }, { key: "boots", label: "Сапоги" },
];
const stackGarrison = computed(() => garr6(obj.value?.type === "stack" ? (obj.value as { garrison?: (GarrUnit | null)[] }) : null));
const stackCount = computed(() => stackGarrison.value.filter(Boolean).length);
const stackLeaderCell = computed(() => (obj.value?.type === "stack" ? obj.value.leaderCell ?? -1 : -1));

function commitStack(g: (GarrUnit | null)[], leaderCell: number): void {
  if (obj.value?.type !== "stack") return;
  let lc = leaderCell;
  if (lc < 0 || !g[lc]) lc = g.findIndex(Boolean); // keep the leader on a filled cell
  const leaderImage = lc >= 0 ? g[lc]?.unit : undefined;
  editStore.commit([{ kind: "patchObject", id: obj.value.id, fields: { garrison: g, leaderCell: lc, leaderImage } }]);
}
function setStackUnit(cell: number, unitId: string): void {
  const g = stackGarrison.value.map((c) => (c ? { ...c } : null));
  g[cell] = { unit: unitId, level: 1, hp: unitStore.get(unitId)?.hp ?? 0 };
  commitStack(g, stackLeaderCell.value);
}
function clearStackCell(cell: number): void {
  const g = stackGarrison.value.map((c) => (c ? { ...c } : null));
  g[cell] = null;
  commitStack(g, stackLeaderCell.value);
}
function setStackStat(cell: number, key: "level" | "hp", v: number): void {
  const g = stackGarrison.value.map((c) => (c ? { ...c } : null));
  const c = g[cell];
  if (!c) return;
  g[cell] = { ...c, [key]: Math.max(0, Math.round(v || 0)) };
  commitStack(g, stackLeaderCell.value);
}
function setStackLeader(cell: number): void {
  commitStack(stackGarrison.value.map((c) => (c ? { ...c } : null)), cell);
}
function equipVal(slot: string): string {
  const eq = obj.value?.type === "stack" ? (obj.value.equip as Record<string, string | undefined> | undefined) : undefined;
  return eq?.[slot] ?? NEUTRAL;
}
function setStackEquip(slot: string, id: string | null): void {
  if (obj.value?.type !== "stack") return;
  const cur = (obj.value.equip ?? {}) as Record<string, string | undefined>;
  const equip: Record<string, string> = {}; // only filled slots (matches the reader)
  for (const s of EQUIP_SLOTS) {
    const v = s.key === slot ? (id && id !== NEUTRAL ? id : undefined) : cur[s.key];
    if (v) equip[s.key] = v;
  }
  editStore.commit([{ kind: "patchObject", id: obj.value.id, fields: { equip } }]);
}

/** Parse a ruin CASH reward "G0600:R0000:Y0000:E0000:W0000:B0000" into labelled amounts.
 *  Letter order = the resource enum (CrystalIdByResource): Gold, Demons(Inferno), Empire(Life),
 *  Undead(Death), Clans(Runic), Elves(Nature) — so E=Death, B=Nature (NOT the other way). */
const REWARD_ORDER = ["G", "R", "Y", "E", "W", "B"] as const;
const REWARD_LABELS: Record<string, string> = { G: "Золото", R: "Инферно", Y: "Жизнь", E: "Смерть", W: "Руны", B: "Природа" };
/** mana-school crystal sprite per reward letter (the game's coloured mana crystal). */
const REWARD_CRYSTAL: Record<string, string> = {
  G: "G000CR0000GL", R: "G000CR0000RD", Y: "G000CR0000YE", E: "G000CR0000RG", W: "G000CR0000WH", B: "G000CR0000GR",
};
void spriteStore.ensureKeys(Object.values(REWARD_CRYSTAL));
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

/** Set a ruin's looter (a player, or neutral = not looted). `looted` is derived for the
 *  live destroyed-sprite (image+100); not persisted (the LOOTER id is). */
function setLooter(v: string): void {
  patch({ looter: v, looted: v !== NEUTRAL });
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
      <SpriteThumb v-if="headerSpriteKey" :sprite-key="headerSpriteKey" :size="34" class="ins-icon" />
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
          <ImagePicker :object-id="obj.id" :key-fn="chestImageKey" :count="8" />
        </div>
        <div class="row">
          <label>Приоритет ИИ</label>
          <el-input-number :model-value="obj.priority ?? 3" :min="0" :max="6" size="small" controls-position="right" @change="(v: number) => patch({ priority: v ?? 0 })" />
        </div>
        <div class="ro-block">
          <div class="ro-label">Предметы <span class="muted">({{ chestItems.length }})</span></div>
          <div v-if="chestItems.length" class="items-list">
            <div v-for="(it, i) in chestItems" :key="it.key" class="item-line">
              <ItemIcon :id="it.template" :cat="itemStore.get(it.template)?.cat ?? -1" :size="24" />
              <span class="item-name" :title="it.name">{{ it.name }}</span>
              <span v-if="itemStore.get(it.template)?.gold" class="item-gold">{{ itemStore.get(it.template)?.gold }}</span>
              <span class="item-acts">
                <el-button class="item-act" size="small" text :disabled="i === 0" title="Выше" @click="chestMoveItem(it.idx, -1)">↑</el-button>
                <el-button class="item-act" size="small" text :disabled="i === chestItems.length - 1" title="Ниже" @click="chestMoveItem(it.idx, 1)">↓</el-button>
                <el-button class="item-act" size="small" text :icon="Delete" title="Убрать" @click="chestRemoveItem(it.idx)" />
              </span>
            </div>
          </div>
          <div v-else class="muted sm">пусто</div>
          <ItemPicker class="item-add" trigger-label="+ Добавить предмет" title="Добавить предмет в сундук" @pick="chestAddItem" />
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
          <ImagePicker :object-id="obj.id" :key-fn="ruinImageKey" :count="40" />
        </div>
        <div class="row">
          <label>Приоритет ИИ</label>
          <el-input-number :model-value="obj.priority ?? 3" :min="0" :max="6" size="small" controls-position="right" @change="(v: number) => patch({ priority: v ?? 0 })" />
        </div>
        <div v-if="reward" class="ro-block">
          <div class="ro-label">Награда (золото и мана)</div>
          <div class="reward-edit">
            <div v-for="r in reward" :key="r.k" class="rw-edit">
              <SpriteThumb :sprite-key="REWARD_CRYSTAL[r.k]" :size="20" :title="r.label" />
              <span class="rw-lbl">{{ r.label }}</span>
              <el-input-number :model-value="r.v" :min="0" :max="9999" size="small" controls-position="right" @change="(v: number) => setReward(r.k, v)" />
            </div>
          </div>
        </div>
        <div class="col">
          <label>Артефакт</label>
          <ItemPicker
            :model-value="obj.item ?? NEUTRAL"
            nullable
            title="Артефакт руины"
            @update:model-value="(v: string | null) => patch({ item: v || NEUTRAL })"
          />
        </div>
        <div class="row">
          <label>Разграблена</label>
          <el-select :model-value="obj.looter ?? NEUTRAL" size="small" class="owner-sel" @change="setLooter">
            <el-option label="Нет" :value="NEUTRAL" />
            <el-option v-for="p in players" :key="p.id" :label="p.label" :value="p.id" />
          </el-select>
        </div>
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

      <!-- 🏰 CAPITAL (столица) -->
      <template v-else-if="obj.type === 'capital'">
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
          <label>Приоритет ИИ</label>
          <el-input-number :model-value="obj.priority ?? 3" :min="0" :max="6" size="small" controls-position="right" @change="(v: number) => patch({ priority: v ?? 0 })" />
        </div>
      </template>

      <!-- 🏪 SITE (торговец / маг / тренер / наёмники) -->
      <template v-else-if="SITE_TYPES.includes(obj.type)">
        <div class="col">
          <label>Название</label>
          <el-input :model-value="obj.name" size="small" placeholder="без имени" @change="(v: string) => patch({ name: v })" />
        </div>
        <div class="row">
          <label>Картинка</label>
          <ImagePicker :object-id="obj.id" :key-fn="siteImageKey" :count="20" />
        </div>

        <!-- Торговец: список товаров (предмет + количество) -->
        <div v-if="obj.type === 'merchant'" class="ro-block">
          <div class="ro-label">Товары <span class="muted">({{ merchantItems.length }})</span></div>
          <div v-if="merchantItems.length" class="items-list">
            <div v-for="(it, i) in merchantItems" :key="`${it.id}#${i}`" class="item-line">
              <ItemIcon :id="it.id" :cat="itemStore.get(it.id)?.cat ?? -1" :size="24" />
              <span class="item-name" :title="itemStore.nameOf(it.id) || it.id">{{ itemStore.nameOf(it.id) || it.id }}</span>
              <el-input-number
                :model-value="it.count"
                :min="1"
                :max="99"
                size="small"
                controls-position="right"
                class="qty-input"
                @change="(v: number) => merchantSetCount(i, v)"
              />
              <el-button class="item-act" size="small" text :icon="Delete" title="Убрать" @click="merchantRemove(i)" />
            </div>
          </div>
          <div v-else class="muted sm">пусто</div>
          <ItemPicker class="item-add" trigger-label="+ Добавить товар" title="Добавить товар торговцу" @pick="merchantAddItem" />
        </div>

        <!-- Маг: список заклинаний -->
        <div v-else-if="obj.type === 'mage'" class="ro-block">
          <div class="ro-label">Заклинания <span class="muted">({{ mageSpells.length }})</span></div>
          <div v-if="mageSpells.length" class="items-list">
            <div v-for="(sid, i) in mageSpells" :key="`${sid}#${i}`" class="item-line">
              <SpellIcon :id="sid" :level="spellStore.get(sid)?.level" :cat="spellStore.get(sid)?.cat ?? -1" :size="26" />
              <span class="stk-text">
                <span class="item-name" :title="spellStore.get(sid)?.desc || spellStore.nameOf(sid) || sid">{{ spellStore.nameOf(sid) || sid }}</span>
                <span class="stk-sub">{{ spellStore.effectOf(sid) }}</span>
              </span>
              <span v-if="spellStore.get(sid)?.level" class="item-gold">ур.{{ spellStore.get(sid)?.level }}</span>
              <el-button class="item-act" size="small" text :icon="Delete" title="Убрать" @click="mageRemove(i)" />
            </div>
          </div>
          <div v-else class="muted sm">пусто</div>
          <SpellPicker class="item-add" trigger-label="+ Добавить заклинание" title="Добавить заклинание магу" @pick="mageAddSpell" />
        </div>

        <!-- Наёмники: список юнитов (юнит + уровень + уникальность) -->
        <div v-else-if="obj.type === 'mercenary'" class="ro-block">
          <div class="ro-label">Наёмники <span class="muted">({{ mercUnits.length }})</span></div>
          <div v-if="mercUnits.length" class="merc-list">
            <div v-for="(u, i) in mercUnits" :key="`${u.id}#${i}`" class="merc-line">
              <UnitIcon :id="u.id" :level="u.level" :subrace-id="unitStore.get(u.id)?.subraceId ?? -1" :size="26" />
              <span class="item-name" :title="unitStore.get(u.id)?.desc || unitStore.nameOf(u.id) || u.id">{{ unitStore.nameOf(u.id) || u.id }}</span>
              <el-input-number
                :model-value="u.level"
                :min="1"
                :max="50"
                size="small"
                controls-position="right"
                class="qty-input"
                title="Уровень"
                @change="(v: number) => mercSetLevel(i, v)"
              />
              <el-checkbox
                :model-value="u.unique"
                size="small"
                title="Уникальный (нанимается один раз)"
                @change="(v: boolean) => mercSetUnique(i, v)"
              >★</el-checkbox>
              <el-button class="item-act" size="small" text :icon="Delete" title="Убрать" @click="mercRemove(i)" />
            </div>
          </div>
          <div v-else class="muted sm">пусто</div>
          <UnitPicker class="item-add" trigger-label="+ Добавить наёмника" title="Добавить наёмника в лагерь" @pick="mercAddUnit" />
        </div>
      </template>

      <!-- ⚔ STACK (отряд) -->
      <template v-else-if="obj.type === 'stack'">
        <div class="row">
          <label>Владелец</label>
          <el-select :model-value="obj.owner ?? NEUTRAL" size="small" class="owner-sel" @change="(v: string) => patch({ owner: v })">
            <el-option label="Нейтрал" :value="NEUTRAL" />
            <el-option v-for="p in players" :key="p.id" :label="p.label" :value="p.id" />
          </el-select>
        </div>
        <div class="row">
          <label>Приказ</label>
          <el-select :model-value="obj.order ?? 1" size="small" class="owner-sel" @change="(v: number) => patch({ order: v })">
            <el-option v-for="o in ORDER_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </div>
        <div v-if="obj.facing !== undefined" class="row">
          <label>Направление</label>
          <el-input-number :model-value="obj.facing" :min="0" :max="7" size="small" controls-position="right" @change="(v: number) => patch({ facing: v ?? 0 })" />
        </div>
        <div v-if="obj.morale !== undefined" class="row">
          <label>Мораль</label>
          <el-input-number :model-value="obj.morale" size="small" controls-position="right" @change="(v: number) => patch({ morale: v ?? 0 })" />
        </div>
        <div v-if="obj.move !== undefined" class="row">
          <label>Ход</label>
          <el-input-number :model-value="obj.move" :min="0" size="small" controls-position="right" @change="(v: number) => patch({ move: v ?? 0 })" />
        </div>
        <div v-if="obj.priority !== undefined" class="row">
          <label>Приоритет ИИ</label>
          <el-input-number :model-value="obj.priority" :min="0" :max="6" size="small" controls-position="right" @change="(v: number) => patch({ priority: v ?? 0 })" />
        </div>

        <div class="section-head">Состав отряда <span class="muted">({{ stackCount }}/6)</span></div>
        <GarrisonEditor
          :garrison="stackGarrison"
          :count="stackCount"
          :leader-cell="stackLeaderCell"
          @set-unit="setStackUnit"
          @clear="clearStackCell"
          @set-stat="setStackStat"
          @set-leader="setStackLeader"
        />

        <div class="section-head">Экипировка лидера</div>
        <div class="equip-grid">
          <div v-for="s in EQUIP_SLOTS" :key="s.key" class="equip-row">
            <label>{{ s.label }}</label>
            <ItemPicker :model-value="equipVal(s.key)" nullable :title="s.label" @update:model-value="(v: string | null) => setStackEquip(s.key, v)" />
          </div>
        </div>

        <div class="ro-block">
          <div class="ro-label">Инвентарь <span class="muted">({{ (obj.inventory ?? []).length }})</span></div>
          <div v-if="(obj.inventory ?? []).length" class="items-list">
            <div v-for="(it, i) in obj.inventory" :key="`${it}#${i}`" class="item-line">
              <ItemIcon :id="it" :cat="itemStore.get(it)?.cat ?? -1" :size="22" />
              <span class="item-name" :title="itemStore.nameOf(it) || it">{{ itemStore.nameOf(it) || it }}</span>
            </div>
          </div>
          <div v-else class="muted sm">пусто</div>
        </div>
      </template>

      <!-- 💎 CRYSTAL (кристалл маны) -->
      <template v-else-if="obj.type === 'crystal'">
        <div class="row">
          <label>Тип маны</label>
          <el-select :model-value="obj.resource ?? 0" size="small" class="owner-sel" @change="(v: number) => patch({ resource: v })">
            <el-option v-for="(lbl, i) in CRYSTAL_LABELS" :key="i" :label="lbl" :value="i" />
          </el-select>
        </div>
      </template>

      <!-- 🛡 DOUBLE GARRISON (city defense + visiting hero) — shared by city + capital -->
      <template v-if="obj.type === 'village' || obj.type === 'capital'">
        <div class="section-head">Оборона города <span class="muted">({{ defenseCount }}/6)</span></div>
        <GarrisonEditor
          :garrison="defenseGarrison"
          :count="defenseCount"
          @set-unit="(c, u) => setGarrisonUnitOn(obj.id, defenseGarrison, c, u)"
          @clear="(c) => clearGarrisonCellOn(obj.id, defenseGarrison, c)"
          @set-stat="(c, k, v) => setGarrisonStatOn(obj.id, defenseGarrison, c, k, v)"
        />
        <div class="section-divider" />
        <div class="section-head">
          Гость (герой)
          <span class="muted">{{ visitorStack ? `(${visitorCount}/6)` : "— нет —" }}</span>
        </div>
        <GarrisonEditor v-if="visitorStack" :garrison="visitorGarrison" :count="visitorCount" readonly />
        <p v-else class="muted sm">В городе нет гостящего героя. Добавление гостя — в редакторе отряда.</p>
        <p v-if="visitorStack" class="muted xs">Редактирование гостя — в свойствах отряда (скоро).</p>
      </template>

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
  grid-template-columns: 1fr;
  gap: 4px;
}
.rw-edit {
  display: flex;
  align-items: center;
  gap: 4px;
}
.rw-lbl {
  flex: 1 1 auto;
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
.section-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  margin-top: var(--d2-sp-2, 8px);
}
.section-divider {
  border-top: var(--d2-hairline, 1px solid var(--el-border-color-lighter));
  margin: var(--d2-sp-2, 8px) 0 0;
}
.equip-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 4px;
}
.equip-row {
  display: flex;
  align-items: center;
  gap: var(--d2-sp-2);
}
.equip-row label {
  flex: 0 0 84px;
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.equip-row :deep(.ip-wrap) {
  flex: 1 1 auto;
  min-width: 0;
}
.equip-row :deep(.ip-trigger) {
  width: 100%;
}
.xs {
  font-size: 10px;
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
.items-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
}
.item-line {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 4px;
}
.item-line:hover {
  background: var(--el-fill-color-light);
}
.item-name {
  flex: 1 1 auto;
  font-size: 12px;
  color: var(--el-text-color-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stk-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.stk-text .item-name {
  flex: 0 0 auto;
}
.stk-sub {
  font-size: 10px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-gold {
  flex: 0 0 auto;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--el-color-warning);
}
.item-acts {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
}
.item-act {
  padding: 0 3px;
  min-height: 22px;
  height: 22px;
}
.item-add {
  margin-top: 6px;
}
.qty-input {
  flex: 0 0 auto;
}
.qty-input :deep(.el-input-number) {
  width: 72px;
}
.qty-input.el-input-number {
  width: 72px;
}
.merc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
}
.merc-line {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 4px;
}
.merc-line:hover {
  background: var(--el-fill-color-light);
}
.merc-line :deep(.el-checkbox) {
  flex: 0 0 auto;
  margin-right: 0;
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
