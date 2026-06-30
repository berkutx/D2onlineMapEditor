/**
 * PresenceLayer — live cursor markers for collaborators. World-space (added to the camera
 * container) so each marker tracks its cell as the view pans/zooms. One small coloured
 * diamond + a name chip per peer, drawn on top of everything. Non-interactive.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 */
import { Container, Graphics, Text } from "pixi.js";
import { cellToWorld } from "./iso.js";

export interface PeerMarker {
  socketId: string;
  name: string;
  color: string; // #rrggbb
  cursor?: { x: number; y: number };
}

function hexToNum(hex: string): number {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return Number.isFinite(n) ? n : 0xffffff;
}

export class PresenceLayer {
  readonly view: Container;

  constructor() {
    this.view = new Container();
    this.view.label = "presence";
    this.view.eventMode = "none";
  }

  /** Replace all markers from the current peer list (only peers with a known cursor draw). */
  setPeers(peers: ReadonlyArray<PeerMarker>): void {
    this.view.removeChildren().forEach((c) => c.destroy());
    for (const p of peers) {
      if (!p.cursor) continue;
      const color = hexToNum(p.color);
      const at = cellToWorld(p.cursor.x + 0.5, p.cursor.y + 0.5);
      const g = new Graphics();
      // a small diamond marking the peer's hovered cell
      g.poly([at.x, at.y - 9, at.x + 9, at.y, at.x, at.y + 9, at.x - 9, at.y]);
      g.fill({ color, alpha: 0.9 });
      g.stroke({ color: 0x000000, alpha: 0.6, width: 1 });
      this.view.addChild(g);

      const label = new Text({
        text: p.name,
        style: {
          fontFamily: "sans-serif",
          fontSize: 11,
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 3 },
        },
      });
      label.anchor.set(0, 0.5);
      label.position.set(at.x + 12, at.y - 10);
      label.eventMode = "none";
      // a coloured backing chip behind the name for legibility
      const chip = new Graphics();
      chip.roundRect(at.x + 9, at.y - 10 - label.height / 2 - 1, label.width + 7, label.height + 2, 3);
      chip.fill({ color, alpha: 0.85 });
      this.view.addChild(chip);
      this.view.addChild(label);
    }
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
