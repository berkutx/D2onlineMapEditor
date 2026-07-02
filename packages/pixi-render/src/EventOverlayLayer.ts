/**
 * EventOverlayLayer — visualizes ONE selected scenario event on the map ("что будет и кто
 * куда идёт"): trigger zones (referenced locations), object markers (referenced stacks/cities/
 * ruins/sites/landmarks), and movement/spawn ARROWS for the effects that relocate stacks or
 * spawn at a location. Non-interactive; rebuilt whenever the selected event changes.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { MapDocument, MapEvent, MapObject } from "@d2/map-schema";
import { cellToWorld } from "./iso.js";

const ZONE = 0xffd54a; // amber — trigger zones
const MARK = 0x7ad1ff; // cyan — referenced objects
const ARROW = 0x66ff99; // green — movement / spawn arrows

type Pt = { x: number; y: number };

export class EventOverlayLayer {
  readonly view: Container;

  constructor() {
    this.view = new Container();
    this.view.label = "event-overlay";
    this.view.eventMode = "none";
  }

  /** Highlight the referenced objects + draw arrows for the selected event (null = clear). */
  build(doc: MapDocument, ev: MapEvent | null): void {
    this.view.removeChildren().forEach((c) => c.destroy());
    if (!ev) return;

    const byId = new Map<string, MapObject>();
    for (const o of doc.objects) byId.set(o.id, o);
    const center = (o: MapObject): Pt => cellToWorld(o.pos.x + 0.5, o.pos.y + 0.5);

    const g = new Graphics();
    const labels: Text[] = [];

    // collect every referenced id from conditions + effects (fields ending in Id / *Type refs)
    const refFields = ["locId", "cityId", "stackId", "siteId", "ruinId", "lmarkId", "templateId", "stackTmpId", "orderTarget"];
    const refs = new Set<string>();
    for (const part of [...ev.conditions, ...ev.effects] as Record<string, unknown>[]) {
      for (const k of refFields) {
        const v = part[k];
        if (typeof v === "string" && v) refs.add(v);
      }
    }

    // draw a zone/marker per referenced object
    for (const id of refs) {
      const o = byId.get(id);
      if (!o) continue;
      if (o.type === "location") {
        const r = o.radius ?? 0;
        const a = cellToWorld(o.pos.x - r, o.pos.y - r);
        const b = cellToWorld(o.pos.x + r + 1, o.pos.y - r);
        const c = cellToWorld(o.pos.x + r + 1, o.pos.y + r + 1);
        const d = cellToWorld(o.pos.x - r, o.pos.y + r + 1);
        g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
        g.fill({ color: ZONE, alpha: 0.18 });
        g.stroke({ color: ZONE, alpha: 0.95, width: 2 });
      } else {
        const p = center(o);
        g.circle(p.x, p.y, 14).stroke({ color: MARK, alpha: 0.95, width: 2 });
      }
    }

    // arrows for the relocation / spawn effects
    for (const eff of ev.effects as Record<string, unknown>[]) {
      const kind = eff.kind as string;
      if (kind === "moveStackToLocation") {
        this.arrow(g, byId.get(eff.stackTmpId as string), byId.get(eff.locId as string), byId, center);
      } else if (kind === "createStack") {
        const loc = byId.get(eff.locId as string);
        if (loc) this.spawnMark(g, labels, center(loc), "спавн");
      } else if (kind === "castSpellLocation" || kind === "changeTerrain" || kind === "changeFog" || kind === "removeMountains") {
        const loc = byId.get(eff.locId as string);
        if (loc && loc.type !== "location") continue; // zone already drawn above
      }
    }

    this.view.addChild(g);
    for (const t of labels) this.view.addChild(t);
  }

  /** An arrow from object `from` to object `to` (skips if either is missing). */
  private arrow(
    g: Graphics,
    from: MapObject | undefined,
    to: MapObject | undefined,
    _byId: Map<string, MapObject>,
    center: (o: MapObject) => Pt,
  ): void {
    if (!from || !to) return;
    const a = center(from);
    const b = center(to);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: ARROW, alpha: 0.95, width: 2.5 });
    // arrowhead
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const h = 12;
    for (const s of [-0.5, 0.5]) {
      g.moveTo(b.x, b.y)
        .lineTo(b.x - h * Math.cos(ang - s), b.y - h * Math.sin(ang - s))
        .stroke({ color: ARROW, alpha: 0.95, width: 2.5 });
    }
    g.circle(a.x, a.y, 4).fill({ color: ARROW, alpha: 0.9 });
  }

  private spawnMark(g: Graphics, labels: Text[], p: Pt, text: string): void {
    g.circle(p.x, p.y, 9).fill({ color: ARROW, alpha: 0.35 });
    g.circle(p.x, p.y, 9).stroke({ color: ARROW, alpha: 0.95, width: 2 });
    const t = new Text({
      text,
      style: { fontFamily: "sans-serif", fontSize: 10, fill: 0xccffdd, stroke: { color: 0x000000, width: 3 } },
    });
    t.anchor.set(0.5, 1.4);
    t.position.set(p.x, p.y);
    t.eventMode = "none";
    labels.push(t);
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
