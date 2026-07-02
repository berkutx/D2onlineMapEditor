/**
 * AnchorLayer — the editor-only «Связи» overlay: for every anchor (child object → parent
 * object) draws a dashed arrow from the child to its parent plus a small ⚓ badge on the
 * child. Anchors live in the EditorProject (never in the .sg); moving a parent drags the
 * whole anchored group. Non-interactive.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { MapDocument, MapObject } from "@d2/map-schema";
import { cellToWorld } from "./iso.js";

const LINK = 0xffb44a; // warm amber — distinct from event overlay + selection colors

export class AnchorLayer {
  readonly view: Container;

  constructor() {
    this.view = new Container();
    this.view.label = "anchors";
    this.view.eventMode = "none";
  }

  /** Redraw all anchor links. `anchors` = child id → parent id. */
  build(doc: MapDocument, anchors: Record<string, string>): void {
    this.view.removeChildren().forEach((c) => c.destroy());
    const entries = Object.entries(anchors);
    if (!entries.length) return;
    const byId = new Map<string, MapObject>();
    for (const o of doc.objects) byId.set(o.id, o);
    const center = (o: MapObject): { x: number; y: number } =>
      cellToWorld(o.pos.x + 0.5, o.pos.y + 0.5);

    const g = new Graphics();
    const badges: Text[] = [];
    for (const [childId, parentId] of entries) {
      const child = byId.get(childId);
      const parent = byId.get(parentId);
      if (!child || !parent) continue;
      const a = center(child);
      const b = center(parent);
      // dashed line child -> parent
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const steps = Math.max(1, Math.floor(len / 14));
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = t0 + 0.55 / steps;
        g.moveTo(a.x + dx * t0, a.y + dy * t0)
          .lineTo(a.x + dx * Math.min(t1, 1), a.y + dy * Math.min(t1, 1))
          .stroke({ color: LINK, alpha: 0.85, width: 2 });
      }
      // arrowhead at the parent end
      const ang = Math.atan2(dy, dx);
      for (const s of [-0.45, 0.45]) {
        g.moveTo(b.x, b.y)
          .lineTo(b.x - 10 * Math.cos(ang - s), b.y - 10 * Math.sin(ang - s))
          .stroke({ color: LINK, alpha: 0.95, width: 2 });
      }
      // ⚓ badge on the child
      const t = new Text({
        text: "⚓",
        style: { fontSize: 13, fill: LINK, stroke: { color: 0x000000, width: 3 } },
      });
      t.anchor.set(0.5, 1.1);
      t.position.set(a.x, a.y);
      t.eventMode = "none";
      badges.push(t);
    }
    this.view.addChild(g);
    for (const t of badges) this.view.addChild(t);
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
