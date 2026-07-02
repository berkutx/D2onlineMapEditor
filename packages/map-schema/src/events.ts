/**
 * Contract A — scenario EVENTS (MidEvent). A faithful model of the game's event system
 * (22 condition types + 24 effect types), byte-verified against toolsqt D2Event.h and the
 * game's LEvCond/LEvEffct.DBF. See docs/reference-gaps-events.md.
 *
 * ONE source of truth: CONDITION_SPECS / EFFECT_SPECS carry each type's numeric code, label,
 * and ordered field list. The parser, writer, zod schema, and editor UI all derive from these
 * so they cannot drift. A handful of types with irregular serialization (nested lists, raw
 * script blocks) are still round-tripped by the explicit codec in @d2/sg-parser and covered by
 * tests; their specs here describe the editable fields.
 *
 * Ref fields (locId/stackId/…) hold the 10-char on-disk compound id, or "" for none
 * (the game's EMPTY_REF sentinel "G000000000" maps to "" in the model).
 */

import { z } from "zod";

/** A single editable field of a condition/effect, driving both zod and the editor form. */
export interface EventFieldSpec {
  key: string;
  label: string;
  /** ref-* = a picker over map objects of that kind (10-char id); template/item/spell = a
   *  length-string global id; var = a MidScenVariables id (int); enum = a fixed choice list. */
  type:
    | "int"
    | "bool"
    | "text"
    | "ref-loc"
    | "ref-stack"
    | "ref-city"
    | "ref-player"
    | "ref-ruin"
    | "ref-site"
    | "ref-event"
    | "ref-lmark"
    | "template"
    | "item"
    | "spell"
    | "var"
    | "enum";
  options?: readonly { value: number; label: string }[];
  min?: number;
  max?: number;
}

export interface EventTypeSpec {
  code: number;
  kind: string;
  label: string;
  fields: readonly EventFieldSpec[];
}

const DIPLO_PRESETS = [
  { value: 100, label: "Мир (100)" },
  { value: 49, label: "Нейтралитет (49)" },
  { value: 0, label: "Война (0)" },
] as const;

// ---- CONDITIONS ------------------------------------------------------------

