<script setup lang="ts">
/**
 * Object property inspector. Shows the selected object's properties and edits them via an
 * undoable patchObject — every field (scalars, name/desc/reward strings, item + garrison
 * lists, owner/subrace) persists through the from-model export (serializeMapFromModelBytes).
 * Scope: chests / ruins / cities / capitals / sites / stacks / crystals / decor / locations.
 */
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { ElMessage } from "element-plus";
import { Close, Delete } from "@element-plus/icons-vue";
import { placeVisitorOps } from "@d2/map-edit";
import { useToolStore } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";
import { useItemStore } from "../stores/itemStore";
import { useUnitStore } from "../stores/unitStore";
import { useSpellStore } from "../stores/spellStore";
import { useDecorStore } from "../stores/decorStore";
import { useEventStore } from "../stores/eventStore";
import { useViewStore } from "../stores/viewStore";
import { useCollabStore } from "../stores/collabStore";
import { computeObjectRoles, ROLE_META, type ObjectRole } from "../services/scenarioRoles";
import DecorThumb from "./DecorThumb.vue";
import ThumbPreview from "./ThumbPreview.vue";
import type { DecorThumb as DecorThumbRect } from "../stores/decorStore";
import ItemPicker from "./ItemPicker.vue";
import ItemIcon from "./ItemIcon.vue";
import UnitPicker from "./UnitPicker.vue";
import UnitIcon from "./UnitIcon.vue";
import SpellPicker from "./SpellPicker.vue";
import SpellIcon from "./SpellIcon.vue";
import GarrisonEditor from "./GarrisonEditor.vue";
import EventSummaryCard from "./EventSummaryCard.vue";
import ImagePicker from "./ImagePicker.vue";
import SpriteThumb from "./SpriteThumb.vue";
import RegionPreview from "./RegionPreview.vue";
import { useSpriteStore } from "../stores/spriteStore";

/** RuinObjectAccessor sprite key: "G000RU0000" + image(3) (base look; looted adds +100). */
const ruinImageKey = (i: number): string => `G000RU0000${String(i).padStart(3, "0")}`;

const toolStore = useToolStore();
const editStore = useEditStore();
const itemStore = useItemStore();
const unitStore = useUnitStore();
const spellStore = useSpellStore();
const decorStore = useDecorStore();
const eventStore = useEventStore();
const viewStore = useViewStore();
const collabStore = useCollabStore();
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
  if (!decorStore.loaded && !decorStore.loading) void decorStore.load();
  rolesExpanded.value = false; // collapse the «Сценарий» list when the selection changes
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
  () => !!obj.value && ["treasure", "ruin", "village", "capital", "crystal", "stack", "location",
    "rod", "landmark", "mountains", ...SITE_TYPES].includes(obj.value.type),
);

/** MidLocation radius is a size step r → a (2r+1)×(2r+1) cell square. */
const locationSpan = (r: number): string => `${2 * r + 1}×${2 * r + 1} клеток`;

/** Границы области выбранной локации для превью «Точка на карте». */
const locPreviewBounds = computed(() => {
  const o = obj.value;
  if (o?.type !== "location") return null;
  const r = o.radius ?? 0;
  return { x0: o.pos.x - r, y0: o.pos.y - r, x1: o.pos.x + r, y1: o.pos.y + r };
});
/** Если локация — примитив ЗОНЫ, превью подсвечивает всю маску зоны (зона = набор локаций). */
const locZoneCells = computed<readonly string[] | null>(() => {
  const o = obj.value;
  if (o?.type !== "location") return null;
  for (const z of Object.values(editStore.zones)) {
    if (z.locIds.includes(o.id)) return z.cells;
  }
  return null;
});

/** ── Decor (landmark / mountains): appearance = a decorCatalog variant. Show name/footprint +
 *  cycle/re-roll the look (the catalog groups interchangeable variants). */
const decorVariantId = computed(() =>
  obj.value && (obj.value.type === "landmark" || obj.value.type === "mountains")
    ? decorStore.catalogIdOf(obj.value)
    : null,
);
const decorEntry = computed(() => decorStore.get(decorVariantId.value));
const decorGroup = computed(() => decorStore.groupOf(decorVariantId.value));
const decorVariantCount = computed(() => decorGroup.value?.variants.length ?? 0);
/** Human decoration name: RU game name → group label; the raw G000MG#### id lives in tooltips only. */
const decorName = computed(() => decorEntry.value?.name_ru || decorGroup.value?.label || "—");
/** Apply a specific look (thumbnail-strip click) to the placed decor object. */
function pickVariant(id: string): void {
  if (obj.value) { const p = decorStore.variantPatch(obj.value, id); if (p) patch(p); }
}
function rerollDecor(): void {
  const r = decorStore.randomVariant(decorVariantId.value);
  if (r && obj.value) { const p = decorStore.variantPatch(obj.value, r); if (p) patch(p); }
}

// hover-zoom for the narrow inspector strip (shared floating preview, see ThumbPreview.vue)
const decorPreview = ref<InstanceType<typeof ThumbPreview> | null>(null);
function showDecorPreview(e: MouseEvent, thumb: DecorThumbRect, name: string): void {
  decorPreview.value?.show(e.currentTarget as HTMLElement, thumb, name);
}
function hideDecorPreview(): void {
  decorPreview.value?.hide();
}

/** ── «Сценарий»: the selected object's scenario roles (trigger/spawn/destination/env), from
 *  the shared scenarioRoles model — recomputed on every liveDoc change. One clickable row per
 *  wiring; click = jump to that event in the scenario window (opening it if closed). */
