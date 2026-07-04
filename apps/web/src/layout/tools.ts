/**
 * Single source of truth for the edit tools — label, hotkey hint, icon, and the
 * one-line status hint. Consumed by ToolDock (icon + tooltip) and StatusBar
 * (label + hint) so the two never drift.
 */
import type { Component } from "vue";
import { Pointer, Brush, Scissor, Picture, Rank, Crop } from "@element-plus/icons-vue";
import type { EditTool } from "../stores/toolStore";
import { WaterIcon, ForestIcon, RoadIcon, EraseIcon, LocationsIcon } from "./toolIcons";

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
  { value: "select", label: "Обзор", icon: Pointer, hint: "ЛКМ — осмотр · 2×клик — перенести · ⇧+клик/рамка — выделить несколько · Alt+клик — слой ниже · тащить — карта" },
  { value: "terrain", label: "Рельеф", icon: Brush, hint: "рисуй землёй · Ctrl+тащить — двигать карту · колесо — масштаб" },
  { value: "water", label: "Вода", icon: WaterIcon, hint: "рисуй водой · Ctrl+тащить — двигать карту" },
  { value: "forest", label: "Лес", icon: ForestIcon, hint: "сажай лес · Ctrl+тащить — двигать карту" },
  { value: "road", label: "Дорога", icon: RoadIcon, hint: "веди дорогу · авто-стыковка · Ctrl+тащить — двигать карту" },
  { value: "roadsel", label: "Дорога ✂", icon: Scissor, hint: "клик — выделить · ещё раз — расширить · тащить — двигать · тащить за конец — продолжить · Del — стереть" },
  { value: "erase", label: "Ластик", icon: EraseIcon, hint: "стирай рельеф/дороги/декор · Ctrl+тащить — двигать карту" },
  { value: "decor", label: "Декор", icon: Picture, hint: "клик — поставить · R — другой облик · [ ] — листать · Ctrl+тащить — двигать карту" },
  { value: "move", label: "Двигать", icon: Rank, hint: "клик — взять/поставить · ⇧+клик — слой ниже · R — облик · Ctrl+тащить — двигать карту · Esc — отмена" },
  { value: "locations", label: "Локации", icon: LocationsIcon, hint: "клик — выбрать локацию · ещё клик — следующая · тащить — переместить · ◆-ручка у выбранной — радиус · Ctrl+тащить — карта" },
  { value: "zone", label: "Зона", icon: Crop, hint: "нарисуй территорию (прямоуг/кисть/линия/рамка) — редактор нарежет её в локации-примитивы" },
];

const BY_VALUE = new Map(EDIT_TOOLS.map((t) => [t.value, t]));
export function toolDef(v: EditTool): ToolDef | undefined {
  return BY_VALUE.get(v);
}
