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
const LINK = 0xffc178; // warm — the event-node chips of the object link threads

type Pt = { x: number; y: number };

/** Ref fields that point at map entities (the selected-EVENT view). */
const REF_FIELDS = ["locId", "cityId", "stackId", "siteId", "ruinId", "lmarkId", "stackTmpId", "orderTarget"] as const;

/** Role class of one link participant — MUST mirror the host's scenarioRoles.RoleClass
 *  (colors below mirror its ROLE_META; documented coupling, like ScenarioRolesLayer). */
export type LinkRole = "trigger" | "target" | "spawn" | "destination" | "env";

/** One participant of an event's link web: an object (by CELL coords) + its role. */
export interface LinkPart {
  id: string;
  x: number; // cell coords (anchor)
  y: number;
  cls: LinkRole;
  /** true = this is the SELECTED object (its threads draw thicker). */
  self?: boolean;
}

/** One EVENT of the selected object with every participant it wires. */
export interface LinkGroup {
  eventId: string;
  name: string;
  parts: LinkPart[];
}

/** What a pointer hit on the link web resolves to. */
export interface LinkHit {
  eventId: string;
  name: string;
  kind: "node" | "arc";
}

const ROLE_COLOR: Record<LinkRole, number> = {
  trigger: 0xe6a23c,
  target: 0xf56c6c,
  spawn: 0x67c23a,
  destination: 0x409eff,
  env: 0xb07dd8,
};

/** Point on a quadratic bezier a→(ctrl c)→b at t. */
function qPoint(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}
/** Tangent direction of the same bezier at t (unnormalized). */
function qTangent(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: 2 * u * (c.x - a.x) + 2 * t * (b.x - c.x), y: 2 * u * (c.y - a.y) + 2 * t * (b.y - c.y) };
}