const ROLE_LIMIT = 6;
const rolesExpanded = ref(false);
const objectRoles = computed<ObjectRole[]>(() => {
  const doc = editStore.liveDoc;
  if (!doc || !obj.value) return [];
  return computeObjectRoles(doc).get(obj.value.id) ?? [];
});
const visibleRoles = computed<ObjectRole[]>(() =>
  rolesExpanded.value ? objectRoles.value : objectRoles.value.slice(0, ROLE_LIMIT));
function openRole(r: ObjectRole): void {
  eventStore.navigate({ tab: "events", eventId: r.ev.id, fromLink: true });
  if (!viewStore.eventPanelVisible) viewStore.toggleEventPanel();
}
/** Object types the event editor can seed a trigger for (eventStore.OBJ_CONDITION). */
const EVENTABLE_TYPES = new Set([
  "location", "stack", "village", "capital", "ruin", "merchant", "mage", "trainer", "mercenary",
]);
const canCreateEventFor = computed(() => !!obj.value && EVENTABLE_TYPES.has(obj.value.type));
function newEventForObject(): void {
  if (!obj.value) return;
  const o = obj.value as { id: string; type: string; name?: string };
  const ev = eventStore.createForObject(o.id, o.type, o.name);
  if (ev) {
    eventStore.select(ev.id);
    if (!viewStore.eventPanelVisible) viewStore.toggleEventPanel();
  }
}

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

/** Grace.dbf RACE_ID index → race name (base-game constant, read from Grace.dbf).
 *  A player IS its race (1:1, unique per scenario) — the owner must read as the race,
 *  not the author's free-form NAME_TXT lord name (which can be anything, e.g. "Разведчик"
 *  on an undead player). */
const GRACE_RACE_NAMES: Record<number, string> = {
  0: "Империя", 1: "Кланы Гор", 2: "Легионы Проклятых", 3: "Орды Нежити", 4: "Нейтрал", 5: "Эльфийский Союз",
};

/** Players for the owner dropdown (id is the full compound uid = the stored OWNER value).
 *  Label leads with the unique RACE; the custom lord name follows only as context. */
