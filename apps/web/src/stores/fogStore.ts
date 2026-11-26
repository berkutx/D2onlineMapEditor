/**
 * The «Туман» tool: whose fog of war is shown and painted, and what the brush does.
 *
 * A fog is the player's MidgardMapFog block of the map file (see @d2/map-edit fog.ts for the
 * bit layout and for what the game does with it). The veil on the canvas and the counters
 * here are derived from the live document, so an undo, a peer's edit or a reloaded map show
 * up without any bookkeeping.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { fogFillOps, fogGrid, fogHiddenCount, fogOfPlayer, fogPaintOps, type EditOp } from "@d2/map-edit";
import type { FogVisual } from "@d2/pixi-render";
import { useEditStore } from "./editStore";

/** What a stroke of the fog brush does to the cells under it. */
export type FogBrush = "open" | "hide";

/** Race record index of the neutral player (PlayerInfo.race). */
const NEUTRAL_RACE = 4;

export const useFogStore = defineStore("fog", () => {
  const edit = useEditStore();

  /** The player picked in the tool; null = not picked yet (the first playable one is used). */
  const pickedPlayerId = ref<string | null>(null);
  const brush = ref<FogBrush>("open");

  /** Players that have a fog block, playable ones first (the neutral player sees everything
   *  in the game, so its fog is rarely the one to edit). */
  const players = computed(() => {
    const doc = edit.liveDoc;
    if (!doc) return [];
    return doc.players
      .filter((p) => fogOfPlayer(doc, p.id))
      .map((p) => ({ id: p.id, name: p.name || p.id, color: p.color ?? "", neutral: p.race === NEUTRAL_RACE }))
      .sort((a, b) => Number(a.neutral) - Number(b.neutral));
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
  const hiddenCells = computed(() => (edit.liveDoc && fog.value ? fogHiddenCount(fog.value, edit.liveDoc.size) : 0));

  function setPlayer(id: string): void {
    pickedPlayerId.value = id;
  }
  function setBrush(b: FogBrush): void {
    brush.value = b;
  }

  /** The ops of one brush dab over `cells` (the canvas previews them and commits the stroke). */
  function paintOps(cells: Iterable<{ x: number; y: number }>): EditOp[] {
    const doc = edit.liveDoc;
    const f = fog.value;
    if (!doc || !f) return [];
    return fogPaintOps(doc, f.id, cells, brush.value === "hide");
  }

  /** Hide or open the whole map for the player, as one undoable step. */
  function fill(hidden: boolean): boolean {
    const doc = edit.liveDoc;
    const f = fog.value;
    if (!doc || !f) return false;
    const ops = fogFillOps(doc, f.id, hidden);
    if (!ops.length) return false;
    edit.commit(ops);
    return true;
  }

  return { players, playerId, brush, fog, visual, totalCells, hiddenCells, setPlayer, setBrush, paintOps, fill };
});
