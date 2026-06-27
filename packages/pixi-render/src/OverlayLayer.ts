/**
 * OverlayLayer — the editor's above-objects overlays (GridView / HoverHighlight),
 * drawn on top of everything (editor z=1000..9999):
 *
 *  - TINTS: toggleable per-cell category fills, ported 1:1 from GridView::paint +
 *    reloadMaps (MapObjects/GridObject.cpp). Exact brush RGBA and precedence:
 *      terraform: rgba(151,152,52,120) over TERRAFORMABLE cells (NOT water/mountain/
 *                 mountain-landmark)            [drawn first, independent]
 *      passable : rgba(204,51,0,120)  over blocker footprints (LandMark/Fort/Mountain/
 *                 Crystal/Ruin/Merchant)        [if a cell is a blocker, the danger/
 *                                                forest/road group is skipped — editor's
 *                                                if/else]
 *      danger   : rgba(204,151,151,120) over non-garrisoned stack footprints + 1 ring
 *      forest   : rgba(51,152,152,120)  over ground==1
 *      roads    : rgba(153,152,152,180) over roadType!=-1
 *    (guard tint — magenta diag-cross over Guard-order stacks within GVars.gu_range —
 *     is deferred: it needs the stack ORDER field + GVars.gu_range.)
 *
 *  - HOVER/SELECTION OUTLINE: yellow 3px + red 1px polygon around the footprint of the
 *    topmost object under the cursor (GridView m_hovered / CustomMapObject::paint).
 *
 *  - CURSOR HIGHLIGHT: the animated TILE_HIGHLIGHT sprite at the cursor tile
 *    (HoverHighlightItem, IsoCmon/IsoAnim "TILE_HIGHLIGHT").
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 */
import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { MapDocument, MapObject } from "@d2/map-schema";
import { cellToWorld } from "./iso.js";
import { objectFootprint, objectZBase, type LandmarkFootprints } from "./objectSprite.js";
import type { AssetStore } from "./AssetStore.js";

/** The toggleable tint categories (a subset of the editor's LayersSettings). */
export type OverlayTint = "passable" | "danger" | "terraform" | "forest" | "roads";

/** Exact editor brush colors (QColor rgb -> hex) + alpha (a/255). GridObject.cpp:26-31. */
const TINT_STYLE: Record<OverlayTint, { color: number; alpha: number }> = {
  passable: { color: 0xcc3300, alpha: 120 / 255 },
  danger: { color: 0xcc9797, alpha: 120 / 255 },
  terraform: { color: 0x979834, alpha: 120 / 255 },
  forest: { color: 0x339898, alpha: 120 / 255 },
  roads: { color: 0x999898, alpha: 180 / 255 },
};

/** Object types the editor treats as map-passability blockers (reloadMaps). */
const BLOCKERS: ReadonlySet<string> = new Set([
  "landmark", "fort", "capital", "village",
  "mountains", "crystal", "ruin",
  "merchant", "mage", "mercenary", "trainer",
]);

export interface CellRef {
  x: number;
  y: number;
}

export class OverlayLayer {
  readonly view: Container;
  private readonly tintGfx = new Graphics();
  private readonly hoverGfx = new Graphics();
  private cursor: Sprite | null = null;

  private doc: MapDocument | null = null;
  private landmarks?: LandmarkFootprints;
  private size = 0;

  private readonly passable = new Set<string>();
  private readonly danger = new Set<string>();
  /** Guard-order stack footprints expanded by (gu_range-1)/2 (magenta diag-cross). */
  private readonly guard = new Set<string>();
  private readonly forest = new Set<string>();
  private readonly road = new Set<string>();
  /** water + mountains + mountain-landmarks: terraform brush draws the COMPLEMENT. */
  private readonly terraformBlocked = new Set<string>();
  /** tiling magenta diagonal-cross pattern texture for the guard tint (Qt DiagCross). */
  private guardTex: Texture | null = null;

  private readonly enabled: Record<OverlayTint, boolean> = {
    passable: false, danger: false, terraform: false, forest: false, roads: false,
  };

  constructor() {
    this.view = new Container();
    this.view.label = "overlay";
    this.view.eventMode = "none"; // pure overlay, never eats pointer events
    this.view.addChild(this.tintGfx, this.hoverGfx);
  }

