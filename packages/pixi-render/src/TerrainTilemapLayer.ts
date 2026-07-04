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
import { CompositeTilemap, settings as tilemapSettings } from "@pixi/tilemap";
import type { MapDocument } from "@d2/map-schema";

// A single tilemap layer uses a 16-bit index buffer by default -> max 16383 tiles.
// Large maps exceed that (144x144 = 20736 base tiles) and the tail (bottom iso rows)
// silently fails to draw. Enable 32-bit indices so one layer holds the whole map.
// Must be set before the renderer initializes (module load runs before app.init()).
tilemapSettings.use32bitIndex = true;
import { cellToWorld, HALF_W, HALF_H } from "./iso.js";
import type { AssetStore } from "./AssetStore.js";

const TS_LAND = 192; // race ground source tile size (6 * HALF_W)
const TS_WATER = 128; // water source tile size (4 * HALF_W)

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

/** Lterrain id -> 2-letter terrain race code (for the forest/tree sprite key). */
export type TerrainCodes = Record<number, string>;

/**
 * std::mt19937 + MapRegionExtractor::calculateTileIndex, ported from the asset
 * pipeline (compose_terrain.variant_index). Picks which ground VARIANT a 192px
 * source block uses, so a flat fill varies per block instead of repeating 6x6.
 * MSVC uniform_int reduction: engine_output % n with single-bucket rejection.
 */
