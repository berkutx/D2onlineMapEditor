/**
 * Single source of truth for the edit tools — group, label, hotkey, icon, what the tool is
 * for, and the one-line gesture hint. Consumed by ToolDock (button, label, tooltip),
 * StatusBar (label + hint), the key handler (hotkeys) and the command bar (tool names),
 * so they never drift.
 */
import type { Component } from "vue";
import { Pointer, Brush, Scissor, Picture, Rank, Crop, OfficeBuilding } from "@element-plus/icons-vue";
import type { EditTool } from "../stores/toolStore";
import { WaterIcon, ForestIcon, RoadIcon, EraseIcon, LocationsIcon, FogIcon } from "./toolIcons";
import { tr } from "../i18n";

/** The dock's sections, top to bottom: what the map maker is doing, not how a tool works. */
export type ToolGroupId = "look" | "land" | "roads" | "objects" | "scenario";

export interface ToolGroupDef {
  id: ToolGroupId;
  label: string;
}

export const TOOL_GROUPS: ToolGroupDef[] = [
  { id: "look", label: tr("Осмотр") },
  { id: "land", label: tr("Земля") },
  { id: "roads", label: tr("Дороги") },
  { id: "objects", label: tr("Объекты") },
  { id: "scenario", label: tr("Сценарий") },
];

export interface ToolDef {
  value: EditTool;
  group: ToolGroupId;
  label: string;
  /** the key that picks the tool (a digit: it is the same key in every keyboard layout) */
  key?: string;
  icon: Component;
  /** what the tool is for, in one phrase — the dock's tooltip */
  about: string;
  /** one-line gesture hint shown in the status bar while this tool is active */
  hint: string;
}

/** The dock tools in the dock's order. `region` is driven from the command bar, not the dock. */
export const EDIT_TOOLS: ToolDef[] = [
  { value: "select", group: "look", key: "1", label: tr("Обзор"), icon: Pointer, about: tr("Осмотреть карту, выделить объекты и открыть их свойства"), hint: tr("ЛКМ — осмотр · 2×клик — перенести · ⇧+клик/рамка — выделить несколько · Alt+клик — слой ниже · тащить — карта") },
  { value: "move", group: "look", key: "2", label: tr("Двигать"), icon: Rank, about: tr("Взять объект и поставить его в другое место"), hint: tr("клик — взять/поставить · ⇧+клик — слой ниже · R — облик · Ctrl+тащить — двигать карту · Esc — отмена") },

  { value: "terrain", group: "land", key: "3", label: tr("Рельеф"), icon: Brush, about: tr("Красить кистью землю расы"), hint: tr("рисуй землёй · Ctrl+тащить — двигать карту · колесо — масштаб") },
  { value: "water", group: "land", key: "4", label: tr("Вода"), icon: WaterIcon, about: tr("Заливать клетки водой"), hint: tr("рисуй водой · Ctrl+тащить — двигать карту") },
  { value: "forest", group: "land", key: "5", label: tr("Лес"), icon: ForestIcon, about: tr("Сажать лес"), hint: tr("сажай лес · Ctrl+тащить — двигать карту") },
  { value: "erase", group: "land", key: "6", label: tr("Ластик"), icon: EraseIcon, about: tr("Стирать воду, лес, дороги и декорации"), hint: tr("стирай рельеф/дороги/декор · Ctrl+тащить — двигать карту") },

  { value: "road", group: "roads", key: "7", label: tr("Дорога"), icon: RoadIcon, about: tr("Вести дорогу от клетки к клетке"), hint: tr("веди дорогу · авто-стыковка · Ctrl+тащить — двигать карту") },
  { value: "roadsel", group: "roads", key: "8", label: tr("Дорога ✂"), icon: Scissor, about: tr("Выделить участок дороги: сдвинуть, продолжить или стереть"), hint: tr("клик — выделить · ещё раз — расширить · тащить — двигать · тащить за конец — продолжить · Del — стереть") },

  { value: "decor", group: "objects", key: "9", label: tr("Декор"), icon: Picture, about: tr("Ставить декорации из каталога"), hint: tr("клик — поставить · R — другой облик · [ ] — листать · Ctrl+тащить — двигать карту") },
  { value: "object", group: "objects", key: "0", label: tr("Объекты"), icon: OfficeBuilding, about: tr("Ставить города, руины, сундуки, отряды и лавки"), hint: tr("клик — поставить · тип в панели опций · отряду нужен лидер · свойства — в инспекторе") },

  { value: "locations", group: "scenario", label: tr("Локации"), icon: LocationsIcon, about: tr("Локации событий: выбрать, сдвинуть, изменить радиус"), hint: tr("клик — выбрать локацию · ещё клик — следующая · тащить — переместить · ◆-ручка у выбранной — радиус · Ctrl+тащить — карта") },
  { value: "zone", group: "scenario", label: tr("Зона"), icon: Crop, about: tr("Нарисовать зону любой формы — она станет набором локаций"), hint: tr("нарисуй территорию (прямоуг/кисть/линия/рамка) — редактор нарежет её в локации-примитивы") },
  { value: "fog", group: "scenario", label: tr("Туман войны"), icon: FogIcon, about: tr("Задать туман войны каждому игроку: заготовкой или кистью"), hint: tr("рисуй туман войны выбранного игрока · заготовки для всех сторон — кнопка «Игроки» · Ctrl+тащить — двигать карту") },
];

const BY_VALUE = new Map(EDIT_TOOLS.map((t) => [t.value, t]));
export function toolDef(v: EditTool): ToolDef | undefined {
  return BY_VALUE.get(v);
}

const BY_KEY = new Map(EDIT_TOOLS.filter((t) => t.key).map((t) => [t.key!, t.value]));
/** The tool a hotkey picks, if any. */
export function toolByKey(key: string): EditTool | undefined {
  return BY_KEY.get(key);
}
