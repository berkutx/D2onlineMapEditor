/**
 * LocationLayer — visual highlight for event LOCATIONS (spawn points / trigger
 * regions). A location of radius `r` covers the Chebyshev (2r+1)² cell square around
 * its cell (r = 0 → a single cell, e.g. a unit spawn). The editor draws a generated
 * "loc_<r>" radius image on top of everything; here we draw a translucent iso area
 * with an outline as a non-interactive overlay.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 */
import { Container, Graphics } from "pixi.js";
import type { MapObject } from "@d2/map-schema";
import { cellToWorld } from "./iso.js";

export class LocationLayer {
  readonly view: Container;

  constructor() {
    this.view = new Container();
    this.view.label = "locations";
    this.view.eventMode = "none"; // pure overlay, never eats pointer events
  }

  /** Build highlights from the document's `location` objects. */
  build(objects: ReadonlyArray<MapObject>): void {
    this.view.removeChildren().forEach((c) => c.destroy());
    const g = new Graphics();
    for (const o of objects) {
      if (o.type !== "location") continue;
      const r = o.radius ?? 0;
      const x0 = o.pos.x - r;
      const y0 = o.pos.y - r;
      const x1 = o.pos.x + r + 1; // cell span is [c, c+1)
      const y1 = o.pos.y + r + 1;
      const a = cellToWorld(x0, y0);
      const b = cellToWorld(x1, y0);
      const c = cellToWorld(x1, y1);
      const d = cellToWorld(x0, y1);
      g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
      g.fill({ color: 0x33ddff, alpha: 0.14 });
      g.stroke({ color: 0x66e6ff, alpha: 0.7, width: 1 });
    }
    this.view.addChild(g);
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