/** Distance from point (px,py) to segment a→b. */
function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

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

  /** Per-event geometry of the link web (world space) for hover hit-testing + focus. */
  private linkGeom: Array<{
    eventId: string;
    name: string;
    node: Pt;
    arcs: Array<{ a: Pt; c: Pt; b: Pt }>;
    view: Container;
    label: Text;
  }> = [];
  private linkFocus: string | null = null;

  /**
   * Link threads for a SELECTED OBJECT, grouped by EVENT so causality reads directly:
   * each event is a diamond NODE; arcs from its TRIGGER participants flow INTO the node
   * (arrowhead at the node) and arcs OUT of the node flow to the objects the event
   * changes (arrowhead at the object, colored by role: 🎯/✨/➜/☁). «Стрелка выходит из
   * меня — я причина; стрелка входит в меня — я следствие.» Selection-scoped by design —
   * drawing EVERY event link permanently is unreadable on dense maps.
   */
  buildObjectLinks(fromId: string | null, groups: readonly LinkGroup[]): void {
    this.linkC.removeChildren().forEach((c) => c.destroy());
    this.linkGeom = [];
    this.linkFocus = null;
    if (!fromId || !groups.length) return;

    // node collision buckets: events over the same participants must not stack their chips
    const buckets = new Map<string, number>();
    let selfPt: Pt | null = null;

    for (const grp of groups) {
      const pts = grp.parts.map((p) => ({ ...p, w: cellToWorld(p.x + 0.5, p.y + 0.5) }));
      if (!pts.length) continue;
      const self = pts.find((p) => p.self);
      if (self && !selfPt) selfPt = self.w;

      // node = centroid of the participants, lifted; single-participant events float above it
      const cx = pts.reduce((s, p) => s + p.w.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.w.y, 0) / pts.length;
      const spread = Math.max(...pts.map((p) => Math.hypot(p.w.x - cx, p.w.y - cy)));
      let node: Pt = { x: cx, y: cy - Math.max(56, spread / 4) };
      const key = `${Math.round(node.x / 90)},${Math.round(node.y / 60)}`;
      const k = buckets.get(key) ?? 0;
      buckets.set(key, k + 1);
      if (k > 0) node = { x: node.x + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 52, y: node.y - (k % 3) * 20 };

      const view = new Container();
      view.eventMode = "none";
      const g = new Graphics();
      const arcs: Array<{ a: Pt; c: Pt; b: Pt }> = [];

      for (const p of pts) {
        const into = p.cls === "trigger"; // causes flow INTO the event node
        const a = into ? p.w : node;
        const b = into ? node : p.w;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (dist < 4) continue; // degenerate (participant under the node)
        // gentle arc: control point lifted off the chord midpoint
        const c: Pt = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - Math.max(10, dist / 7) };
        arcs.push({ a, c, b });
        const color = ROLE_COLOR[p.cls];
        const width = p.self ? 3 : 2;
        g.moveTo(a.x, a.y).quadraticCurveTo(c.x, c.y, b.x, b.y)
          .stroke({ color: 0x000000, alpha: 0.5, width: width + 2.5 });
        g.moveTo(a.x, a.y).quadraticCurveTo(c.x, c.y, b.x, b.y)
          .stroke({ color, alpha: p.self ? 0.98 : 0.85, width });
        // arrowhead near the destination end, oriented along the curve tangent
        const tip = qPoint(a, c, b, into ? 0.86 : 0.9);
        const tan = qTangent(a, c, b, into ? 0.86 : 0.9);
        const ang = Math.atan2(tan.y, tan.x);
        const h = p.self ? 12 : 10;
        for (const s of [-0.45, 0.45]) {
          g.moveTo(tip.x, tip.y)
            .lineTo(tip.x - h * Math.cos(ang - s), tip.y - h * Math.sin(ang - s))
            .stroke({ color, alpha: 0.95, width });
        }
        // effect targets get a role-colored ring marker (triggers keep a small source dot)
        if (!into) {
          g.circle(b.x, b.y, 7).stroke({ color: 0x000000, alpha: 0.5, width: 4 });
          g.circle(b.x, b.y, 7).stroke({ color, alpha: 0.95, width: 2 });
        } else {
          g.circle(a.x, a.y, 3.5).fill({ color, alpha: 0.95 });
        }
      }

      // the event node: a warm diamond chip with a ⚡ glyph (click target; name on hover)
      g.poly([node.x, node.y - 10, node.x + 12, node.y, node.x, node.y + 10, node.x - 12, node.y])
        .fill({ color: 0x241f16, alpha: 0.94 })
        .stroke({ color: LINK, alpha: 0.98, width: 2 });
      const glyph = new Text({
        text: "⚡",
        style: { fontFamily: "sans-serif", fontSize: 10, fill: 0xffe2ae },
      });
      glyph.anchor.set(0.5, 0.5);
      glyph.position.set(node.x, node.y);
      glyph.eventMode = "none";

      const name = grp.name.length > 28 ? `${grp.name.slice(0, 27)}…` : grp.name;
      const label = new Text({
        text: name,
        style: { fontFamily: "sans-serif", fontSize: 12, fill: 0xffe9c9, stroke: { color: 0x000000, width: 3 } },
      });
      label.anchor.set(0.5, 1);
      label.position.set(node.x, node.y - 14);
      label.eventMode = "none";
      label.visible = false; // shown on hover focus only (20 labels at once = clutter)

      view.addChild(g, glyph, label);
      this.linkC.addChild(view);
      this.linkGeom.push({ eventId: grp.eventId, name: grp.name, node, arcs, view, label });
    }

    // the selected object itself: a bright anchor dot
    if (selfPt) {
      const g = new Graphics();
      g.circle(selfPt.x, selfPt.y, 5).fill({ color: LINK, alpha: 0.98 });
      g.circle(selfPt.x, selfPt.y, 5).stroke({ color: 0x000000, alpha: 0.6, width: 2 });
      this.linkC.addChild(g);
    }
  }

  /** Hover hit-test over the link web (world coords + zoom-aware tolerance). Nodes win
   *  over arcs; among arcs the closest one wins. Pure math — the layer is eventMode:none. */
  hitObjectLink(wx: number, wy: number, tol: number): LinkHit | null {
    let best: { d: number; hit: LinkHit } | null = null;
    for (const grp of this.linkGeom) {
      const dn = Math.hypot(grp.node.x - wx, grp.node.y - wy);
      if (dn <= Math.max(tol, 14)) {
        const hit = { eventId: grp.eventId, name: grp.name, kind: "node" as const };
        if (!best || dn < best.d - 6) best = { d: dn - 6, hit }; // slight node priority
      }
    }
    if (best) return best.hit; // a node under the cursor always wins
    for (const grp of this.linkGeom) {
      for (const arc of grp.arcs) {
        // sample the quadratic — cheap and exact enough for a hover test
        let prev = arc.a;
        for (let i = 1; i <= 16; i++) {
          const p = qPoint(arc.a, arc.c, arc.b, i / 16);
          const d = distToSegment(wx, wy, prev, p);
          if (d <= Math.max(tol, 5) && (!best || d < best.d)) {
            best = { d, hit: { eventId: grp.eventId, name: grp.name, kind: "arc" } };
          }
          prev = p;
        }
      }
    }
    return best?.hit ?? null;
  }

  /** Spotlight ONE event's bundle (dim the rest + show its name); null restores all. */
  setLinkFocus(eventId: string | null): void {
    if (this.linkFocus === eventId) return;
    this.linkFocus = eventId;
    for (const grp of this.linkGeom) {
      const focused = !eventId || grp.eventId === eventId;
      grp.view.alpha = focused ? 1 : 0.16;
      grp.label.visible = eventId !== null && grp.eventId === eventId;
    }
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
