/**
 * TerrainTilemapLayer — runtime terrain compositing via @pixi/tilemap, replacing the
 * per-map baked PNG (compose_terrain.py). Everything is assembled on the client from
 * SHARED, map-independent tile atlases:
 *   - "terrain-base"   : base ground diamonds  T<tid>_<rx>_<ry> / TW_<rx>_<ry>
 *   - "terrain-border" : pre-blended borders   E_<ntid>_<nrx>_<nry>_<mask>_<var>
 *                        + water foam          WF_<type>_<var>
 *   - "iso-terrn"      : roads ROAD<nn>00, forest <code>F<forest:04>
 *
 * Per-cell keys + the border priority/bitmask logic are ported verbatim from the
 * editor (MapTileHelper / LandscapeObject) via the proven compose_terrain.py port.
 * Layers are 4 CompositeTilemaps in z-order (base < border < road < tree); each
 * border/foam stays inside its own 64x32 diamond so "all base then all border" is
 * identical to the editor's per-cell composite (diamonds tessellate, no overlap).
 *
 * Touches `pixi.js` + `@pixi/tilemap` -> COMPILE-ONLY under vitest.
 */
import { Container, Sprite } from "pixi.js";
import { CompositeTilemap } from "@pixi/tilemap";
import type { MapDocument } from "@d2/map-schema";
import { cellToWorld, HALF_W, HALF_H } from "./iso.js";
import type { AssetStore } from "./AssetStore.js";

const TS_LAND = 192; // race ground source tile size (6 * HALF_W)
const TS_WATER = 128; // water source tile size (4 * HALF_W)

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

/** Lterrain id -> 2-letter terrain race code (for the forest/tree sprite key). */
export type TerrainCodes = Record<number, string>;

/** orthogonal neighbours: [dx, dy, maskType] (W/N/E/S). */
const ORTHO: ReadonlyArray<readonly [number, number, number]> = [
  [-1, 0, 1], [0, -1, 2], [1, 0, 4], [0, 1, 8],
];
/** diagonal neighbours: [dx, dy, maskType] (NW/NE/SE/SW). */
const DIAG: ReadonlyArray<readonly [number, number, number]> = [
  [-1, -1, 17], [1, -1, 18], [1, 1, 20], [-1, 1, 24],
];

export class TerrainTilemapLayer {
  readonly view: Container;
  private readonly baseTM = new CompositeTilemap();
  private readonly borderTM = new CompositeTilemap();
  // roads/trees are large, TRIMMED iso-terrn sprites — drawn as Sprites (anchor 0.5
  // applies the trim offset correctly; the tilemap ignores trim and mis-places them).
  private readonly roadLayer = new Container();
  private readonly treeLayer = new Container();
  private readonly missing = new Set<string>();
  /** cached variant counts per mask key ("E<mt>" / "W<type>"), discovered from the atlas. */
  private readonly varCount = new Map<string, number>();

  private assets!: AssetStore;
  private n = 0;
  private val: Int32Array = new Int32Array(0);

  constructor() {
    this.view = new Container();
    this.view.label = "terrain";
    // z-order: base < border < road < tree (editor reloadGrid order)
    this.view.addChild(this.baseTM, this.borderTM, this.roadLayer, this.treeLayer);
  }

  build(doc: MapDocument, assets: AssetStore, terrainCodes?: TerrainCodes): void {
    this.assets = assets;
    this.baseTM.clear();
    this.borderTM.clear();
    this.roadLayer.removeChildren().forEach((c) => c.destroy());
    this.treeLayer.removeChildren().forEach((c) => c.destroy());
    this.missing.clear();
    this.varCount.clear();
    const n = (this.n = doc.size);
    const cells = doc.terrain.cells;
    this.val = new Int32Array(n * n);
    for (const c of cells) this.val[c.y * n + c.x] = c.value;

    // 1) base ground diamonds + 2) pre-blended borders, per cell
    for (const c of cells) {
      this.placeBase(c.x, c.y, c.value);
      this.placeBorders(c.x, c.y, c.value);
    }
    // 3) roads (centred on the cell), 4) trees (x-outer/y-inner like the editor)
    for (const c of cells) {
      if (c.roadType !== -1) this.placeCentered(this.roadLayer, `ROAD${pad(c.roadType, 2)}00`, c.x, c.y);
    }
    const forest = cells.filter((c) => c.ground === 1).sort((a, b) => a.x - b.x || a.y - b.y);
    for (const c of forest) {
      const code = terrainCodes?.[c.value & 7] ?? "";
      const f = (c.value >>> 26) & 0x3f;
      this.placeCentered(this.treeLayer, `${code}F${pad(f, 4)}`, c.x, c.y);
    }

    if (this.missing.size > 0) {
      console.warn(
        `TerrainTilemapLayer: ${this.missing.size} tile(s) unresolved: ` +
          [...this.missing].slice(0, 20).join(", "),
      );
    }
  }