const NEUTRAL = "G000000000";
const players = computed(() =>
  (editStore.liveDoc?.players ?? []).map((p) => {
    const race = GRACE_RACE_NAMES[p.race] ?? `Раса ${p.race}`;
    return { id: p.id, label: p.name && p.name !== race ? `${race} — ${p.name}` : race };
  }),
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

/** ── City loot: a village/capital's stored ITEM_ID list (same shape as a chest — global GItem
 *  template ids; a capital seeds 3× starter items). Reuses the chest list row UI. */
const cityLoot = computed<string[]>(() => {
  const o = obj.value;
  return o && (o.type === "village" || o.type === "capital") ? o.items ?? [] : [];
});
function cityAddItem(template: string): void {
  const o = obj.value;
  if (o?.type !== "village" && o?.type !== "capital") return;
  patch({ items: [...(o.items ?? []), template] });
}
function cityRemoveItem(idx: number): void {
  const o = obj.value;
  if (o?.type !== "village" && o?.type !== "capital") return;
  patch({ items: (o.items ?? []).filter((_, i) => i !== idx) });
}

/** ── Garrisons. A city/capital has TWO armies (verified vs toolsqt + Riders bytes):
 *  • DEFENSE — the city's OWN embedded UNIT_/POS_ formation (editable here, on the city id);
 *  • VISITOR — a separate hero MidStack stationed inside (city.stackRef → that stack). Shown
 *    read-only for now; full editing comes with the Отряд (stack) editor. Each cell = a global
 *    Gunit id + level + HP; the writer re-creates the MidUnit instances + UNIT_/POS_ slots. */
// FULL entity copy: a member carries xp/name/creation/modifiers/key/slot beyond
// unit/level/hp — stripping them here used to WIPE veteran data on any garrison edit
// (patchObject replaces the whole array; nothing merges it back).
type GarrUnit = { unit: string; level: number; hp: number; modifiers?: string[] };
function garr6(o: { garrison?: (GarrUnit | null)[] } | null | undefined): (GarrUnit | null)[] {
  const out: (GarrUnit | null)[] = [null, null, null, null, null, null];
  (o?.garrison ?? []).forEach((c, i) => { if (c && i < 6) out[i] = { ...c }; });
  return out;
}
/** the visiting hero stack stationed inside this city (city.stackRef → a MidStack), if any */
const visitorStack = computed(() => {
  const o = obj.value;
  const ref = o && (o.type === "capital" || o.type === "village") ? o.stackRef : undefined;
  const s = ref ? editStore.liveDoc?.objects.find((x) => x.id === ref) : undefined;
  return s && s.type === "stack" ? s : null;
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
/** Cells occupied by the SAME entity as `cell`. A BIG (2-cell) unit is ONE unit spanning two
 *  garrison cells that share one identity (`key`); a per-cell edit/clear must hit them ALL, or the
 *  model splits into an inconsistent pair (one unit, two levels) that the serializer collapses back
 *  — silently dropping the edit, which the export's semantic round-trip then rejects. Falls back to
 *  just `cell` for a keyless (freshly-placed, not-yet-serialized) unit. */
function entityCells(g: (GarrUnit | null)[], cell: number): number[] {
  const key = (g[cell] as { key?: string } | null)?.key;
  if (!key) return [cell];
  const out: number[] = [];
  g.forEach((x, i) => { if (x && (x as { key?: string }).key === key) out.push(i); });
  return out.length ? out : [cell];
}
function clearGarrisonCellOn(targetId: string, cur: (GarrUnit | null)[], cell: number): void {
  const g = cur.map((c) => (c ? { ...c } : null));
  for (const i of entityCells(g, cell)) g[i] = null; // clear the whole big unit, not half of it
  commitGarrison(targetId, g);
}
function setGarrisonStatOn(targetId: string, cur: (GarrUnit | null)[], cell: number, key: "level" | "hp", v: number): void {
  const g = cur.map((c) => (c ? { ...c } : null));
  if (!g[cell]) return;
  const nv = Math.max(0, Math.round(v || 0));
  for (const i of entityCells(g, cell)) g[i] = { ...(g[i] as GarrUnit), [key]: nv }; // keep both cells of a big unit in sync
  commitGarrison(targetId, g);
}
/** unit-with-updated-modifiers; the key is DELETED when the list empties (an explicit
 *  undefined would survive JSON.stringify-free paths and confuse deep-equality). */
function withMods(c: GarrUnit, mods: string[]): GarrUnit {
  const next = { ...c };
  if (mods.length) next.modifiers = mods.slice();
  else delete next.modifiers;
  return next;
}
function setGarrisonModsOn(targetId: string, cur: (GarrUnit | null)[], cell: number, mods: string[]): void {
  const g = cur.map((c) => (c ? { ...c } : null));
  if (!g[cell]) return;
  for (const i of entityCells(g, cell)) g[i] = withMods(g[i] as GarrUnit, mods); // both cells of a big unit
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

/** ── Merchant BUY_* — which item categories the merchant buys back (omitted = all true). Index
 *  order is FROZEN (schema/parser/writer agree): armor/jewel/weapon/banner/potion/scroll/wand/value. */
const BUY_LABELS = ["Броня", "Драгоценности", "Оружие", "Штандарты", "Зелья", "Свитки", "Жезлы", "Ценности"];
const merchantBuy = computed<boolean[]>(() => {
  const o = obj.value;
  const buy = o?.type === "merchant" ? o.buy : undefined;
  return BUY_LABELS.map((_, i) => buy?.[i] ?? true);
});
function setMerchantBuy(i: number, v: boolean): void {
  if (obj.value?.type !== "merchant") return;
  const next = merchantBuy.value.slice();
  next[i] = v;
  patch({ buy: next });
}

/** ── Stack («Отряд»): formation (with leader) + order + leader equipment + inventory.
 *  Editing the formation rewrites UNIT_/POS_ (new MidUnit instances) + LEADER_ID; we always send
 *  garrison + leaderCell + the recomputed leaderImage so the live doc + writer stay in sync. */
const ORDER_OPTIONS = [
  { value: 1, label: "Обычный" }, { value: 2, label: "Стоять" }, { value: 3, label: "Охранять" },
  { value: 4, label: "Атаковать" }, { value: 7, label: "Бродить" }, { value: 8, label: "Идти" },
  { value: 9, label: "Защищать" }, { value: 10, label: "Берсерк" },
];
// Leader equipment: which ItemCat (LmagItm category number) each slot accepts, per the game.
//   0,2 армор/оружие → артефакты · 1 реликвия · 3 знамя · 13 сапоги
//   4,5,6,7,11,12 зелья/сфера/талисман → боевые (в руки) · 8,9,10,14 не надеваются
// The "tome" KEY maps to the .sg TOME field, but that slot functionally holds the RELIC (jewel).
const ARTIFACT_CATS = [0, 2]; // армор + оружие
const BATTLE_CATS = [4, 5, 6, 7, 11, 12]; // зелья (усил./лечение/воскр./постоянные) + сфера + талисман
const EQUIP_SLOTS = [
  { key: "tome", label: "Реликвия", cats: [1] }, // .sg TOME-поле = слот реликвии (L_JEWEL)
  { key: "battle1", label: "Боевой 1", cats: BATTLE_CATS },
  { key: "battle2", label: "Боевой 2", cats: BATTLE_CATS },
  { key: "artifact1", label: "Артефакт 1", cats: ARTIFACT_CATS },
  { key: "artifact2", label: "Артефакт 2", cats: ARTIFACT_CATS },
  { key: "boots", label: "Сапоги", cats: [13] },
];
const EMPTY_REFS = new Set(["000000", "G000000000"]);
/** Stack banner-item slot (the BANNER field; separate from the faction banner = subRace). */
function bannerVal(): string {
  const b = obj.value?.type === "stack" ? obj.value.banner : undefined;
  return b && !EMPTY_REFS.has(b) ? b : NEUTRAL;
}
function setStackBanner(id: string | null): void {
  if (obj.value?.type !== "stack") return;
  editStore.commit([{ kind: "patchObject", id: obj.value.id, fields: { banner: id && id !== NEUTRAL ? id : "000000" } }]);
}
type StackLike = { id: string; garrison?: (GarrUnit | null)[]; leaderCell?: number } | null | undefined;
const stackGarrison = computed(() => garr6(obj.value?.type === "stack" ? (obj.value as { garrison?: (GarrUnit | null)[] }) : null));
const stackCount = computed(() => stackGarrison.value.filter(Boolean).length);
const stackLeaderCell = computed(() => (obj.value?.type === "stack" ? obj.value.leaderCell ?? -1 : -1));

// Formation editors, parameterized by the target stack — reused by the Отряд section AND the city
// VISITOR (which is itself a linked stack). Editing the formation rewrites UNIT_/POS_ (new MidUnit
// instances) + LEADER_ID; we always send garrison + leaderCell + the recomputed leaderImage.
function commitStackFormation(st: StackLike, g: (GarrUnit | null)[], leaderCell: number): void {
  if (!st) return;
  let lc = leaderCell;
  if (lc < 0 || !g[lc]) {
    // re-crown: PREFER a leader-category unit (герой/вор) — the import validator's rule;
    // fall back to any filled cell only when the formation has no leader-category unit
    // (transient state while assembling — the UI warns below).
    const leaderIdx = g.findIndex((c) => c && unitStore.isLeaderCategory(c.unit));
    lc = leaderIdx >= 0 ? leaderIdx : g.findIndex(Boolean);
  }
  const leaderImage = lc >= 0 ? g[lc]?.unit : undefined;
  if (lc >= 0 && g[lc] && !unitStore.isLeaderCategory(g[lc]!.unit)) {
    ElMessage.warning("В отряде нет героя/вора — игра требует юнита-лидера во главе");
  }
  editStore.commit([{ kind: "patchObject", id: st.id, fields: { garrison: g, leaderCell: lc, leaderImage } }]);
}
function stackSetUnit(st: StackLike, cell: number, unitId: string): void {
  if (!st) return;
  const g = garr6(st).map((c) => (c ? { ...c } : null));
  g[cell] = { unit: unitId, level: 1, hp: unitStore.get(unitId)?.hp ?? 0 };
  commitStackFormation(st, g, st.leaderCell ?? -1);
}
function stackClearCell(st: StackLike, cell: number): void {
  if (!st) return;
  const g = garr6(st).map((c) => (c ? { ...c } : null));
  g[cell] = null;
  commitStackFormation(st, g, st.leaderCell ?? -1);
}
function stackSetStat(st: StackLike, cell: number, key: "level" | "hp", v: number): void {
  if (!st) return;
  const g = garr6(st).map((c) => (c ? { ...c } : null));
  const c = g[cell];
  if (!c) return;
  g[cell] = { ...c, [key]: Math.max(0, Math.round(v || 0)) };
  commitStackFormation(st, g, st.leaderCell ?? -1);
}
function stackSetMods(st: StackLike, cell: number, mods: string[]): void {
  if (!st) return;
  const g = garr6(st).map((c) => (c ? { ...c } : null));
  const c = g[cell];
  if (!c) return;
  g[cell] = withMods(c, mods);
  commitStackFormation(st, g, st.leaderCell ?? -1);
}
function stackSetLeader(st: StackLike, cell: number): void {
  if (!st) return;
  const g = garr6(st);
  // the star button is already disabled for non-leaders — this is the belt to its braces
  if (!unitStore.isLeaderCategory(g[cell]?.unit)) {
    ElMessage.warning("Вести отряд может только герой или вор (категория лидера)");
    return;
  }
  commitStackFormation(st, g.map((c) => (c ? { ...c } : null)), cell);
}
/** Jump the inspector to the city's visiting hero stack for full editing (order/equip/inventory). */
function openVisitor(): void {
  const o = obj.value;
  const ref = o && (o.type === "capital" || o.type === "village") ? o.stackRef : undefined;
  if (ref) toolStore.setSelectedId(ref);
}
/** Add an (empty) visiting hero stack to this city — a new MidStack linked via STACK/INSIDE. */
function addVisitor(): void {
  const o = obj.value;
  if (!o || (o.type !== "capital" && o.type !== "village") || !editStore.liveDoc) return;
  editStore.commit(placeVisitorOps(editStore.liveDoc, { id: o.id, pos: o.pos, owner: o.owner }, collabStore.idSlot));
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
/** Stack carried inventory — global GItem template ids (MidItem instances re-created on export). */
const stackInventory = computed(() => (obj.value?.type === "stack" ? obj.value.inventory ?? [] : []));
function stackAddItem(template: string): void {
  if (obj.value?.type !== "stack") return;
  editStore.commit([{ kind: "patchObject", id: obj.value.id, fields: { inventory: [...stackInventory.value, template] } }]);
}
function stackRemoveItem(i: number): void {
  if (obj.value?.type !== "stack") return;
  editStore.commit([{ kind: "patchObject", id: obj.value.id, fields: { inventory: stackInventory.value.filter((_, k) => k !== i) } }]);
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

/** Change a city/stack owner; ALSO keep SUBRACE consistent (it drives the banner + the faction of
 *  units the fort produces) and refresh the live race/banner sprite. A fort whose SUBRACE belongs to
 *  a different player than its OWNER is an inconsistent .sg (wrong banner in-game). We reassign
 *  subRace only when the CURRENT one isn't already owned by the new owner (so a deliberate neutral-
 *  faction pick survives re-selecting the same owner). race/bannerIndex are DERIVED (live render
 *  only; the byte writer skips them). */
function setOwner(v: string): void {
  const fields: Record<string, number | string> = { owner: v };
  const subs = editStore.liveDoc?.subraces ?? [];
  const player = (editStore.liveDoc?.players ?? []).find((p) => p.id === v);
  if (player?.race !== undefined) fields.race = player.race;
  const cur = (obj.value as { subRace?: string } | null)?.subRace;
  if (!subs.some((s) => s.id === cur && s.playerId === v)) {
    const sr = subs.find((s) => s.playerId === v);
    if (sr) { fields.subRace = sr.id; fields.bannerIndex = sr.banner; }
  }
  patch(fields);
}

/** LSubRace enum → RU faction name (base-game order; the neutral player owns 5..13, real factions
 *  1..4/6). Falls back to the raw enum for unknown values. Used to label the banner picker. */
const SUBRACE_NAMES: Record<number, string> = {
  0: "Нейтралы", 1: "Империя", 2: "Нежить", 3: "Легионы", 4: "Кланы", 5: "Болотные",
  6: "Эльфы", 7: "Мертвецы", 8: "Гоблины", 9: "Люди", 10: "Гномы", 11: "Драконы",
  12: "Стражи", 13: "Прочие",
};
const subraceLabel = (n: number): string => SUBRACE_NAMES[n] ?? `Фракция ${n}`;

/** Subraces owned by the selected object's OWNER — the faction/banner options for a fort/stack.
 *  A real faction player owns exactly ONE (so setOwner auto-sets it, picker hidden); the NEUTRAL
 *  player owns several (swamp/greenskins/…), so the picker lets the author choose the banner. */
const subraceOptions = computed(() => {
  const owner = (obj.value as { owner?: string } | null)?.owner;
  if (!owner) return [] as { id: string; banner: number; label: string }[];
  return (editStore.liveDoc?.subraces ?? [])
    .filter((s) => s.playerId === owner)
    .map((s) => ({ id: s.id, banner: s.banner, label: subraceLabel(s.subrace) }));
});
function setSubRace(v: string): void {
  const sr = (editStore.liveDoc?.subraces ?? []).find((s) => s.id === v);
  patch(sr ? { subRace: v, bannerIndex: sr.banner } : { subRace: v }); // bannerIndex derived (render)
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
  <div v-if="obj" class="inspector d2-rail">
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
          <div class="d2-sec">Предметы <span class="muted">({{ chestItems.length }})</span></div>
          <div v-if="chestItems.length" class="items-list">
            <div v-for="(it, i) in chestItems" :key="it.key" class="item-line d2-row">
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
          <div class="d2-sec">Награда (золото и мана)</div>
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
        <!-- Стражи руины — embedded GROUP_ID + UNIT_/POS_ (like a fort's defense); soldiers only. -->
        <div class="d2-sec">Стражи <span class="muted">({{ defenseCount }}/6)</span></div>
        <GarrisonEditor
          :garrison="defenseGarrison"
          :count="defenseCount"
          roster="soldiers"
          @set-unit="(c, u) => setGarrisonUnitOn(obj.id, defenseGarrison, c, u)"
          @clear="(c) => clearGarrisonCellOn(obj.id, defenseGarrison, c)"
          @set-stat="(c, k, v) => setGarrisonStatOn(obj.id, defenseGarrison, c, k, v)"
          @set-mods="(c, m) => setGarrisonModsOn(obj.id, defenseGarrison, c, m)"
        />
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
        <div v-if="obj.desc !== undefined" class="col">
          <label>Описание</label>
          <el-input :model-value="obj.desc" type="textarea" :rows="2" size="small" placeholder="текст при посещении" @change="(v: string) => patch({ desc: v })" />
        </div>
        <div class="row">
          <label>Приоритет ИИ</label>
          <el-input-number :model-value="obj.aiPriority ?? 0" :min="0" :max="6" size="small" controls-position="right" @change="(v: number) => patch({ aiPriority: v ?? 0 })" />
        </div>

        <!-- Торговец: список товаров (предмет + количество) -->
        <div v-if="obj.type === 'merchant'" class="ro-block">
          <div class="d2-sec">Товары <span class="muted">({{ merchantItems.length }})</span></div>
          <div v-if="merchantItems.length" class="items-list">
            <div v-for="(it, i) in merchantItems" :key="`${it.id}#${i}`" class="item-line d2-row">
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

        <!-- Торговец: что скупает (BUY_*) + флаг задания (MISSION) -->
        <div v-if="obj.type === 'merchant'" class="ro-block">
          <div class="d2-sec">Скупка <span class="muted">(категории, что торговец покупает)</span></div>
          <div class="buy-grid">
            <el-checkbox
              v-for="(lbl, i) in BUY_LABELS" :key="lbl" :model-value="merchantBuy[i]" size="small"
              @change="(v: boolean) => setMerchantBuy(i, v)"
            >{{ lbl }}</el-checkbox>
          </div>
          <div class="row">
            <label>Задание</label>
            <el-switch :model-value="!!obj.mission" size="small" @change="(v: boolean) => patch({ mission: v })" />
          </div>
        </div>

        <!-- Маг: список заклинаний -->
        <div v-else-if="obj.type === 'mage'" class="ro-block">
          <div class="d2-sec">Заклинания <span class="muted">({{ mageSpells.length }})</span></div>
          <div v-if="mageSpells.length" class="items-list">
            <div v-for="(sid, i) in mageSpells" :key="`${sid}#${i}`" class="item-line d2-row">
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
          <div class="d2-sec">Наёмники <span class="muted">({{ mercUnits.length }})</span></div>
          <div v-if="mercUnits.length" class="merc-list">
            <div v-for="(u, i) in mercUnits" :key="`${u.id}#${i}`" class="merc-line d2-row">
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
        <div class="row">
          <label>Флаги</label>
          <el-checkbox :model-value="!!obj.invisible" size="small" title="Отряд скрыт от игроков на карте" @change="(v: boolean) => patch({ invisible: v })">Невидим</el-checkbox>
          <el-checkbox :model-value="!!obj.aiIgnore" size="small" title="ИИ не реагирует на этот отряд" @change="(v: boolean) => patch({ aiIgnore: v })">ИИ игнорирует</el-checkbox>
        </div>

        <div class="d2-sec">Состав отряда <span class="muted">({{ stackCount }}/6)</span></div>
        <GarrisonEditor
          :garrison="stackGarrison"
          :count="stackCount"
          :leader-cell="stackLeaderCell"
          @set-unit="(c, u) => stackSetUnit(obj, c, u)"
          @clear="(c) => stackClearCell(obj, c)"
          @set-stat="(c, k, v) => stackSetStat(obj, c, k, v)"
          @set-leader="(c) => stackSetLeader(obj, c)"
          @set-mods="(c, m) => stackSetMods(obj, c, m)"
        />

        <div class="d2-sec">Экипировка лидера</div>
        <div class="equip-grid">
          <div class="equip-row">
            <label>Знамя</label>
            <ItemPicker :model-value="bannerVal()" nullable title="Знамя" :allow-cats="[3]" @update:model-value="(v: string | null) => setStackBanner(v)" />
          </div>
          <div v-for="s in EQUIP_SLOTS" :key="s.key" class="equip-row">
            <label>{{ s.label }}</label>
            <ItemPicker :model-value="equipVal(s.key)" nullable :title="s.label" :allow-cats="s.cats" @update:model-value="(v: string | null) => setStackEquip(s.key, v)" />
          </div>
        </div>

        <div class="ro-block">
          <div class="d2-sec">Инвентарь <span class="muted">({{ stackInventory.length }})</span></div>
          <div v-if="stackInventory.length" class="items-list">
            <div v-for="(it, i) in stackInventory" :key="`${it}#${i}`" class="item-line d2-row">
              <ItemIcon :id="it" :cat="itemStore.get(it)?.cat ?? -1" :size="24" />
              <span class="item-name" :title="itemStore.nameOf(it) || it">{{ itemStore.nameOf(it) || it }}</span>
              <span v-if="itemStore.get(it)?.gold" class="item-gold">{{ itemStore.get(it)?.gold }}</span>
              <el-button class="item-act" size="small" text :icon="Delete" title="Убрать" @click="stackRemoveItem(i)" />
            </div>
          </div>
          <div v-else class="muted sm">пусто</div>
          <ItemPicker class="item-add" trigger-label="+ Добавить предмет" title="Добавить предмет в инвентарь" @pick="stackAddItem" />
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
        <div class="row">
          <label>Приоритет ИИ</label>
          <el-input-number :model-value="obj.priority ?? 3" :min="0" :max="6" size="small" controls-position="right" @change="(v: number) => patch({ priority: v ?? 0 })" />
        </div>
      </template>

      <!-- 📍 LOCATION (именованная область) -->
      <template v-else-if="obj.type === 'location'">
        <div class="col">
          <label>Точка на карте <span class="muted xs">(рельеф + объекты)</span></label>
          <RegionPreview
            :cell="obj.pos"
            :radius="Math.max(4, (obj.radius ?? 0) + 3)"
            :mark="obj.pos"
            :bounds="locPreviewBounds"
            :cells="locZoneCells"
            zoomable
          />
        </div>
        <div class="col">
          <label>Название</label>
          <el-input :model-value="obj.name" size="small" placeholder="без имени" @change="(v: string) => patch({ name: v })" />
        </div>
        <div class="row">
          <!-- max 3 (7×7) — the native ScenEdit dialog knows exactly 1×1/3×3/5×5/7×7;
               a bigger radius risks breaking the map in the game's own editor -->
          <label>Радиус</label>
          <el-input-number :model-value="obj.radius ?? 0" :min="0" :max="3" size="small" controls-position="right" @change="(v: number) => patch({ radius: v ?? 0 })" />
        </div>
        <div class="ro-row">
          <label>Размер области</label>
          <span class="ro-val">{{ locationSpan(obj.radius ?? 0) }}</span>
        </div>
        <div class="col">
          <label>Подпись на карте <span class="muted xs">(своя, не в .sg)</span></label>
          <!-- live @input (not @change): the label on the canvas updates as you type, and a
               mid-typing re-render can never wipe the draft -->
          <el-input
            :model-value="editStore.captions[obj.id] ?? ''"
            size="small"
            placeholder="опционально"
            @input="(v: string) => editStore.setCaption(obj.id, v)"
          />
        </div>
      </template>

      <!-- 🪄 ROD (жезл власти) -->
      <template v-else-if="obj.type === 'rod'">
        <div class="row">
          <label>Владелец</label>
          <el-select :model-value="obj.owner ?? NEUTRAL" size="small" class="owner-sel" @change="setOwner">
            <el-option label="Нейтрал" :value="NEUTRAL" />
            <el-option v-for="p in players" :key="p.id" :label="p.label" :value="p.id" />
          </el-select>
        </div>
      </template>

      <!-- 🌲 DECOR (декор / горы) — appearance variant -->
      <template v-else-if="obj.type === 'landmark' || obj.type === 'mountains'">
        <div class="decor-head">
          <DecorThumb v-if="decorEntry" :thumb="decorEntry.thumb" :size="48" />
          <div class="decor-info">
            <div class="decor-name" :title="decorVariantId ?? undefined">{{ decorName }}</div>
            <div v-if="decorEntry" class="muted xs">{{ decorEntry.cx }}×{{ decorEntry.cy }} клеток</div>
          </div>
        </div>
        <div v-if="obj.type === 'landmark'" class="col">
          <label>Подпись <span class="muted xs">(имя декорации, DESC_TXT)</span></label>
          <el-input :model-value="obj.desc ?? ''" size="small" placeholder="без имени" @change="(v: string) => patch({ desc: v })" />
        </div>
        <div v-if="decorVariantCount > 1" class="decor-variants-head">
          <span class="d2-sec">Вид <span class="muted">— выберите ({{ decorVariantCount }})</span></span>
          <el-button size="small" text title="Случайный вид" @click="rerollDecor()">⟳</el-button>
        </div>
        <div v-if="decorVariantCount > 1" class="decor-variants">
          <button
            v-for="v in decorGroup!.variants"
            :key="v.id"
            type="button"
            class="dv-cell"
            :class="{ sel: v.id === decorVariantId }"
            :title="v.desc_en || v.name_ru"
            @click="pickVariant(v.id)"
            @mouseenter="showDecorPreview($event, v.thumb, v.name_ru || v.desc_en || decorName)"
            @mouseleave="hideDecorPreview()"
          >
            <DecorThumb :thumb="v.thumb" :size="40" />
          </button>
        </div>
        <ThumbPreview ref="decorPreview" />
      </template>

      <!-- 🏳 FACTION BANNER (subrace) — a fort/stack's SUBRACE drives its banner + produced-unit
           faction. Shown only when the owner owns >1 subrace (the neutral player owns several
           neutral factions); a real faction player owns one, so setOwner auto-sets it. -->
      <div
        v-if="(obj.type === 'village' || obj.type === 'capital' || obj.type === 'stack') && subraceOptions.length > 1"
        class="row"
      >
        <label>Знамя</label>
        <el-select :model-value="obj.subRace" size="small" class="owner-sel" @change="setSubRace">
          <el-option v-for="s in subraceOptions" :key="s.id" :label="s.label" :value="s.id" />
        </el-select>
      </div>

      <!-- 💰 CITY LOOT (stored ITEM_ID list) — shared by city + capital -->
      <div v-if="obj.type === 'village' || obj.type === 'capital'" class="ro-block">
        <div class="d2-sec">Хранилище <span class="muted">({{ cityLoot.length }})</span></div>
        <div v-if="cityLoot.length" class="items-list">
          <div v-for="(it, i) in cityLoot" :key="`${it}#${i}`" class="item-line d2-row">
            <ItemIcon :id="it" :cat="itemStore.get(it)?.cat ?? -1" :size="24" />
            <span class="item-name" :title="itemStore.nameOf(it) || it">{{ itemStore.nameOf(it) || it }}</span>
            <span v-if="itemStore.get(it)?.gold" class="item-gold">{{ itemStore.get(it)?.gold }}</span>
            <el-button class="item-act" size="small" text :icon="Delete" title="Убрать" @click="cityRemoveItem(i)" />
          </div>
        </div>
        <div v-else class="muted sm">пусто</div>
        <ItemPicker class="item-add" trigger-label="+ Добавить предмет" title="Добавить предмет в хранилище города" @pick="cityAddItem" />
      </div>

      <!-- 🛡 DOUBLE GARRISON (city defense + visiting hero) — shared by city + capital -->
      <template v-if="obj.type === 'village' || obj.type === 'capital'">
        <div class="d2-sec">Оборона города <span class="muted">({{ defenseCount }}/6)</span></div>
        <!-- roster=soldiers: гарнизон города — без героев; герой в городе живёт ГОСТЕМ ниже -->
        <GarrisonEditor
          :garrison="defenseGarrison"
          :count="defenseCount"
          roster="soldiers"
          @set-unit="(c, u) => setGarrisonUnitOn(obj.id, defenseGarrison, c, u)"
          @clear="(c) => clearGarrisonCellOn(obj.id, defenseGarrison, c)"
          @set-stat="(c, k, v) => setGarrisonStatOn(obj.id, defenseGarrison, c, k, v)"
          @set-mods="(c, m) => setGarrisonModsOn(obj.id, defenseGarrison, c, m)"
        />
        <div class="section-divider" />
        <div class="d2-sec">
          Гость (герой)
          <span class="muted">{{ visitorStack ? `(${visitorCount}/6)` : "— нет —" }}</span>
          <!-- Столица: гостя-лорда выбирает игрок в игре — не редактируется, только гарнизон -->
          <el-button v-if="visitorStack && obj.type !== 'capital'" class="visitor-open" size="small" text @click="openVisitor">Свойства гостя →</el-button>
        </div>
        <!-- Capital: гость только для просмотра (readonly); Village: полностью редактируемый -->
        <GarrisonEditor
          v-if="visitorStack && obj.type === 'capital'"
          :garrison="visitorGarrison"
          :count="visitorCount"
          readonly
        />
        <GarrisonEditor
          v-else-if="visitorStack"
          :garrison="visitorGarrison"
          :count="visitorCount"
          :leader-cell="(visitorStack.leaderCell ?? -1)"
          @set-unit="(c, u) => stackSetUnit(visitorStack, c, u)"
          @clear="(c) => stackClearCell(visitorStack, c)"
          @set-stat="(c, k, v) => stackSetStat(visitorStack, c, k, v)"
          @set-leader="(c) => stackSetLeader(visitorStack, c)"
          @set-mods="(c, m) => stackSetMods(visitorStack, c, m)"
        />
        <p v-if="obj.type === 'capital'" class="muted sm">Гостя-лорда выбирает игрок в игре — редактируется только оборона.</p>
        <template v-else-if="!visitorStack">
          <p class="muted sm">В городе нет гостящего героя.</p>
          <el-button class="item-add" size="small" @click="addVisitor">+ Добавить гостя</el-button>
        </template>
      </template>

    </div>

    <div v-else class="ins-body">
      <p class="muted sm">Свойства для «{{ typeLabel }}» пока не редактируются. Сейчас поддержаны сундуки, руины и города.</p>
    </div>

    <!-- 🎬 «Сценарий» — где этот объект участвует в событиях (для ЛЮБОГО типа с ролями) -->
    <div v-if="objectRoles.length" class="ins-body">
      <div class="d2-sec">Сценарий <span class="muted">({{ objectRoles.length }})</span></div>
      <div class="roles-list">
        <!-- hover = шпаргалка события (условия/эффекты именами); клик = перейти к событию -->
        <el-tooltip
          v-for="(r, i) in visibleRoles"
          :key="`${r.ev.id}#${i}`"
          placement="left"
          :show-after="450"
          :persistent="false"
          popper-class="ev-sum-pop"
        >
          <template #content>
            <EventSummaryCard :event="r.ev" />
          </template>
          <div
            class="role-line d2-row"
            :class="{ 'map-hover': r.ev.id === eventStore.mapHoverId }"
            @click="openRole(r)"
            @mouseenter="eventStore.listHoverId = r.ev.id"
            @mouseleave="eventStore.listHoverId = null"
          >
            <span class="role-icon" :title="ROLE_META[r.cls].label">{{ ROLE_META[r.cls].icon }}</span>
            <span class="stk-text">
              <span class="item-name">{{ r.ev.name || r.ev.id }}</span>
              <span class="stk-sub">{{ r.cls === "trigger" ? "причина" : "следствие" }} · {{ r.what }}{{ r.detail ? `: ${r.detail}` : "" }}</span>
            </span>
            <!-- сложность: событие с условиями сработает не всегда — видно сразу -->
            <span v-if="r.ev.conditions.length > 1" class="role-cond muted">
              {{ r.ev.conditions.length }} усл.
            </span>
          </div>
        </el-tooltip>
        <el-button
          v-if="objectRoles.length > ROLE_LIMIT"
          class="role-more"
          size="small"
          text
          @click="rolesExpanded = !rolesExpanded"
        >{{ rolesExpanded ? "свернуть" : `+${objectRoles.length - ROLE_LIMIT} ещё` }}</el-button>
      </div>
      <el-button v-if="canCreateEventFor" size="small" text type="primary" @click="newEventForObject()">
        ＋ Событие с этим объектом
      </el-button>
    </div>
    <div v-else-if="obj.type === 'location'" class="ins-body">
      <p class="muted sm">не используется в сценарии — ПКМ: „＋ Событие“ / „✨ Спавн“</p>
    </div>
    <div v-else-if="canCreateEventFor" class="ins-body">
      <div class="d2-sec">Сценарий</div>
      <p class="muted sm">событий с этим объектом нет</p>
      <el-button size="small" text type="primary" @click="newEventForObject()">
        ＋ Событие с этим объектом
      </el-button>
    </div>
  </div>
</template>

<style scoped>
/* Root = right rail; .d2-rail owns the bg + single hairline seam. */
.inspector {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.ins-head {
  display: flex;
  align-items: center;
  gap: var(--d2-sp-2);
  padding: 10px 12px 6px;
}
.ins-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.ins-id {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}
.ins-close {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 16px;
  opacity: 0.7;
}
.ins-close:hover {
  opacity: 1;
}
.ins-sub {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin: 0;
  padding: 0 12px var(--d2-sp-2);
}
.ins-body {
  display: flex;
  flex-direction: column;
  gap: var(--d2-sp-2);
  padding: 0 12px var(--d2-sp-3);
}
/* The flex gap already adds 8px around section labels — trim .d2-sec margins
 * so sections net out at 16px above / 4px below the label. */
.ins-body > .d2-sec {
  margin: var(--d2-sp-2) 0 -4px;
}
.ro-block > .d2-sec {
  margin: var(--d2-sp-2) 0 0;
}
/* action button living inside a micro-caps header keeps its own case */
.d2-sec .visitor-open {
  text-transform: none;
  letter-spacing: normal;
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
  gap: 6px;
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
/* sections separate by air (.d2-sec margins), not rules */
.section-divider {
  display: none;
}
.equip-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
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
.decor-head {
  display: flex;
  align-items: center;
  gap: var(--d2-sp-2, 8px);
}
.decor-info {
  min-width: 0;
}
.decor-name {
  font-size: 13px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.decor-cycle {
  display: inline-flex;
  gap: 2px;
}
/* variant looks = a visual thumbnail grid (not a blind «1 из 4» cycler). Same look as the
   on-canvas ObjectActionBar strip: checkerboard cells, soft ring on hover / accent on the
   current one. Hover shows a zoomed ThumbPreview (the inspector rail is narrow). */
.decor-variants-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: var(--d2-sp-3, 10px) 0 4px;
}
.decor-variants-head .d2-sec { margin: 0; }
.decor-variants {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dv-cell {
  flex: 0 0 auto;
  padding: 2px;
  border: none;
  border-radius: var(--d2-radius);
  /* fixed-light checkerboard: the sprites are dark, they only read on a light backdrop */
  background: repeating-conic-gradient(#e9e5db 0% 25%, #f6f4ee 0% 50%) 0 / 12px 12px;
  cursor: pointer;
  transition: box-shadow 0.12s ease;
}
.dv-cell:hover { box-shadow: 0 0 0 1px var(--el-border-color-lighter); }
.dv-cell.sel { box-shadow: 0 0 0 2px var(--d2-active-bar); }
/* «Сценарий»: compact clickable role rows (.d2-row owns hover wash + radius) */
.roles-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* курсор на бейдже этого события на карте — зеркальная подсветка строки */
.role-line.map-hover { box-shadow: inset 0 0 0 1px var(--el-color-warning); background: var(--el-fill-color-light); }
.role-line {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  cursor: pointer;
}
.role-icon {
  flex: 0 0 auto;
  font-size: 13px;
  line-height: 1;
}
.role-cond {
  flex: 0 0 auto;
  font-size: 10px;
  background: var(--el-fill-color);
  border-radius: 5px;
  padding: 1px 5px;
}
.role-more {
  align-self: flex-start;
  margin: 2px 0 0 4px;
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
.buy-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 10px;
  padding: 2px 0 4px;
}
/* .d2-row owns hover wash + radius */
.item-line {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
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
  opacity: 0.6;
}
.item-act:hover {
  opacity: 1;
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
  padding: 5px 10px;
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