export const CONDITION_SPECS: readonly EventTypeSpec[] = [
  { code: 0, kind: "frequency", label: "Периодичность (дней)", fields: [
    { key: "days", label: "Каждые N дней", type: "int", min: 1, max: 500 } ] },
  { code: 2, kind: "enterZone", label: "Вход в зону", fields: [
    { key: "locId", label: "Локация", type: "ref-loc" } ] },
  { code: 3, kind: "enterCity", label: "Вход в город", fields: [
    { key: "cityId", label: "Город", type: "ref-city" } ] },
  { code: 4, kind: "owningCity", label: "Владение городом", fields: [
    { key: "cityId", label: "Город", type: "ref-city" } ] },
  { code: 5, kind: "destroyStack", label: "Уничтожение отряда", fields: [
    { key: "stackId", label: "Отряд", type: "ref-stack" } ] },
  { code: 6, kind: "owningItem", label: "Владение предметом", fields: [
    { key: "itemType", label: "Предмет", type: "item" } ] },
  { code: 7, kind: "leaderOwningItem", label: "Лидер владеет предметом", fields: [
    { key: "itemType", label: "Предмет", type: "item" },
    { key: "stackId", label: "Отряд", type: "ref-stack" } ] },
  { code: 8, kind: "diplomacy", label: "Отношения игроков", fields: [
    { key: "player1", label: "Игрок 1", type: "ref-player" },
    { key: "player2", label: "Игрок 2", type: "ref-player" },
    { key: "relation", label: "Отношение", type: "int", min: -100, max: 100, options: DIPLO_PRESETS } ] },
  { code: 9, kind: "alliance", label: "Союз игроков", fields: [
    { key: "player1", label: "Игрок 1", type: "ref-player" },
    { key: "player2", label: "Игрок 2", type: "ref-player" } ] },
  { code: 10, kind: "lootingRuin", label: "Разграбление руин", fields: [
    { key: "ruinId", label: "Руины", type: "ref-ruin" } ] },
  { code: 11, kind: "transformLand", label: "Преображение земли (%)", fields: [
    { key: "pct", label: "% земли", type: "int", min: 0, max: 100 } ] },
  { code: 12, kind: "visitingSite", label: "Посещение локации-сайта", fields: [
    { key: "siteId", label: "Сайт", type: "ref-site" } ] },
  { code: 14, kind: "stackInLocation", label: "Отряд в зоне", fields: [
    { key: "stackId", label: "Отряд", type: "ref-stack" },
    { key: "locId", label: "Локация", type: "ref-loc" } ] },
  { code: 15, kind: "stackInCity", label: "Отряд в городе", fields: [
    { key: "stackId", label: "Отряд", type: "ref-stack" },
    { key: "cityId", label: "Город", type: "ref-city" } ] },
  { code: 16, kind: "itemToLocation", label: "Предмет в зоне", fields: [
    { key: "itemType", label: "Предмет", type: "item" },
    { key: "locId", label: "Локация", type: "ref-loc" } ] },
  { code: 17, kind: "stackExists", label: "Существование отряда", fields: [
    { key: "stackId", label: "Отряд", type: "ref-stack" },
    { key: "mustExist", label: "Должен существовать", type: "bool" } ] },
  { code: 18, kind: "varInRange", label: "Переменная в диапазоне", fields: [
    { key: "var1", label: "Переменная 1", type: "var" },
    { key: "min1", label: "Мин 1", type: "int" },
    { key: "max1", label: "Макс 1", type: "int" },
    { key: "var2", label: "Переменная 2", type: "var" },
    { key: "min2", label: "Мин 2", type: "int" },
    { key: "max2", label: "Макс 2", type: "int" },
    { key: "relation", label: "Связь", type: "enum", options: [
      { value: 0, label: "Игнор. 2-ю" }, { value: 1, label: "Обе (И)" }, { value: 2, label: "Любая (ИЛИ)" } ] } ] },
  { code: 19, kind: "resourceAmount", label: "Ресурсы игрока", fields: [
    { key: "bank", label: "Банк (G:R:Y:E:W:B)", type: "text" },
    { key: "greaterOrEqual", label: "Больше или равно", type: "bool" } ] },
  { code: 20, kind: "gameMode", label: "Режим игры", fields: [
    { key: "mode", label: "Режим", type: "enum", options: [
      { value: 0, label: "Одиночная" }, { value: 1, label: "Хотсит" }, { value: 2, label: "Онлайн" } ] } ] },
  { code: 21, kind: "checkForHuman", label: "Человек / ИИ", fields: [
    { key: "isAI", label: "Управляет ИИ", type: "bool" } ] },
  { code: 22, kind: "compareVar", label: "Сравнение переменных", fields: [
    { key: "var1", label: "Переменная 1", type: "var" },
    { key: "var2", label: "Переменная 2", type: "var" },
    { key: "cmp", label: "Оператор", type: "enum", options: [
      { value: 0, label: "==" }, { value: 1, label: "≠" }, { value: 2, label: ">" },
      { value: 3, label: "≥" }, { value: 4, label: "<" }, { value: 5, label: "≤" } ] } ] },
  { code: 23, kind: "customScript", label: "Lua-скрипт", fields: [
    { key: "code", label: "Код", type: "text" },
    { key: "desc", label: "Описание", type: "text" } ] },
] as const;

// ---- EFFECTS ---------------------------------------------------------------

