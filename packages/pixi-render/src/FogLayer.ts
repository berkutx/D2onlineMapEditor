/**
 * FogLayer — ONE player's fog of war as the map file stores it: hidden cells under a dark
 * veil, with a contour where hidden meets open. An editor aid (the «Туман» tool shows the
 * fog of the player being edited); the layer is a pure overlay and never eats pointer events.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest (the run geometry lives in fogRuns.ts).
 */
import { Container, Graphics } from "pixi.js";
import { cellToWorld } from "./iso.js";
import { fogRuns, type FogVisual } from "./fogRuns.js";

const VEIL_COLOR = 0x05070d;
const VEIL_ALPHA = 0.6;
const EDGE_COLOR = 0x9fb8ff;

export class FogLayer {
  readonly view: Container;
  private readonly veil = new Graphics();
  private readonly edge = new Graphics();

  constructor() {
    this.view = new Container();
    this.view.label = "fog";
    this.view.eventMode = "none";
    this.view.addChild(this.veil, this.edge);
  }

  /** Draw a fog, or clear the layer (null). */
  build(fog: FogVisual | null): void {
    this.veil.clear();
    this.edge.clear();
    if (!fog) return;
    const { size, hidden } = fog;
    const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < size && y < size && hidden[y * size + x] !== 0;
    const line = (x0: number, y0: number, x1: number, y1: number): void => {
      const p = cellToWorld(x0, y0);
      const q = cellToWorld(x1, y1);
      this.edge.moveTo(p.x, p.y).lineTo(q.x, q.y);
    };

    const runs = fogRuns(fog);
    for (const r of runs) {
      const a = cellToWorld(r.x0, r.y);
      const b = cellToWorld(r.x1, r.y);
      const c = cellToWorld(r.x1, r.y + 1);
      const d = cellToWorld(r.x0, r.y + 1);
      this.veil.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
    }
    if (runs.length) this.veil.fill({ color: VEIL_COLOR, alpha: VEIL_ALPHA });

    // the contour: every cell side between a hidden cell and an open one (the map edge is not one)
    let any = false;
    for (const r of runs) {
      for (let x = r.x0; x < r.x1; x++) {
        if (r.y > 0 && !at(x, r.y - 1)) { line(x, r.y, x + 1, r.y); any = true; }
        if (r.y < size - 1 && !at(x, r.y + 1)) { line(x, r.y + 1, x + 1, r.y + 1); any = true; }
      }
      if (r.x0 > 0) { line(r.x0, r.y, r.x0, r.y + 1); any = true; }
      if (r.x1 < size) { line(r.x1, r.y, r.x1, r.y + 1); any = true; }
    }
    if (any) this.edge.stroke({ color: EDGE_COLOR, alpha: 0.85, width: 1.5 });
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
