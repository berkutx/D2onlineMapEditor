/**
 * LocationLayer — visual highlight for event LOCATIONS (spawn points / trigger
 * regions). A location of radius `r` covers the Chebyshev (2r+1)² cell square around
 * its cell (r = 0 → a single cell, e.g. a unit spawn). The editor draws a generated
 * "loc_<r>" radius image on top of everything; here we draw a translucent iso area
 * with an outline as a non-interactive overlay.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { MapObject } from "@d2/map-schema";
import { cellToWorld } from "./iso.js";

/** Optional per-build inputs: editor-only captions, the selected object, and whether to show
 *  every location's name (vs only captioned + selected). */
export interface LocationOpts {
  captions?: Record<string, string>;
  selectedId?: string | null;
  showAllNames?: boolean;
}

export class LocationLayer {
  readonly view: Container;

  constructor() {
    this.view = new Container();
    this.view.label = "locations";
    this.view.eventMode = "none"; // pure overlay, never eats pointer events
  }

  /** Build highlights + labels from the document's `location` objects. A label (caption else
   *  name) is drawn for captioned and selected locations (and all, when showAllNames). */
  build(objects: ReadonlyArray<MapObject>, opts: LocationOpts = {}): void {
    this.view.removeChildren().forEach((c) => c.destroy());
    const g = new Graphics();
    const labels: Text[] = [];
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
      const sel = o.id === opts.selectedId;
      g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
      g.fill({ color: 0x33ddff, alpha: sel ? 0.22 : 0.14 });
      g.stroke({ color: sel ? 0xffd54a : 0x66e6ff, alpha: sel ? 0.95 : 0.7, width: sel ? 2 : 1 });

      const caption = opts.captions?.[o.id];
      const text = caption || o.name || "";
      if (text && (caption || sel || opts.showAllNames)) {
        const center = cellToWorld(o.pos.x + 0.5, o.pos.y + 0.5);
        const t = new Text({
          text,
          style: {
            fontFamily: "sans-serif",
            fontSize: 11,
            fontWeight: caption ? "600" : "400",
            fill: caption ? 0xffe08a : 0xffffff,
            stroke: { color: 0x000000, width: 3 },
            align: "center",
          },
        });
        t.anchor.set(0.5);
        t.position.set(center.x, center.y);
        t.eventMode = "none";
        labels.push(t);
      }
    }
    this.view.addChild(g);
    for (const t of labels) this.view.addChild(t);
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