export const EFFECT_SPECS: readonly EventTypeSpec[] = [
  { code: 0, kind: "winLose", label: "Победа / поражение", fields: [
    { key: "win", label: "Победа (иначе поражение)", type: "bool" },
    { key: "player", label: "Игрок", type: "ref-player" } ] },
  { code: 1, kind: "createStack", label: "Создать отряд", fields: [
    { key: "templateId", label: "Шаблон отряда", type: "template" },
    { key: "locId", label: "Локация", type: "ref-loc" } ] },
  { code: 2, kind: "castSpellTriggerer", label: "Заклинание на инициатора", fields: [
    { key: "spellType", label: "Заклинание", type: "spell" },
    { key: "player", label: "Заклинатель", type: "ref-player" } ] },
  { code: 3, kind: "castSpellLocation", label: "Заклинание в зоне", fields: [
    { key: "spellType", label: "Заклинание", type: "spell" },
    { key: "locId", label: "Локация", type: "ref-loc" },
    { key: "player", label: "Заклинатель", type: "ref-player" } ] },
  { code: 4, kind: "changeStackOwner", label: "Сменить владельца отряда", fields: [
    { key: "stackId", label: "Отряд", type: "ref-stack" },
    { key: "player", label: "Новый владелец", type: "ref-player" },
    { key: "firstOnly", label: "Только первый", type: "bool" },
    { key: "playAnim", label: "Анимация", type: "bool" } ] },
  { code: 5, kind: "moveStackToTriggerer", label: "Отряд к инициатору", fields: [
    { key: "stackId", label: "Отряд", type: "ref-stack" } ] },
  { code: 6, kind: "goIntoBattle", label: "Начать бой", fields: [
    { key: "stackId", label: "Отряд", type: "ref-stack" },
    { key: "firstOnly", label: "Только первый", type: "bool" } ] },
  { code: 7, kind: "enableEvent", label: "Вкл/выкл событие", fields: [
    { key: "eventId", label: "Событие", type: "ref-event" },
    { key: "enable", label: "Включить", type: "bool" } ] },
  { code: 8, kind: "giveSpell", label: "Выдать заклинание", fields: [
    { key: "spellType", label: "Заклинание", type: "spell" } ] },
  { code: 9, kind: "giveItem", label: "Выдать предмет", fields: [
    { key: "giveTo", label: "Кому", type: "enum", options: [
      { value: 0, label: "Инициатору" }, { value: 1, label: "В столицу" } ] },
    { key: "itemType", label: "Предмет", type: "item" } ] },
  { code: 10, kind: "moveStackToLocation", label: "Отряд в зону", fields: [
    { key: "stackTmpId", label: "Отряд", type: "ref-stack" },
    { key: "locId", label: "Локация", type: "ref-loc" },
    { key: "boolVal", label: "Двигать инициатора", type: "bool" } ] },
  { code: 11, kind: "allyPlayers", label: "Союз ИИ-игроков", fields: [
    { key: "player1", label: "Игрок 1", type: "ref-player" },
    { key: "player2", label: "Игрок 2", type: "ref-player" },
    { key: "permAlly", label: "Постоянный союз", type: "bool" } ] },
  { code: 12, kind: "changeDiplomacy", label: "Изменить дипломатию", fields: [
    { key: "player1", label: "Игрок 1", type: "ref-player" },
    { key: "player2", label: "Игрок 2", type: "ref-player" },
    { key: "relation", label: "Отношение", type: "int", min: -100, max: 100, options: DIPLO_PRESETS },
    { key: "enabled", label: "Вечная война", type: "bool" } ] },
  { code: 13, kind: "changeFog", label: "Туман войны в зоне", fields: [
    { key: "locId", label: "Локация", type: "ref-loc" },
    { key: "enable", label: "Открыть (иначе скрыть)", type: "bool" },
    { key: "value", label: "Радиус (0..24)", type: "int", min: 0, max: 24 } ] },
  { code: 14, kind: "removeMountains", label: "Убрать горы в зоне", fields: [
    { key: "locId", label: "Локация", type: "ref-loc" } ] },
  { code: 15, kind: "removeLandmark", label: "Убрать декорацию", fields: [
    { key: "lmarkId", label: "Декорация", type: "ref-lmark" },
    { key: "boolVal", label: "Анимация", type: "bool" } ] },
  { code: 16, kind: "changeObjective", label: "Сменить текст цели", fields: [
    { key: "text", label: "Текст", type: "text" } ] },
  { code: 17, kind: "popup", label: "Показать сообщение", fields: [
    { key: "text", label: "Текст", type: "text" },
    { key: "image", label: "Портрет", type: "text" },
    { key: "image2", label: "Портрет 2", type: "text" },
    { key: "sound", label: "Звук", type: "text" },
    { key: "music", label: "Музыка", type: "text" },
    { key: "leftSide", label: "Слева", type: "bool" },
    { key: "popupShow", label: "Кому", type: "enum", options: [
      { value: 0, label: "Инициатору (TRI)" }, { value: 1, label: "Всем (ALL)" }, { value: 2, label: "Затронутым (AFF)" } ] } ] },
  { code: 18, kind: "changeStackOrder", label: "Приказ отряду", fields: [
    { key: "stackId", label: "Отряд", type: "ref-stack" },
    { key: "orderTarget", label: "Цель приказа", type: "ref-stack" },
    { key: "firstOnly", label: "Только первый", type: "bool" },
    { key: "order", label: "Приказ (код)", type: "int" } ] },
  { code: 19, kind: "destroyItem", label: "Уничтожить предмет", fields: [
    { key: "itemType", label: "Предмет", type: "item" },
    { key: "triggerOnly", label: "Только у инициатора", type: "bool" } ] },
  { code: 20, kind: "removeStack", label: "Убрать отряд", fields: [
    { key: "stackId", label: "Отряд", type: "ref-stack" },
    { key: "firstOnly", label: "Только первый", type: "bool" } ] },
  { code: 21, kind: "changeLandmark", label: "Сменить декорацию", fields: [
    { key: "lmarkId", label: "Декорация", type: "ref-lmark" },
    { key: "lmarkType", label: "Новый тип", type: "text" } ] },
  { code: 22, kind: "changeTerrain", label: "Сменить рельеф в зоне", fields: [
    { key: "locId", label: "Локация", type: "ref-loc" },
    { key: "lookup", label: "Раса рельефа", type: "enum", options: [
      { value: 1, label: "Империя" }, { value: 2, label: "Кланы" }, { value: 3, label: "Легионы" },
      { value: 4, label: "Нежить" }, { value: 5, label: "Нейтралы" }, { value: 6, label: "Эльфы" } ] },
    { key: "value", label: "Размер", type: "int" } ] },
  { code: 23, kind: "modifyVariable", label: "Изменить переменную", fields: [
    { key: "lookup", label: "Операция", type: "enum", options: [
      { value: 0, label: "+ Прибавить" }, { value: 1, label: "− Вычесть" }, { value: 2, label: "× Умножить" },
      { value: 3, label: "÷ Разделить" }, { value: 4, label: "= Присвоить" } ] },
    { key: "val1", label: "Значение", type: "int", min: -9999, max: 9999 },
    { key: "val2", label: "Переменная", type: "var" } ] },
] as const;

