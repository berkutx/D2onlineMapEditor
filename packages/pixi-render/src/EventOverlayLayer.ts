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
const LINK = 0xffc178; // warm — object-selection link threads

type Pt = { x: number; y: number };

/** Ref fields that point at map entities (shared by the event view + object links). */
const REF_FIELDS = ["locId", "cityId", "stackId", "siteId", "ruinId", "lmarkId", "stackTmpId", "orderTarget"] as const;

export class EventOverlayLayer {
  readonly view: Container;
  /** selected EVENT visuals (zones/markers/arrows) — rebuilt on event selection. */
  private readonly evC = new Container();
  /** selected OBJECT link threads — rebuilt on object selection; coexists with evC. */
  private readonly linkC = new Container();

  constructor() {
    this.view = new Container();
    this.view.label = "event-overlay";
    this.view.eventMode = "none";
    this.evC.eventMode = "none";
    this.linkC.eventMode = "none";
    this.view.addChild(this.linkC, this.evC);
  }

  /** Highlight the referenced objects + draw arrows for the selected event (null = clear). */
  build(doc: MapDocument, ev: MapEvent | null): void {
    this.evC.removeChildren().forEach((c) => c.destroy());
    if (!ev) return;

    const byId = new Map<string, MapObject>();
    for (const o of doc.objects) byId.set(o.id, o);
    const center = (o: MapObject): Pt => cellToWorld(o.pos.x + 0.5, o.pos.y + 0.5);

    const g = new Graphics();
    const labels: Text[] = [];

    // collect every referenced id from conditions + effects
    const refs = new Set<string>();
    for (const part of [...ev.conditions, ...ev.effects] as Record<string, unknown>[]) {
      for (const k of REF_FIELDS) {
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

    this.evC.addChild(g);
    for (const t of labels) this.evC.addChild(t);
  }

  /**
   * Link threads for a SELECTED OBJECT: warm dashed-feel arcs from it to every map entity
   * wired to it through `events` (the union of its events' refs), plus a soft marker on
   * each linked entity. Selection-scoped by design — drawing EVERY event link permanently
   * is unreadable on dense maps; a click shows exactly one object's web, deselect clears.
   */
  buildObjectLinks(doc: MapDocument, fromId: string | null, events: readonly MapEvent[]): void {
    this.linkC.removeChildren().forEach((c) => c.destroy());
    if (!fromId || !events.length) return;
    const byId = new Map<string, MapObject>();
    for (const o of doc.objects) byId.set(o.id, o);
    const from = byId.get(fromId);
    if (!from) return;
    const center = (o: MapObject): Pt => cellToWorld(o.pos.x + 0.5, o.pos.y + 0.5);
    const a = center(from);

    // union of linked entity ids across all of the object's events (excluding itself)
    const linked = new Set<string>();
    for (const ev of events) {
      for (const part of [...ev.conditions, ...ev.effects] as Record<string, unknown>[]) {
        for (const k of REF_FIELDS) {
          const v = part[k];
          if (typeof v === "string" && v && v !== fromId && byId.has(v)) linked.add(v);
        }
      }
    }
    if (!linked.size) return;

    const g = new Graphics();
    const MAX_LINKS = 30; // a runaway web reads as noise — cap and let the inspector list the rest
    let n = 0;
    for (const id of linked) {
      if (n++ >= MAX_LINKS) break;
      const b = center(byId.get(id)!);
      // a gentle arc (lifted control point) — visually distinct from the straight green
      // movement arrows of the selected-event view
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - Math.hypot(b.x - a.x, b.y - a.y) / 6 - 8;
      g.moveTo(a.x, a.y).quadraticCurveTo(mx, my, b.x, b.y)
        .stroke({ color: LINK, alpha: 0.8, width: 1.5 });
      g.circle(b.x, b.y, 6).stroke({ color: LINK, alpha: 0.9, width: 1.5 });
    }
    g.circle(a.x, a.y, 4).fill({ color: LINK, alpha: 0.95 });
    this.linkC.addChild(g);
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
