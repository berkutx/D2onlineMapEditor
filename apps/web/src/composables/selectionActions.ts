/**
 * Group actions on the multi-selection (Shift+клик / Shift+рамка): group (anchor all to
 * the primary), ungroup, and delete — shared by the SelectionActionBar and hotkeys.
 */
import { computed } from "vue";
import { ElMessage } from "element-plus";
import { applyOps, deleteMountainOps, type EditOp } from "@d2/map-edit";
import { useToolStore } from "../stores/toolStore";
import { useEditStore } from "../stores/editStore";

/** Types the byte writer can delete (incl. cascades). Sites/crystals/capitals stay out. */
const DELETABLE = new Set(["landmark", "stack", "mountains", "village", "treasure", "ruin"]);

export function useSelectionActions() {
  const toolStore = useToolStore();
  const editStore = useEditStore();

  const count = computed(() => toolStore.selectedIds.length);

  /** ⚓ Сгруппировать: anchor every selected object to the PRIMARY one (one click instead
   *  of N-1 ctx-menu round trips). Cycle-guarded by editStore.setAnchor itself. */
  function groupSelected(): void {
    const primary = toolStore.selectedId;
    if (!primary || toolStore.selectedIds.length < 2) return;
    let n = 0;
    for (const id of toolStore.selectedIds) {
      if (id === primary) continue;
      editStore.setAnchor(id, primary);
      n++;
    }
    ElMessage.success(`Сгруппировано: ${n} → якорь к выбранному`);
  }

  /** Снять якоря со всех выделенных (обратное действие). */
  function ungroupSelected(): void {
    let n = 0;
    for (const id of toolStore.selectedIds) {
      if (editStore.anchors[id]) {
        editStore.clearAnchor(id);
        n++;
      }
    }
    if (n) ElMessage.success(`Якоря сняты: ${n}`);
    else ElMessage.info("У выделенных объектов нет якорей");
  }

  /** 🗑 Удалить выделенное ОДНИМ страйком (один undo). Ops для гор считаются
   *  ПОСЛЕДОВАТЕЛЬНО против эволюционирующего дока (позиционные id перенумеруются),
   *  причём горы идут по УБЫВАНИЮ индекса — удаление старшего не сдвигает младшие.
   *  Неудаляемое (гости, города-с-гостем, столицы, сайты…) пропускается с одним варном. */
  function deleteSelected(): void {
    let d = editStore.liveDoc;
    if (!d || toolStore.selectedIds.length === 0) return;
    const mtnIdx = (id: string): number => parseInt(id.slice(id.indexOf("#") + 1), 10) || 0;
    const ids = [...toolStore.selectedIds].sort((a, b) => {
      const am = a.includes("#"), bm = b.includes("#");
      if (am && bm) return mtnIdx(b) - mtnIdx(a); // mountains: highest index first
      return am === bm ? 0 : am ? -1 : 1; // mountains first (their ops renumber the doc)
    });
    const all: EditOp[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const o = d.objects.find((x) => x.id === id);
      if (!o) continue;
      let ops: EditOp[] | null = null;
      if (o.type === "mountains") {
        ops = deleteMountainOps(d, id);
      } else if (!DELETABLE.has(o.type)) {
        skipped.push(`${o.type} ${id}`);
      } else if (
        (o.type === "stack" && ((o as { inside?: string }).inside || (o as { garrisoned?: boolean }).garrisoned)) ||
        (o.type === "village" && (o as { stackRef?: string }).stackRef)
      ) {
        skipped.push(`гость/город-с-гостем ${id}`);
      } else {
        ops = [{ kind: "deleteObject", id }];
      }
      if (ops && ops.length) {
        all.push(...ops);
        d = applyOps(d, ops);
      }
    }
    if (all.length) {
      editStore.commit(all);
      toolStore.setSelectedId(null);
    }
    if (skipped.length) {
      ElMessage.warning(`Пропущено (не удаляется): ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? "…" : ""}`);
    }
  }

  function clearSelection(): void {
    toolStore.setSelectedId(null);
  }

  return { count, groupSelected, ungroupSelected, deleteSelected, clearSelection };
}