export const CONDITION_BY_KIND: Record<string, EventTypeSpec> = Object.fromEntries(
  CONDITION_SPECS.map((s) => [s.kind, s]),
);
export const CONDITION_BY_CODE: Record<number, EventTypeSpec> = Object.fromEntries(
  CONDITION_SPECS.map((s) => [s.code, s]),
);
export const EFFECT_BY_KIND: Record<string, EventTypeSpec> = Object.fromEntries(
  EFFECT_SPECS.map((s) => [s.kind, s]),
);
export const EFFECT_BY_CODE: Record<number, EventTypeSpec> = Object.fromEntries(
  EFFECT_SPECS.map((s) => [s.code, s]),
);

// A field's value type in the model.
const fieldZod = (f: EventFieldSpec): z.ZodTypeAny =>
  f.type === "bool" ? z.boolean() : f.type === "text" || f.type.startsWith("ref-") || f.type === "template" || f.type === "item" || f.type === "spell"
    ? z.string()
    : z.number(); // int / enum / var

function specToZod(specs: readonly EventTypeSpec[], discr: "cond" | "eff"): z.ZodTypeAny {
  const variants = specs.map((s) => {
    const shape: Record<string, z.ZodTypeAny> = { kind: z.literal(s.kind) };
    for (const f of s.fields) shape[f.key] = fieldZod(f);
    if (discr === "eff") shape.num = z.number().int().default(0); // effect sequence order
    if (s.kind === "changeFog") {
      shape.entries = z.array(z.object({ eventId: z.string(), player: z.string() })).default([]);
    }
    return z.object(shape);
  });
  // zod discriminatedUnion needs ≥1; all our variants share the "kind" literal discriminant
  return z.discriminatedUnion("kind", variants as [z.ZodObject<never>, ...z.ZodObject<never>[]]);
}

export const EventCondition = specToZod(CONDITION_SPECS, "cond");
export type EventCondition = z.infer<typeof EventCondition>;
export const EventEffect = specToZod(EFFECT_SPECS, "eff");
export type EventEffect = z.infer<typeof EventEffect>;

/** Race gating: applies-to and can-trigger are the two independent race bitsets. */
export const EventRaces = z.object({
  human: z.boolean().default(false),
  dwarf: z.boolean().default(false),
  undead: z.boolean().default(false),
  heretic: z.boolean().default(false),
  neutral: z.boolean().default(false),
  elf: z.boolean().default(false),
});
export type EventRaces = z.infer<typeof EventRaces>;

export const MapEvent = z.object({
  id: z.string(), // on-disk compound id, e.g. "S143EV0001"
  name: z.string().default(""),
  enabled: z.boolean().default(true), // "available at start"
  occurOnce: z.boolean().default(true), // editor "infinite" = !occurOnce
  chance: z.number().int().min(0).max(100).default(100),
  order: z.number().int().default(0), // evaluation order
  appliesTo: EventRaces,
  canTrigger: EventRaces,
  conditions: z.array(EventCondition).default([]),
  effects: z.array(EventEffect).default([]),
});
export type MapEvent = z.infer<typeof MapEvent>;
