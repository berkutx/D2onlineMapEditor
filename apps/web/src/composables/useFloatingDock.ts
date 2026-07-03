/**
 * useFloatingDock — makes a floating card (minimap, history, …) draggable by a handle
 * and remembers its position in localStorage so it survives reloads.
 *
 * Position model: until the user drags, `pos` is null and the card keeps its CSS default
 * corner (right/bottom via the component's own class). On the first drag it switches to an
 * absolute top-left offset RELATIVE TO the card's offsetParent (the .app-main canvas area),
 * clamped so the card can never be dragged fully off-screen. The offset persists per dock id.
 *
 * Drag vs click: the handle may double as a clickable header (History toggles on click). We
 * only treat a pointer gesture as a drag once it moves past a small threshold; a genuine drag
 * then swallows the trailing click so the header's own @click doesn't also fire.
 */
import { computed, onBeforeUnmount, onMounted, ref, type Ref } from "vue";

export interface DockPos {
  x: number;
  y: number;
}

const KEY = (id: string): string => `d2.dock.${id}.v1`;
const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag

function loadPos(id: string): DockPos | null {
  try {
    const raw = localStorage.getItem(KEY(id));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<DockPos>;
    if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y };
  } catch {
    /* corrupt / unavailable storage — fall back to the CSS default corner */
  }
  return null;
}
function savePos(id: string, p: DockPos): void {
  try {
    localStorage.setItem(KEY(id), JSON.stringify(p));
  } catch {
    /* storage unavailable (private mode / quota) — ignore */
  }
}

export function useFloatingDock(id: string, cardRef: Ref<HTMLElement | null>) {
  const pos = ref<DockPos | null>(loadPos(id));

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  function parentEl(): HTMLElement | null {
    return (cardRef.value?.offsetParent as HTMLElement | null) ?? null;
  }

  /** Keep the card fully inside its offsetParent (the canvas area). */
  function clamp(p: DockPos): DockPos {
    const card = cardRef.value;
    const parent = parentEl();
    if (!card || !parent) return p;
    const maxX = Math.max(0, parent.clientWidth - card.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - card.offsetHeight);
    return {
      x: Math.max(0, Math.min(p.x, maxX)),
      y: Math.max(0, Math.min(p.y, maxY)),
    };
  }

  /** Current top-left of the card relative to its offsetParent (seeds the first drag). */
  function currentTopLeft(): DockPos {
    const card = cardRef.value;
    const parent = parentEl();
    if (!card || !parent) return { x: 0, y: 0 };
    const cr = card.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    return { x: cr.left - pr.left, y: cr.top - pr.top };
  }

  function onMove(e: PointerEvent): void {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    moved = true;
    pos.value = clamp({ x: originX + dx, y: originY + dy });
    e.preventDefault();
  }

  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (!dragging) return;
    dragging = false;
    if (moved && pos.value) {
      savePos(id, pos.value);
      // Swallow the click that fires after a real drag, so a header that also toggles on
      // click (History) doesn't collapse just because it was dragged. A big mouse drag may
      // NOT emit a trailing click, so also disarm after a beat — otherwise the armed listener
      // would eat the NEXT genuine click.
      const cleanup = (): void => window.removeEventListener("click", swallow, true);
      const swallow = (ev: Event): void => {
        ev.stopPropagation();
        ev.preventDefault();
        cleanup();
      };
      window.addEventListener("click", swallow, true);
      window.setTimeout(cleanup, 300);
    }
  }

  /** Attach to the drag handle's @pointerdown. Ignores clicks on buttons inside the handle. */
  function onHandlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.closest("button")) return; // let close/toggle buttons work
    if (!cardRef.value) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const seed = pos.value ?? currentTopLeft();
    originX = seed.x;
    originY = seed.y;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function reclamp(): void {
    if (pos.value) pos.value = clamp(pos.value);
  }

  onMounted(() => {
    window.addEventListener("resize", reclamp);
    // A saved position was measured against a possibly different window size — re-clamp once
    // the card has rendered (so offsetWidth/Height are known).
    if (pos.value) requestAnimationFrame(reclamp);
  });
  onBeforeUnmount(() => window.removeEventListener("resize", reclamp));

  /** Inline style: empty (use CSS default corner) until dragged, then absolute top-left. */
  const style = computed<Record<string, string>>(() =>
    pos.value
      ? { left: `${pos.value.x}px`, top: `${pos.value.y}px`, right: "auto", bottom: "auto" }
      : {},
  );

  /** Snap back to the CSS default corner (clears the saved position). */
  function resetPos(): void {
    pos.value = null;
    try {
      localStorage.removeItem(KEY(id));
    } catch {
      /* ignore */
    }
  }

  return { style, onHandlePointerDown, resetPos, pos };
}