  build(
    doc: MapDocument,
    assets: AssetStore,
    landmarks?: LandmarkFootprints,
    landmarkMountain?: ReadonlyArray<string>,
    guardRange?: number,
  ): void {
    this.doc = doc;
    this.landmarks = landmarks;
    this.size = doc.size;
    if (!this.guardTex) this.guardTex = makeGuardPattern();
    this.computeMaps(doc, landmarkMountain ?? [], guardRange ?? 0);

    if (this.cursor) {
      this.cursor.destroy();
      this.cursor = null;
    }
    // TILE_HIGHLIGHT is an IsoCmon/IsoAnim animation; with animation off we show its
    // first frame. Try a static frame, else the first animation frame.
    let tex: Texture | null = null;
    const t = assets.resolveTexture("TILE_HIGHLIGHT");
    if (t.label !== "EMPTY") tex = t;
    else {
      const frames = assets.resolveAnimation("TILE_HIGHLIGHT");
      if (frames.length > 0) tex = frames[0]!;
    }
    if (tex) {
      this.cursor = new Sprite(tex);
      this.cursor.anchor.set(0.5, 0.5);
      this.cursor.visible = false;
      this.view.addChild(this.cursor);
    }

    this.redrawTints();
    this.hoverGfx.clear();
  }

  private key(x: number, y: number): string {
    return `${x},${y}`;
  }

  /** Mark an object's w×h footprint (expanded by `r` cells, editor placeObj). */
  private markFootprint(set: Set<string>, obj: MapObject, r: number): void {
    const { w, h } = objectFootprint(obj, this.landmarks);
    for (let i = -r; i < w + r; i++) {
      for (let k = -r; k < h + r; k++) {
        const x = obj.pos.x + i;
        const y = obj.pos.y + k;
        if (x >= 0 && y >= 0 && x < this.size && y < this.size) set.add(this.key(x, y));
      }
    }
  }

  private computeMaps(
    doc: MapDocument,
    landmarkMountain: ReadonlyArray<string>,
    guardRange: number,
  ): void {
    this.passable.clear();
    this.danger.clear();
    this.guard.clear();
    this.forest.clear();
    this.road.clear();
    this.terraformBlocked.clear();
    const mtn = new Set(landmarkMountain.map((s) => s.toUpperCase()));
    // editor: guard cells = footprint expanded by (gu_range-1)/2 (integer division).
    const guardR = guardRange > 0 ? Math.floor((guardRange - 1) / 2) : 0;

    for (const o of doc.objects) {
      if (BLOCKERS.has(o.type)) this.markFootprint(this.passable, o, 0);
      if (o.type === "stack" && !o.garrisoned) {
        this.markFootprint(this.danger, o, 1);
        // ORDER==Guard (3): the editor's guard-range overlay.
        if (o.order === 3) this.markFootprint(this.guard, o, guardR);
      }
      if (o.type === "mountains") this.markFootprint(this.terraformBlocked, o, 0);
      if (o.type === "landmark" && o.baseType && mtn.has(o.baseType.toUpperCase()))
        this.markFootprint(this.terraformBlocked, o, 0);
    }
    for (const c of doc.terrain.cells) {
      if (c.ground === 1) this.forest.add(this.key(c.x, c.y));
      if (c.isWater) this.terraformBlocked.add(this.key(c.x, c.y));
      if (c.roadType !== -1) this.road.add(this.key(c.x, c.y));
    }
  }

  private fillCell(g: Graphics, x: number, y: number, color: number, alpha: number): void {
    const a = cellToWorld(x, y);
    const b = cellToWorld(x + 1, y);
    const c = cellToWorld(x + 1, y + 1);
    const d = cellToWorld(x, y + 1);
    g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
    g.fill({ color, alpha });
  }

