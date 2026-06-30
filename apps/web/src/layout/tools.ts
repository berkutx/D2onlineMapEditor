/**
 * Single source of truth for the edit tools — label, hotkey hint, icon, and the
 * one-line status hint. Consumed by ToolDock (icon + tooltip) and StatusBar
 * (label + hint) so the two never drift.
 */
import type { Component } from "vue";
import { Pointer, Brush, Scissor, Picture, Rank } from "@element-plus/icons-vue";
import type { EditTool } from "../stores/toolStore";
import { WaterIcon, ForestIcon, RoadIcon, EraseIcon } from "./toolIcons";

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
  { value: "select", label: "Обзор", icon: Pointer, hint: "ЛКМ — осмотр · ⇧+клик — слой ниже (локации) · колесо — масштаб · тащить — двигать карту" },
  { value: "terrain", label: "Рельеф", icon: Brush, hint: "рисуй землёй · Ctrl+тащить — двигать карту · колесо — масштаб" },
  { value: "water", label: "Вода", icon: WaterIcon, hint: "рисуй водой · Ctrl+тащить — двигать карту" },
  { value: "forest", label: "Лес", icon: ForestIcon, hint: "сажай лес · Ctrl+тащить — двигать карту" },
  { value: "road", label: "Дорога", icon: RoadIcon, hint: "веди дорогу · авто-стыковка · Ctrl+тащить — двигать карту" },
  { value: "roadsel", label: "Дорога ✂", icon: Scissor, hint: "клик — выделить · ещё раз — расширить · Del — стереть · Esc — снять" },
  { value: "erase", label: "Ластик", icon: EraseIcon, hint: "стирай рельеф/объекты · Ctrl+тащить — двигать карту" },
  { value: "decor", label: "Декор", icon: Picture, hint: "клик — поставить · R — другой облик · [ ] — листать" },
  { value: "move", label: "Двигать", icon: Rank, hint: "клик — взять · ⇧+клик — слой ниже · клик — поставить · R — облик · Esc — отмена" },
];

const BY_VALUE = new Map(EDIT_TOOLS.map((t) => [t.value, t]));
export function toolDef(v: EditTool): ToolDef | undefined {
  return BY_VALUE.get(v);
}