  // ---- per-cell helpers ----------------------------------------------------
  private at(x: number, y: number): number | null {
    return x >= 0 && y >= 0 && x < this.n && y < this.n ? this.val[y * this.n + x] ?? null : null;
  }
  private isWater(v: number): boolean {
    return ((v >> 3) & 7) === 3;
  }
  /** LandscapeObject::test — does v1 bleed over v2's edge? */
  private test(v1: number, v2: number): boolean {
    if (this.isWater(v2)) return false;
    if (this.isWater(v1)) return true;
    const t1 = v1 & 7;
    const t2 = v2 & 7;
    if (t1 === 2 && t2 === 1) return false;
    if (t1 === 1 && t2 === 2) return true;
    return t1 > t2;
  }
  private resolves(key: string): boolean {
    return this.assets.resolveTexture(key).label !== "EMPTY";
  }
  /** number of NE border variants for a mask type (global; discovered once, cached). */
  private neCount(mt: number, ntid: number, nrx: number, nry: number): number {
    const k = `E${mt}`;
    const cached = this.varCount.get(k);
    if (cached !== undefined) return cached;
    let c = 0;
    while (this.resolves(`E_${ntid}_${nrx}_${nry}_${mt}_${c}`)) c++;
    this.varCount.set(k, c);
    return c;
  }
  private waCount(type: number): number {
    const k = `W${type}`;
    const cached = this.varCount.get(k);
    if (cached !== undefined) return cached;
    let c = 0;
    while (this.resolves(`WF_${type}_${c}`)) c++;
    this.varCount.set(k, c);
    return c;
  }

  private placeBase(x: number, y: number, v: number): void {
    const nx = (this.n + x - y - 1) * HALF_W;
    const ny = (x + y) * HALF_H;
    const key = this.isWater(v)
      ? `TW_${nx % TS_WATER}_${ny % TS_WATER}`
      : `T${v & 7}_${nx % TS_LAND}_${ny % TS_LAND}`;
    const tex = this.assets.resolveTexture(key);
    if (tex.label === "EMPTY") {
      this.missing.add(key);
      return;
    }
    const w = cellToWorld(x, y);
    this.baseTM.tile(tex, w.x - HALF_W, w.y - HALF_H);
  }

  private placeBorders(x: number, y: number, v: number): void {
    const border = this.evalBorder(x, y, v);
    const extra = this.evalExtra(x, y, v, border);
    if (!border && !extra) return;
    const w = cellToWorld(x, y);
    const px = w.x - HALF_W;
    const py = w.y - HALF_H;
    const wtr = this.isWater(v);
    const seed = x * y + x + y;

    if (border) {
      if (wtr) this.placeFoam(border, seed, px, py);
      for (const [dx, dy, mt] of ORTHO) {
        const nv = this.at(x + dx, y + dy);
        if (nv !== null && this.test(v, nv)) this.placeBorder(x + dx, y + dy, nv, mt, seed, px, py);
      }
    }
    if (extra) {
      if (wtr) this.placeFoam(extra + 16, seed, px, py);
      for (const [dx, dy, mt] of DIAG) {
        const nv = this.at(x + dx, y + dy);
        if (nv !== null && this.test(v, nv)) this.placeBorder(x + dx, y + dy, nv, mt, seed, px, py);
      }
    }
  }

  private placeFoam(type: number, seed: number, px: number, py: number): void {
    const cnt = this.waCount(type);
    if (cnt <= 0) return;
    const key = `WF_${type}_${seed % cnt}`;
    const tex = this.assets.resolveTexture(key);
    if (tex.label === "EMPTY") {
      this.missing.add(key);
      return;
    }
    this.borderTM.tile(tex, px, py);
  }

  private placeBorder(
    nx: number, ny: number, nv: number, mt: number, seed: number, px: number, py: number,
  ): void {
    const ntid = nv & 7;
    const nrx = ((this.n + nx - ny - 1) * HALF_W) % TS_LAND;
    const nry = ((nx + ny) * HALF_H) % TS_LAND;
    const cnt = this.neCount(mt, ntid, nrx, nry);
    if (cnt <= 0) return;
    const key = `E_${ntid}_${nrx}_${nry}_${mt}_${seed % cnt}`;
    const tex = this.assets.resolveTexture(key);
    if (tex.label === "EMPTY") {
      this.missing.add(key);
      return;
    }
    this.borderTM.tile(tex, px, py);
  }

  private evalBorder(x: number, y: number, v: number): number {
    let b = 0;
    if (x > 0 && v !== this.at(x - 1, y)) b |= 1;
    if (y > 0 && v !== this.at(x, y - 1)) b |= 2;
    if (x < this.n - 1 && v !== this.at(x + 1, y)) b |= 4;
    if (y < this.n - 1 && v !== this.at(x, y + 1)) b |= 8;
    return b;
  }

  private evalExtra(x: number, y: number, v: number, b: number): number {
    let e = 0;
    if (x > 0 && y > 0 && v !== this.at(x - 1, y - 1) && (b & 0b11) === 0) e |= 1;
    if (x < this.n - 1 && y > 0 && v !== this.at(x + 1, y - 1) && (b & 0b110) === 0) e |= 2;
    if (x < this.n - 1 && y < this.n - 1 && v !== this.at(x + 1, y + 1) && (b & 0b1100) === 0) e |= 4;
    if (x > 0 && y < this.n - 1 && v !== this.at(x - 1, y + 1) && (b & 0b1001) === 0) e |= 8;
    return e;
  }

  /** Place a road/tree as a Sprite centred on the cell centre (= cellToWorld(x,y)).
   *  A Sprite (anchor 0.5) applies the texture's trim offset, so the small tree art
   *  inside its large 320x320 frame lands on the cell — unlike a raw tilemap quad. */
  private placeCentered(layer: Container, key: string, x: number, y: number): void {
    const tex = this.assets.resolveTexture(key);
    if (tex.label === "EMPTY") {
      this.missing.add(key);
      return;
    }
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 0.5);
    const w = cellToWorld(x, y);
    sprite.position.set(w.x, w.y);
    layer.addChild(sprite);
  }

  /** Distinct unresolved tile keys from the last build (for the HUD/debug). */
  get missingKeys(): string[] {
    return [...this.missing];
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
