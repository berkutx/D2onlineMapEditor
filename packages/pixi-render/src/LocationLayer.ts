/**
 * LocationLayer — visual highlight for event LOCATIONS (spawn points / trigger
 * regions). A location of radius `r` covers the Chebyshev (2r+1)² cell square around
 * its cell (r = 0 → a single cell, e.g. a unit spawn). The editor draws a generated
 * "loc_<r>" radius image on top of everything; here we draw a translucent iso area
 * with an outline as a non-interactive overlay.
 *
 * Each location renders into its OWN child container so `setFocus` can spotlight the
 * locations under the cursor (full alpha + name label) while the rest fade — the only
 * way a 400-location map stays readable.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { MapObject } from "@d2/map-schema";
import { cellToWorld } from "./iso.js";

/** Optional per-build inputs: editor-only captions, the selected object, and whether to show
 *  every location's name (vs only captioned + selected). `summaries` = compact «что здесь
 *  происходит» lines (scenario meaning) drawn UNDER the name — the host passes them only in
 *  the «Локации» mode so the normal view stays clean. */
export interface LocationOpts {
  captions?: Record<string, string>;
  selectedId?: string | null;
  showAllNames?: boolean;
  summaries?: Record<string, string[]>;
  /** Location ids to SKIP entirely — zone primitives render as ONE ZoneLayer shape instead. */
  hideIds?: ReadonlyArray<string>;
}

/** Non-focused locations fade to this alpha while something is hovered. */
const DIM = 0.12;

interface LocItem {
  root: Container;
  /** name/caption label; `alwaysOn` = shown regardless of focus (caption/selected/showAll). */
  label?: Text;
  /** scenario-summary lines under the name (locations-mode only); follows label visibility. */
  summary?: Text;
  alwaysOn: boolean;
}

export class LocationLayer {
  readonly view: Container;
  private items = new Map<string, LocItem>();
  private focus: ReadonlySet<string> | null = null;

  constructor() {
    this.view = new Container();
    this.view.label = "locations";
    this.view.eventMode = "none"; // pure overlay, never eats pointer events
  }

  /** Build highlights + labels from the document's `location` objects. A label (caption else
   *  name) is always CREATED (it appears on hover-focus) but only VISIBLE by default for
   *  captioned and selected locations (and all, when showAllNames). */
  build(objects: ReadonlyArray<MapObject>, opts: LocationOpts = {}): void {
    this.view.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.items.clear();
    const hide = opts.hideIds?.length ? new Set(opts.hideIds) : null;
    for (const o of objects) {
      if (o.type !== "location") continue;
      if (hide?.has(o.id)) continue; // zone primitive — drawn by ZoneLayer as one shape
      const root = new Container();
      root.eventMode = "none";
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
      const g = new Graphics();
      g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
      g.fill({ color: 0x33ddff, alpha: sel ? 0.22 : 0.14 });
      g.stroke({ color: sel ? 0xffd54a : 0x66e6ff, alpha: sel ? 0.95 : 0.7, width: sel ? 2 : 1 });
      root.addChild(g);
      if (sel) {
        // resize HANDLE at the bottom (SE) vertex — the host hit-tests the same world point
        // (locations tool: drag = radius). Purely visual here (the layer never eats events).
        const hs = 7;
        const h = new Graphics();
        h.poly([c.x, c.y - hs, c.x + hs, c.y, c.x, c.y + hs, c.x - hs, c.y]);
        h.fill({ color: 0xffd54a, alpha: 0.95 });
        h.stroke({ color: 0x000000, alpha: 0.6, width: 1 });
        root.addChild(h);
      }

      const caption = opts.captions?.[o.id];
      const text = caption || o.name || "";
      const alwaysOn = !!text && (!!caption || sel || !!opts.showAllNames);
      const center = cellToWorld(o.pos.x + 0.5, o.pos.y + 0.5);
      let label: Text | undefined;
      if (text) {
        label = new Text({
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
        label.anchor.set(0.5);
        label.position.set(center.x, center.y);
        label.eventMode = "none";
        label.visible = alwaysOn;
        root.addChild(label);
      }
      // scenario meaning lines («⚡ вход → …», «➜ приказ: охранять») under the name
      const sumLines = opts.summaries?.[o.id];
      let summary: Text | undefined;
      if (sumLines?.length) {
        summary = new Text({
          text: sumLines.join("\n"),
          style: {
            fontFamily: "sans-serif",
            fontSize: 9,
            fill: 0xcfe8ff,
            stroke: { color: 0x000000, width: 3 },
            align: "center",
            lineHeight: 12,
          },
        });
        summary.anchor.set(0.5, 0);
        summary.position.set(center.x, center.y + (label ? 8 : 2));
        summary.eventMode = "none";
        summary.visible = label ? label.visible : alwaysOn;
        root.addChild(summary);
      }

      this.items.set(o.id, { root, label, summary, alwaysOn });
      this.view.addChild(root);
    }
    this.applyFocus(); // a rebuild keeps the current hover spotlight
  }

  /** Spotlight `ids` (full alpha + labels), fade the rest; null = normal (no hover). */
  setFocus(ids: ReadonlySet<string> | null): void {
    this.focus = ids && ids.size ? ids : null;
    this.applyFocus();
  }

  private applyFocus(): void {
    for (const [id, it] of this.items) {
      const focused = this.focus?.has(id) ?? false;
      it.root.alpha = this.focus === null || focused ? 1 : DIM;
      if (it.label) it.label.visible = it.alwaysOn || focused;
      if (it.summary) it.summary.visible = it.alwaysOn || focused;
    }
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.items.clear();
    this.view.destroy({ children: true });
  }
}
