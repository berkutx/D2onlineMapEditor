/**
 * GridLayer — draws the isometric cell grid (diamond lattice) over the terrain,
 * like the editor's grid overlay. Lines run along the two cartesian axes at cell
 * boundaries (half-integer coords), which in iso space are straight lines forming
 * the diamond grid.
 */
import { Container, Graphics } from "pixi.js";
import { cellToWorld } from "./iso.js";

export class GridLayer {
  readonly view: Container;

  constructor() {
    this.view = new Container();
    this.view.label = "grid";
    this.view.eventMode = "none";
  }

  /** Rebuild the grid for an N x N map. */
  build(size: number, color = 0x000000, alpha = 0.22): void {
    this.view.removeChildren().forEach((c) => c.destroy());
    const g = new Graphics();
    const N = size;

    // cell boundaries sit at half-integer cartesian coords (-0.5 .. N-0.5).
    for (let i = 0; i <= N; i++) {
      const a = i - 0.5;
      // constant-x boundary line
      let p = cellToWorld(a, -0.5);
      g.moveTo(p.x, p.y);
      p = cellToWorld(a, N - 0.5);
      g.lineTo(p.x, p.y);
      // constant-y boundary line
      p = cellToWorld(-0.5, a);
      g.moveTo(p.x, p.y);
      p = cellToWorld(N - 0.5, a);
      g.lineTo(p.x, p.y);
    }
    g.stroke({ width: 1, color, alpha });
    this.view.addChild(g);
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
