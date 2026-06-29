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

    // cellToWorld(x,y) is the cell's TOP vertex (editor origin convention), so cell
    // (x,y) spans [x,x+1)×[y,y+1) and its boundaries are at INTEGER coords 0..N. This
    // makes the diamond lattice line up with the terrain tiles + objects + cursor.
    for (let i = 0; i <= N; i++) {
      // constant-x boundary line
      let p = cellToWorld(i, 0);
      g.moveTo(p.x, p.y);
      p = cellToWorld(i, N);
      g.lineTo(p.x, p.y);
      // constant-y boundary line
      p = cellToWorld(0, i);
      g.moveTo(p.x, p.y);
      p = cellToWorld(N, i);
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