  /** Fill a cell's iso diamond with a tiling pattern texture (the guard diag-cross). */
  private fillCellTexture(g: Graphics, x: number, y: number, tex: Texture, alpha: number): void {
    const a = cellToWorld(x, y);
    const b = cellToWorld(x + 1, y);
    const c = cellToWorld(x + 1, y + 1);
    const d = cellToWorld(x, y + 1);
    g.poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y]);
    g.fill({ texture: tex, alpha });
  }

  /** Redraw all enabled tint categories, with the editor's exact per-cell precedence. */
  private redrawTints(): void {
    const g = this.tintGfx;
    g.clear();
    const e = this.enabled;
    if (!(e.passable || e.danger || e.terraform || e.forest || e.roads)) return;
    for (let x = 0; x < this.size; x++) {
      for (let y = 0; y < this.size; y++) {
        const key = this.key(x, y);
        if (e.terraform && !this.terraformBlocked.has(key))
          this.fillCell(g, x, y, TINT_STYLE.terraform.color, TINT_STYLE.terraform.alpha);
        if (e.passable && this.passable.has(key)) {
          this.fillCell(g, x, y, TINT_STYLE.passable.color, TINT_STYLE.passable.alpha);
        } else {
          // "danger" toggle draws BOTH guard ranges (magenta diag-cross) and stack
          // footprints (pink), guard first (GridView::paint order).
          if (e.danger && this.guard.has(key) && this.guardTex)
            this.fillCellTexture(g, x, y, this.guardTex, 120 / 255);
          if (e.danger && this.danger.has(key))
            this.fillCell(g, x, y, TINT_STYLE.danger.color, TINT_STYLE.danger.alpha);
          if (e.forest && this.forest.has(key))
            this.fillCell(g, x, y, TINT_STYLE.forest.color, TINT_STYLE.forest.alpha);
          if (e.roads && this.road.has(key))
            this.fillCell(g, x, y, TINT_STYLE.roads.color, TINT_STYLE.roads.alpha);
        }
      }
    }
  }

  setTint(cat: OverlayTint, on: boolean): void {
    if (this.enabled[cat] === on) return;
    this.enabled[cat] = on;
    this.redrawTints();
  }

  /** Topmost (highest painter-z) object whose footprint contains the cell. */
  private objectAt(cx: number, cy: number): MapObject | null {
    if (!this.doc) return null;
    let best: MapObject | null = null;
    let bestZ = -Infinity;
    for (const o of this.doc.objects) {
      if (o.type === "unit" || o.type === "location" || o.type === "generic") continue;
      const { w, h } = objectFootprint(o, this.landmarks);
      if (cx >= o.pos.x && cx < o.pos.x + w && cy >= o.pos.y && cy < o.pos.y + h) {
        const z = objectZBase(o) + o.pos.x + o.pos.y + h;
        if (z >= bestZ) {
          bestZ = z;
          best = o;
        }
      }
    }
    return best;
  }

  /** Move the cursor-tile highlight and (re)draw the hovered object's outline. */
  setCursorCell(cell: CellRef | null): void {
    if (this.cursor) {
      if (cell) {
        const c = cellToWorld(cell.x + 0.5, cell.y + 0.5);
        this.cursor.position.set(c.x, c.y);
        this.cursor.visible = true;
      } else {
        this.cursor.visible = false;
      }
    }
    const g = this.hoverGfx;
    g.clear();
    if (!cell) return;
    const o = this.objectAt(cell.x, cell.y);
    if (!o) return;
    const { w, h } = objectFootprint(o, this.landmarks);
    const a = cellToWorld(o.pos.x, o.pos.y);
    const b = cellToWorld(o.pos.x + w, o.pos.y);
    const c = cellToWorld(o.pos.x + w, o.pos.y + h);
    const d = cellToWorld(o.pos.x, o.pos.y + h);
    const pts = [a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y];
    g.poly(pts).stroke({ color: 0xffff00, width: 3 });
    g.poly(pts).stroke({ color: 0xff0000, width: 1 });
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(): void {
    this.view.destroy({ children: true });
    this.guardTex?.destroy(true);
    this.guardTex = null;
  }
}

/** A 12px tiling magenta diagonal-cross pattern texture — the Qt DiagCrossPattern
 *  used by the editor's guard brush (rgba(255,153,255,120)). Runs in the browser. */
function makeGuardPattern(): Texture {
  const s = 12;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, s, s);
  ctx.strokeStyle = "rgb(255,153,255)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(s, s); // ╲ (tiles seamlessly)
  ctx.moveTo(s, 0);
  ctx.lineTo(0, s); // ╱
  ctx.stroke();
  const tex = Texture.from(canvas);
  // tile the pattern across large diamond fills instead of clamping/stretching
  tex.source.style.addressMode = "repeat";
  tex.source.update();
  return tex;
}
