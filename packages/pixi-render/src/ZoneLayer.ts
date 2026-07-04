/**
 * ZoneLayer — free-form editor ZONES drawn as ONE entity each: a translucent fill over
 * the zone's cell mask plus a single OUTER contour (only edges whose neighbour is outside
 * the mask), the zone name at the centroid, optional aggregated role badges + meaning
 * lines. The zone's underlying location PRIMITIVES are hidden from LocationLayer (the
 * host passes their ids via LocationOpts.hideIds), so a 30-primitive swamp reads as one
 * named shape — not thirty circles.
 *
 * Selection: `selected` zones get the gold accent (matching LocationLayer's selected look).
 * The layer is a pure overlay (eventMode none) — picking/dragging lives in the host.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 */
import { Container, Graphics, Text } from "pixi.js";
import { cellToWorld } from "./iso.js";

export interface ZoneVisual {
  id: string;
  name: string;
  /** "x,y" mask keys (the drawn free form, NOT the tiled primitives). */
  cells: ReadonlyArray<string>;
  selected?: boolean;
  /** aggregated role icons line («⚡3 ✨») shown after the name, locations-mode only */
  badges?: string;
  /** compact scenario-meaning lines under the name (locations-mode only) */
  summary?: ReadonlyArray<string>;
}

export class ZoneLayer {
  readonly view: Container;

  constructor() {
    this.view = new Container();
    this.view.label = "zones";
    this.view.eventMode = "none";
  }

  build(zones: ReadonlyArray<ZoneVisual>): void {
    this.view.removeChildren().forEach((c) => c.destroy({ children: true }));
    for (const z of zones) {
      const root = new Container();
      root.eventMode = "none";
      const mask = new Set(z.cells);
      const fillColor = 0x33ddff;
      const stroke = z.selected ? 0xffd54a : 0x66e6ff;

      const g = new Graphics();
      // translucent fill, cell by cell (masks may be non-convex or even disjoint)
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const key of mask) {
        const [xs, ys] = key.split(",");
        const x = Number(xs);
        const y = Number(ys);
        const a = cellToWorld(x, y);
        const b = cellToWorld(x + 1, y);
        const c = cellToWorld(x + 1, y + 1);
        const d = cellToWorld(x, y + 1);
        g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
        g.fill({ color: fillColor, alpha: z.selected ? 0.16 : 0.09 });
        sx += x + 0.5;
        sy += y + 0.5;
        n++;
      }
      // ONE outer contour: draw only the edges whose neighbour cell is outside the mask
      const edges = new Graphics();
      for (const key of mask) {
        const [xs, ys] = key.split(",");
        const x = Number(xs);
        const y = Number(ys);
        const a = cellToWorld(x, y);
        const b = cellToWorld(x + 1, y);
        const c = cellToWorld(x + 1, y + 1);
        const d = cellToWorld(x, y + 1);
        if (!mask.has(`${x},${y - 1}`)) edges.moveTo(a.x, a.y).lineTo(b.x, b.y);
        if (!mask.has(`${x + 1},${y}`)) edges.moveTo(b.x, b.y).lineTo(c.x, c.y);
        if (!mask.has(`${x},${y + 1}`)) edges.moveTo(c.x, c.y).lineTo(d.x, d.y);
        if (!mask.has(`${x - 1},${y}`)) edges.moveTo(d.x, d.y).lineTo(a.x, a.y);
      }
      edges.stroke({ color: stroke, alpha: z.selected ? 0.95 : 0.8, width: z.selected ? 2.5 : 1.5 });
      root.addChild(g, edges);

      if (n > 0) {
        const center = cellToWorld(sx / n, sy / n);
        const title = new Text({
          text: z.badges ? `${z.name}  ${z.badges}` : z.name,
          style: {
            fontFamily: "sans-serif",
            fontSize: 12,
            fontWeight: "600",
            fill: z.selected ? 0xffe08a : 0xbdeeff,
            stroke: { color: 0x000000, width: 3 },
            align: "center",
          },
        });
        title.anchor.set(0.5);
        title.position.set(center.x, center.y);
        title.eventMode = "none";
        root.addChild(title);
        if (z.summary?.length) {
          const sum = new Text({
            text: z.summary.join("\n"),
            style: {
              fontFamily: "sans-serif",
              fontSize: 9,
              fill: 0xcfe8ff,
              stroke: { color: 0x000000, width: 3 },
              align: "center",
              lineHeight: 12,
            },
          });
          sum.anchor.set(0.5, 0);
          sum.position.set(center.x, center.y + 8);
          sum.eventMode = "none";
          root.addChild(sum);
        }
      }
      this.view.addChild(root);
    }
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
