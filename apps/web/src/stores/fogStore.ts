/**
 * The «Туман» tool: whose fog of war is shown and painted, what the brush does, and the
 * presets that set a player's fog in one step.
 *
 * A fog is the player's MidgardMapFog block of the map file (see @d2/map-edit fog.ts for the
 * bit layout and for what the game does with it). The veil on the canvas and the numbers
 * here are derived from the live document, so an undo, a peer's edit or a reloaded map show
 * up without any bookkeeping.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  fogAroundOwnedOps, fogCopyOps, fogFillOps, fogGrid, fogHiddenCount, fogOfPlayer, fogPaintOps, fogState,
  type EditOp, type FogState,
} from "@d2/map-edit";
import type { FogVisual } from "@d2/pixi-render";
import { useEditStore } from "./editStore";

/** What a stroke of the fog brush does to the cells under it. */
export type FogBrush = "open" | "hide";
/** A fog set in one step: all hidden, all open (= not set), or open around what the player owns. */
export type FogPreset = "hide" | "open" | "around";

export interface FogPlayer {
  id: string;
  name: string;
  color: string;
  neutral: boolean;
  fogId: string;
  hidden: number;
  state: FogState;
}

/** Race record index of the neutral player (PlayerInfo.race). */
const NEUTRAL_RACE = 4;

export const useFogStore = defineStore("fog", () => {
  const edit = useEditStore();

  /** The player picked in the tool; null = not picked yet (the first playable one is used). */
  const pickedPlayerId = ref<string | null>(null);
  const brush = ref<FogBrush>("open");
  /** How far the «вокруг своих» preset opens around a player's cities and parties, in cells. */
  const aroundRadius = ref(6);

  /** Players that have a fog block, playable ones first (the neutral player sees everything
   *  in the game, so its fog is rarely the one to edit), each with how its fog stands. */
  const players = computed<FogPlayer[]>(() => {
    const doc = edit.liveDoc;
    if (!doc) return [];
    const out: FogPlayer[] = [];
    for (const p of doc.players) {
      const fog = fogOfPlayer(doc, p.id);
      if (!fog) continue;
      out.push({
        id: p.id, name: p.name || p.id, color: p.color ?? "", neutral: p.race === NEUTRAL_RACE, fogId: fog.id,
        hidden: fogHiddenCount(fog, doc.size), state: fogState(fog, doc.size),
      });
    }
    return out.sort((a, b) => Number(a.neutral) - Number(b.neutral));
  });

  /** The player whose fog the tool works on (the picked one while the map still has it). */
  const playerId = computed<string | null>(() => {
    const list = players.value;
    if (pickedPlayerId.value && list.some((p) => p.id === pickedPlayerId.value)) return pickedPlayerId.value;
    return list[0]?.id ?? null;
  });

  const fog = computed(() => {
    const doc = edit.liveDoc;
    return doc && playerId.value ? fogOfPlayer(doc, playerId.value) : undefined;
  });

  /** The veil to draw; rebuilt only when this fog block itself changes. */
  const visual = computed<FogVisual | null>(() => {
    const doc = edit.liveDoc;
    const f = fog.value;
    return doc && f ? { size: doc.size, hidden: fogGrid(f, doc.size) } : null;
  });

  const totalCells = computed(() => (edit.liveDoc ? edit.liveDoc.size * edit.liveDoc.size : 0));
  const hiddenCells = computed(() => players.value.find((p) => p.id === playerId.value)?.hidden ?? 0);

  function setPlayer(id: string): void {
    pickedPlayerId.value = id;
  }
  function setBrush(b: FogBrush): void {
    brush.value = b;
  }
  function setAroundRadius(r: number): void {
    aroundRadius.value = Math.max(0, Math.min(24, Math.round(r) || 0));
  }

  /** The ops of one brush dab over `cells` (the canvas previews them and commits the stroke). */
  function paintOps(cells: Iterable<{ x: number; y: number }>): EditOp[] {
    const doc = edit.liveDoc;
    const f = fog.value;
    if (!doc || !f) return [];
    return fogPaintOps(doc, f.id, cells, brush.value === "hide");
  }

  function presetOps(id: string, preset: FogPreset): EditOp[] {
    const doc = edit.liveDoc;
    const player = players.value.find((p) => p.id === id);
    if (!doc || !player) return [];
    if (preset === "around") return fogAroundOwnedOps(doc, id, aroundRadius.value);
    return fogFillOps(doc, player.fogId, preset === "hide");
  }

  /** Set one player's fog by a preset, as one undoable step. False when it already is that. */
  function applyPreset(id: string, preset: FogPreset): boolean {
    const ops = presetOps(id, preset);
    if (!ops.length) return false;
    edit.commit(ops);
    return true;
  }

  /** The same preset for every playable side, as ONE undoable step; the number of fogs changed. */
  function applyPresetToAll(preset: FogPreset): number {
    const ops = players.value.filter((p) => !p.neutral).flatMap((p) => presetOps(p.id, preset));
    if (ops.length) edit.commit(ops);
    return ops.length;
  }

  /** Give `toId` the fog of `fromId`. */
  function copyFog(fromId: string, toId: string): boolean {
    const doc = edit.liveDoc;
    const from = players.value.find((p) => p.id === fromId);
    const to = players.value.find((p) => p.id === toId);
    if (!doc || !from || !to) return false;
    const ops = fogCopyOps(doc, from.fogId, to.fogId);
    if (!ops.length) return false;
    edit.commit(ops);
    return true;
  }

  return {
    players, playerId, brush, aroundRadius, fog, visual, totalCells, hiddenCells,
    setPlayer, setBrush, setAroundRadius, paintOps, applyPreset, applyPresetToAll, copyFog,
  };
});
