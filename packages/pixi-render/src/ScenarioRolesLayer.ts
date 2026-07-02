/**
 * ScenarioRolesLayer — the editor-only «Роли локаций» overlay: for every LOCATION that
 * the scenario's events reference, draws a colored ring around its (2r+1)² area (color =
 * the DOMINANT role class) plus a compact badge row of role icons (with counts) above it.
 * Locations no event touches get a faint gray dot — «не используется».
 *
 * The per-location role counts are computed by the HOST (apps/web scenarioRoles.ts —
 * the single source of truth for role semantics) and passed in as plain data; this layer
 * only renders. Non-interactive.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 */
import { Container, Graphics, Text } from "pixi.js";
import type { MapDocument } from "@d2/map-schema";
import { cellToWorld, HALF_W, HALF_H } from "./iso.js";

/** Per-class role counts for one location (plain data; shape mirrors the host's
 *  `RoleCounts` in apps/web scenarioRoles.ts). */
export interface RoleCounts {
  trigger: number;
  spawn: number;
  destination: number;
  env: number;
}

/** Render order = dominance priority. Icons + colors MUST match ROLE_META in
 *  apps/web/src/services/scenarioRoles.ts (the shared role model). */
const ROLE_ORDER: ReadonlyArray<{ key: keyof RoleCounts; icon: string; color: number }> = [
  { key: "trigger", icon: "⚡", color: 0xe6a23c },
  { key: "spawn", icon: "✨", color: 0x67c23a },
  { key: "destination", icon: "➜", color: 0x409eff },
  { key: "env", icon: "☁", color: 0xb07dd8 },
];

/** «не используется»: locations no event references. */
const UNUSED = 0x8a8a8a;

export class ScenarioRolesLayer {
  readonly view: Container;

  constructor() {
    this.view = new Container();
    this.view.label = "scenario-roles";
    this.view.eventMode = "none"; // pure overlay, never eats pointer events
  }

  /** Redraw all location role markers. `roles` = location id → per-class counts. */
  build(doc: MapDocument, roles: Record<string, RoleCounts>): void {
    this.view.removeChildren().forEach((c) => c.destroy());
    const g = new Graphics();
    const badges: Text[] = [];

    for (const o of doc.objects) {
      if (o.type !== "location") continue;
      const r = o.radius ?? 0;
      // center of the (2r+1)² cell square; cellToWorld(x,y) = cell TOP vertex
      const c = cellToWorld(o.pos.x + 0.5, o.pos.y + 0.5);
      const counts = roles[o.id];
      if (!counts) {
        // faint gray dot — «не используется»
        g.circle(c.x, c.y, 3).fill({ color: UNUSED, alpha: 0.5 });
        continue;
      }

      // ring covering the location's iso diamond: half-extents (2r+1)·HALF_W/HALF_H
      const span = 2 * r + 1;
      const active = ROLE_ORDER.filter(({ key }) => counts[key] > 0);
      const dominant = active[0]; // ROLE_ORDER is the dominance priority
      if (!dominant) {
        g.circle(c.x, c.y, 3).fill({ color: UNUSED, alpha: 0.5 });
        continue;
      }
      g.ellipse(c.x, c.y, span * HALF_W, span * HALF_H)
        .stroke({ color: dominant.color, alpha: 0.9, width: 2 });

      // badge row above the ring top: «⚡2 ✨» — one Text per class, in class color
      const texts: Text[] = [];
      let rowWidth = 0;
      const GAP = 3;
      for (const { key, icon, color } of active) {
        const n = counts[key];
        const t = new Text({
          text: n > 1 ? `${icon}${n}` : icon,
          style: { fontSize: 13, fill: color, stroke: { color: 0x000000, width: 3 } },
        });
        t.eventMode = "none";
        rowWidth += t.width + (texts.length ? GAP : 0);
        texts.push(t);
      }
      const topY = c.y - span * HALF_H; // top of the ring
      let x = c.x - rowWidth / 2;
      for (const t of texts) {
        t.anchor.set(0, 1);
        t.position.set(x, topY - 2);
        x += t.width + GAP;
        badges.push(t);
      }
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