function mt19937(seed: number): () => number {
  const mt = new Uint32Array(624);
  mt[0] = seed >>> 0;
  for (let i = 1; i < 624; i++) {
    const prev = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
    mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
  }
  let idx = 624;
  return () => {
    if (idx >= 624) {
      for (let i = 0; i < 624; i++) {
        const y = (mt[i]! & 0x80000000) + (mt[(i + 1) % 624]! & 0x7fffffff);
        let v = mt[(i + 397) % 624]! ^ (y >>> 1);
        if (y & 1) v ^= 0x9908b0df;
        mt[i] = v >>> 0;
      }
      idx = 0;
    }
    let y = mt[idx++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  };
}

const VAR_MASK = 0xffffffff;
function variantIndex(seed: number, tx: number, ty: number, n: number): number {
  if (n <= 1) return 0;
  const s = (seed + Math.imul(tx, 73856093) + Math.imul(ty, 19349663)) >>> 0;
  const next = mt19937(s);
  for (;;) {
    const ret = next();
    if (Math.floor(ret / n) < Math.floor(VAR_MASK / n) || VAR_MASK % n === n - 1) return ret % n;
  }
}

/** orthogonal neighbours: [dx, dy, maskType] (W/N/E/S). */
const ORTHO: ReadonlyArray<readonly [number, number, number]> = [
  [-1, 0, 1], [0, -1, 2], [1, 0, 4], [0, 1, 8],
];
/** diagonal neighbours: [dx, dy, maskType] (NW/NE/SE/SW). */
const DIAG: ReadonlyArray<readonly [number, number, number]> = [
  [-1, -1, 17], [1, -1, 18], [1, 1, 20], [-1, 1, 24],
];

/** Cells per chunk side. A brush stroke re-tiles only the touched chunks (16×16 cells =
 *  ≤256 base tiles + borders) instead of the whole map (144×144 = 20736). */
const CHUNK = 16;

export class TerrainTilemapLayer {
  readonly view: Container;
  // base/border are CompositeTilemaps CHUNKED by cell region: @pixi/tilemap has no
  // per-tile removal, so incremental updates clear + re-tile only the dirty chunks.
  // Chunking is safe for z-order because base diamonds tessellate and every border/foam
  // stays inside its own cell diamond (see the header comment).
  private readonly baseLayer = new Container();
  private readonly borderLayer = new Container();
  private readonly baseChunks = new Map<number, CompositeTilemap>();
  private readonly borderChunks = new Map<number, CompositeTilemap>();
  // roads/trees are large, TRIMMED iso-terrn sprites — drawn as Sprites (anchor 0.5
  // applies the trim offset correctly; the tilemap ignores trim and mis-places them).
  // One sprite per cell, indexed for point updates; zIndex = x*n+y reproduces the
  // editor's x-outer/y-inner paint order globally (crown overlaps stay correct even
  // though update insertion order is arbitrary).
  private readonly roadLayer = new Container();
  private readonly treeLayer = new Container();
  private readonly roadSprites = new Map<number, Sprite>();
  private readonly treeSprites = new Map<number, Sprite>();
  private readonly missing = new Set<string>();
  /** cached variant counts per mask key ("E<mt>" / "W<type>"), discovered from the atlas. */
  private readonly varCount = new Map<string, number>();
  /** cached base-ground variant count per terrain id (discovered from the atlas). */
  private readonly baseVar = new Map<number, number>();

  private assets!: AssetStore;
  private terrainCodes?: TerrainCodes;
  private n = 0;
  private val: Int32Array = new Int32Array(0);
  private built = false;

  constructor() {
    this.view = new Container();
    this.view.label = "terrain";
    // z-order: base < border < road < tree (editor reloadGrid order)
    this.roadLayer.sortableChildren = true;
    this.treeLayer.sortableChildren = true;
    this.view.addChild(this.baseLayer, this.borderLayer, this.roadLayer, this.treeLayer);
  }

  private chunkIdx(x: number, y: number): number {
    return Math.floor(y / CHUNK) * Math.ceil(this.n / CHUNK) + Math.floor(x / CHUNK);
  }
  private tmFor(map: Map<number, CompositeTilemap>, layer: Container, x: number, y: number): CompositeTilemap {
    const ci = this.chunkIdx(x, y);
    let tm = map.get(ci);
    if (!tm) {
      tm = new CompositeTilemap();
      map.set(ci, tm);
      layer.addChild(tm);
    }
    return tm;
  }

  build(doc: MapDocument, assets: AssetStore, terrainCodes?: TerrainCodes): void {
    this.assets = assets;
    this.terrainCodes = terrainCodes;
    for (const tm of this.baseChunks.values()) tm.destroy();
    for (const tm of this.borderChunks.values()) tm.destroy();
    this.baseChunks.clear();
    this.borderChunks.clear();
    this.baseLayer.removeChildren();
    this.borderLayer.removeChildren();
    this.roadLayer.removeChildren().forEach((c) => c.destroy());
    this.treeLayer.removeChildren().forEach((c) => c.destroy());
    this.roadSprites.clear();
    this.treeSprites.clear();
    this.missing.clear();
    this.varCount.clear();
    this.baseVar.clear();
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
      this.placeRoad(c.x, c.y, c.roadType);
      if (c.ground === 1) this.placeTree(c.x, c.y, c.value);
    }
    this.built = true;

    if (this.missing.size > 0) {
      console.warn(
        `TerrainTilemapLayer: ${this.missing.size} tile(s) unresolved: ` +
          [...this.missing].slice(0, 20).join(", "),
      );
    }
  }

  /** Can updateCells patch in place? (built once, same map size — else callers full-build). */
  canUpdate(doc: MapDocument): boolean {
    return this.built && this.n === doc.size;
  }

  /**
   * Incremental re-tile: refresh ONLY the given cells (+ their border halo). Base and
   * borders rebuild per touched CHUNK (a cell's value changes its neighbours' borders,
   * hence the 1-cell halo when collecting chunks); the cell's own road/tree sprite is
   * swapped point-wise. Neighbour reads go through the freshly refreshed `val`, so a
   * chunk re-tile is self-contained.
   */
  updateCells(doc: MapDocument, dirty: readonly { x: number; y: number }[]): void {
    if (!this.canUpdate(doc) || dirty.length === 0) return;
    const n = this.n;
    const dirtyIdx = new Set<number>();
    for (const c of dirty) if (c.x >= 0 && c.y >= 0 && c.x < n && c.y < n) dirtyIdx.add(c.y * n + c.x);
    // refresh the value grid + capture the dirty cells' full state in one pass
    const dirtyCells = new Map<number, { x: number; y: number; value: number; ground: number; roadType: number }>();
    for (const c of doc.terrain.cells) {
      const k = c.y * n + c.x;
      this.val[k] = c.value;
      if (dirtyIdx.has(k)) dirtyCells.set(k, c);
    }
    // chunks touched by the dirty cells + their 1-cell halo (neighbour borders)
    const chunks = new Set<number>();
    for (const c of dirty) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = c.x + dx;
          const y = c.y + dy;
          if (x >= 0 && y >= 0 && x < n && y < n) chunks.add(this.chunkIdx(x, y));
        }
      }
    }
    for (const ci of chunks) this.retileChunk(ci);
    // roads/trees: only the dirty cells themselves (autotiling already delivers
    // neighbour road changes as their own setCell ops)
    for (const c of dirtyCells.values()) {
      this.roadSprites.get(c.y * n + c.x)?.destroy();
      this.roadSprites.delete(c.y * n + c.x);
      this.treeSprites.get(c.y * n + c.x)?.destroy();
      this.treeSprites.delete(c.y * n + c.x);
      this.placeRoad(c.x, c.y, c.roadType);
      if (c.ground === 1) this.placeTree(c.x, c.y, c.value);
    }
  }

  /** Clear + re-tile one chunk's base/border tilemaps from the current value grid. */
  private retileChunk(ci: number): void {
    const perRow = Math.ceil(this.n / CHUNK);
    const cx = (ci % perRow) * CHUNK;
    const cy = Math.floor(ci / perRow) * CHUNK;
    this.baseChunks.get(ci)?.clear();
    this.borderChunks.get(ci)?.clear();
    const xEnd = Math.min(this.n, cx + CHUNK);
    const yEnd = Math.min(this.n, cy + CHUNK);
    for (let y = cy; y < yEnd; y++) {
      for (let x = cx; x < xEnd; x++) {
        const v = this.val[y * this.n + x]!;
        this.placeBase(x, y, v);
        this.placeBorders(x, y, v);
      }
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
  /** number of base-ground variants for a terrain id (global; discovered once, cached). */
  private baseVarCount(tid: number, rx: number, ry: number): number {
    const cached = this.baseVar.get(tid);
    if (cached !== undefined) return cached;
    let c = 0;
    while (this.resolves(`T${tid}_${rx}_${ry}_${c}`)) c++;
    this.baseVar.set(tid, c);
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
    let key: string;
    if (this.isWater(v)) {
      key = `TW_${nx % TS_WATER}_${ny % TS_WATER}`;
    } else {
      const tid = v & 7;
      const rx = nx % TS_LAND;
      const ry = ny % TS_LAND;
      // pick the ground variant per 192px source block (matches the game; breaks the
      // flat-fill 6x6 repeat). Variant count is discovered from the atlas per terrain.
      const nVar = this.baseVarCount(tid, rx, ry);
      const vi = nVar > 1
        ? variantIndex(0, Math.floor(nx / TS_LAND), Math.floor(ny / TS_LAND), nVar)
        : 0;
      key = `T${tid}_${rx}_${ry}_${vi}`;
    }
    const tex = this.assets.resolveTexture(key);
    if (tex.label === "EMPTY") {
      this.missing.add(key);
      return;
    }
    const w = cellToWorld(x, y);
    // cellToWorld(x,y) is the cell's TOP vertex (editor origin convention, matching
    // objects/overlays). The 64×32 ground diamond's top vertex sits there, so its
    // top-left corner is one half-height BELOW — i.e. py = w.y (not w.y - HALF_H).
    this.tmFor(this.baseChunks, this.baseLayer, x, y).tile(tex, w.x - HALF_W, w.y);
  }

  private placeBorders(x: number, y: number, v: number): void {
    const border = this.evalBorder(x, y, v);
    const extra = this.evalExtra(x, y, v, border);
    if (!border && !extra) return;
    const w = cellToWorld(x, y);
    const px = w.x - HALF_W;
    const py = w.y; // origin convention — aligns the border diamond with the base tile
    const wtr = this.isWater(v);
    const seed = x * y + x + y;
    const tm = this.tmFor(this.borderChunks, this.borderLayer, x, y);

    if (border) {
      if (wtr) this.placeFoam(tm, border, seed, px, py);
      for (const [dx, dy, mt] of ORTHO) {
        const nv = this.at(x + dx, y + dy);
        if (nv !== null && this.test(v, nv)) this.placeBorder(tm, x + dx, y + dy, nv, mt, seed, px, py);
      }
    }
    if (extra) {
      if (wtr) this.placeFoam(tm, extra + 16, seed, px, py);
      for (const [dx, dy, mt] of DIAG) {
        const nv = this.at(x + dx, y + dy);
        if (nv !== null && this.test(v, nv)) this.placeBorder(tm, x + dx, y + dy, nv, mt, seed, px, py);
      }
    }
  }

  private placeFoam(tm: CompositeTilemap, type: number, seed: number, px: number, py: number): void {
    const cnt = this.waCount(type);
    if (cnt <= 0) return;
    const key = `WF_${type}_${seed % cnt}`;
    const tex = this.assets.resolveTexture(key);
    if (tex.label === "EMPTY") {
      this.missing.add(key);
      return;
    }
    tm.tile(tex, px, py);
  }

  private placeBorder(
    tm: CompositeTilemap,
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
    tm.tile(tex, px, py);
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
   *  inside its large 320x320 frame lands on the cell — unlike a raw tilemap quad.
   *  zIndex = x*n+y keeps the editor's x-outer/y-inner paint order under sortable
   *  layers regardless of insertion order (incremental updates insert out of order). */
  private placeCentered(
    layer: Container, index: Map<number, Sprite>, key: string, x: number, y: number,
  ): void {
    const tex = this.assets.resolveTexture(key);
    if (tex.label === "EMPTY") {
      this.missing.add(key);
      return;
    }
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 0.5);
    sprite.zIndex = x * this.n + y;
    const w = cellToWorld(x, y);
    // cell visual centre = top vertex + half-height (origin convention)
    sprite.position.set(w.x, w.y + HALF_H);
    layer.addChild(sprite);
    index.set(y * this.n + x, sprite);
  }

  private placeRoad(x: number, y: number, roadType: number): void {
    if (roadType === -1) return;
    this.placeCentered(this.roadLayer, this.roadSprites, `ROAD${pad(roadType, 2)}00`, x, y);
  }

  private placeTree(x: number, y: number, v: number): void {
    const code = this.terrainCodes?.[v & 7] ?? "";
    const f = (v >>> 26) & 0x3f;
    this.placeCentered(this.treeLayer, this.treeSprites, `${code}F${pad(f, 4)}`, x, y);
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
