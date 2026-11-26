/**
 * Single source of truth for the edit tools — label, hotkey hint, icon, and the
 * one-line status hint. Consumed by ToolDock (icon + tooltip) and StatusBar
 * (label + hint) so the two never drift.
 */
import type { Component } from "vue";
import { Pointer, Brush, Scissor, Picture, Rank, Crop, OfficeBuilding } from "@element-plus/icons-vue";
import type { EditTool } from "../stores/toolStore";
import { WaterIcon, ForestIcon, RoadIcon, EraseIcon, LocationsIcon } from "./toolIcons";
import { tr } from "../i18n";

export interface ToolDef {
  value: EditTool;
  label: string;
  /** keyboard cue shown in the tooltip (informational; tools are picked by click) */
  key?: string;
  icon: Component;
  /** one-line hint shown in the status bar while this tool is active */
  hint: string;
}

/** The dock tools, top-to-bottom. `region` is driven from the Copilot, not the dock. */
export const EDIT_TOOLS: ToolDef[] = [
  { value: "select", label: tr("Обзор"), icon: Pointer, hint: tr("ЛКМ — осмотр · 2×клик — перенести · ⇧+клик/рамка — выделить несколько · Alt+клик — слой ниже · тащить — карта") },
  { value: "terrain", label: tr("Рельеф"), icon: Brush, hint: tr("рисуй землёй · Ctrl+тащить — двигать карту · колесо — масштаб") },
  { value: "water", label: tr("Вода"), icon: WaterIcon, hint: tr("рисуй водой · Ctrl+тащить — двигать карту") },
  { value: "forest", label: tr("Лес"), icon: ForestIcon, hint: tr("сажай лес · Ctrl+тащить — двигать карту") },
  { value: "road", label: tr("Дорога"), icon: RoadIcon, hint: tr("веди дорогу · авто-стыковка · Ctrl+тащить — двигать карту") },
  { value: "roadsel", label: tr("Дорога ✂"), icon: Scissor, hint: tr("клик — выделить · ещё раз — расширить · тащить — двигать · тащить за конец — продолжить · Del — стереть") },
  { value: "erase", label: tr("Ластик"), icon: EraseIcon, hint: tr("стирай рельеф/дороги/декор · Ctrl+тащить — двигать карту") },
  { value: "decor", label: tr("Декор"), icon: Picture, hint: tr("клик — поставить · R — другой облик · [ ] — листать · Ctrl+тащить — двигать карту") },
  { value: "object", label: tr("Объекты"), icon: OfficeBuilding, hint: tr("клик — поставить · тип в панели опций · отряду нужен лидер · свойства — в инспекторе") },
  { value: "move", label: tr("Двигать"), icon: Rank, hint: tr("клик — взять/поставить · ⇧+клик — слой ниже · R — облик · Ctrl+тащить — двигать карту · Esc — отмена") },
  { value: "locations", label: tr("Локации"), icon: LocationsIcon, hint: tr("клик — выбрать локацию · ещё клик — следующая · тащить — переместить · ◆-ручка у выбранной — радиус · Ctrl+тащить — карта") },
  { value: "zone", label: tr("Зона"), icon: Crop, hint: tr("нарисуй территорию (прямоуг/кисть/линия/рамка) — редактор нарежет её в локации-примитивы") },
];

const BY_VALUE = new Map(EDIT_TOOLS.map((t) => [t.value, t]));
export function toolDef(v: EditTool): ToolDef | undefined {
  return BY_VALUE.get(v);
}
