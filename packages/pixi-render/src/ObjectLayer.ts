/**
 * ObjectLayer — places map objects (buildings, stacks, sites, decals) on a
 * `sortableChildren` container, z-ordered by the PURE painter's-order key.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 *
 * Each object becomes a small `Container` holding one child Sprite/AnimatedSprite
 * per sub-sprite the editor's accessor draws (e.g. a land stack = leader body +
 * banner; a fort = building + banner), in draw order. The container is positioned
 * at the object's footprint-centre iso world coordinate; every child is anchored
 * bottom-centre-on-its-own-canvas (anchor 0.5,0.5) so the trimmed atlas frames line
 * up exactly like the editor's centred pixmaps. The container's `zIndex` is the
 * painter's-order key so Pixi sorts the layer for us.
 */
import {
  Container,
  Sprite,
  AnimatedSprite,
  type Texture,
} from "pixi.js";
import type { MapObject, MapDocument } from "@d2/map-schema";
import { cellToWorld } from "./iso.js";
import {
  objectSprites,
  objectFootprint,
  objectZBase,
  type LandmarkFootprints,
  type SpriteKeyContext,
} from "./objectSprite.js";

/** Grace race index -> 2-letter fort code (Grace.RACE_TYPE -> Lrace), capital/village. */
export type RaceCodes = Record<number, string>;
import type { AssetStore } from "./AssetStore.js";
import type { AnimationManager } from "./AnimationManager.js";

/** DBF-derived placement tables the renderer needs (objectdata.json). */
export interface ObjectTables {
  landmarks?: LandmarkFootprints;
  graceFortCodes?: RaceCodes;
  graceRaceType?: Record<number, number>;
  unitBoat?: Record<string, number>;
}

interface PlacedObject {
  obj: MapObject;
  view: Container;
  /** animated children that must be returned to the AnimationManager pool on clear. */
  animated: AnimatedSprite[];
}

export class ObjectLayer {
  /** The display object to add to the world container. */
  readonly view: Container;
  private readonly placed: PlacedObject[] = [];
  private tables: ObjectTables = {};
  /** "x,y" of every water cell (ground==3): treasure variant + stack boat. */
  private waterCells = new Set<string>();
  /** sprite keys that failed to resolve this build (fail-loud: no silent skips). */
  private missing: string[] = [];

  constructor() {
    this.view = new Container();
    this.view.label = "objects";
    // Let Pixi sort children by zIndex so painter's order is maintained even if
    // we add/remove sprites incrementally.
    this.view.sortableChildren = true;
  }

  /** Rebuild all object sprites from a document. `allowedTypes`, when given,
   *  restricts which object types are placed (e.g. just mountains). */
  build(
    doc: MapDocument,
    assets: AssetStore,
    anim: AnimationManager,
    allowedTypes?: ReadonlySet<string>,
    tables?: ObjectTables,
  ): void {
    this.clear(anim);
    this.tables = tables ?? {};
    this.missing = [];
    // water cells (ground == 3) — treasure bags + stacks-on-water pick a different sprite.
    this.waterCells = new Set();
    for (const c of doc.terrain.cells) {
      if (((c.value >> 3) & 7) === 3) this.waterCells.add(`${c.x},${c.y}`);
    }
    for (const obj of doc.objects) {
      if (allowedTypes && !allowedTypes.has(obj.type)) continue;
      this.place(obj, assets, anim);
    }
    // SURFACE LOUDLY (never silently): a sprite key that doesn't resolve. We do NOT
    // crash here, because the editor itself tolerates a missing image — getImagesData
    // returns empty and CustomMapObject draws nothing for that frame. Matching that is
    // faithful (not a guess). But we WARN with the exact keys so a genuinely-wrong key
    // (vs an asset that doesn't exist in any .ff) can be caught and fixed. Missing
    // INPUT DATA (race/leader/resource) still throws in objectSprites — that's a bug.
    if (this.missing.length > 0) {
      const uniq = [...new Set(this.missing)];
      console.warn(
        `ObjectLayer: ${this.missing.length} sprite(s) had no atlas frame ` +
          `(${uniq.length} distinct, drawn as nothing like the editor): ${uniq.join(", ")}`,
      );
    }
  }

  /** Distinct sprite keys that had no atlas frame in the last build (for the HUD). */
  get missingKeys(): string[] {
    return [...new Set(this.missing)];
  }

  private place(
    obj: MapObject,
    assets: AssetStore,
    anim: AnimationManager,
  ): void {
    const water = this.waterCells.has(`${obj.pos.x},${obj.pos.y}`);
    const ctx: SpriteKeyContext = {
      graceFortCodes: this.tables.graceFortCodes,
      graceRaceType: this.tables.graceRaceType,
      unitBoat: this.tables.unitBoat,
      water,
    };

    // The exact editor sub-sprite list for this object (ports ObjectAccessors::frameData).
    const subs = objectSprites(obj, ctx);
    if (subs.length === 0) return; // not drawable (e.g. garrisoned stack)

    const container = new Container();
    const animated: AnimatedSprite[] = [];

    for (const sub of subs) {
      // An animation (multi-frame) wins; else a single static frame. The optional
      // `fallback` mirrors the editor's documented village two-try.
      let frames: Texture[] = assets.resolveAnimation(sub.key);
      let staticTex: Texture | null = null;
      if (frames.length <= 1) {
        const t = assets.resolveTexture(sub.key);
        if (t.label !== "EMPTY") staticTex = t;
        else if (sub.fallback) {
          frames = assets.resolveAnimation(sub.fallback);
          if (frames.length <= 1) {
            const tf = assets.resolveTexture(sub.fallback);
            staticTex = tf.label !== "EMPTY" ? tf : null;
          }
        }
      }

      let child: Sprite | AnimatedSprite;
      if (frames.length > 1) {
        // Pooled AnimatedSprite with autoUpdate=false: the AnimationManager owns
        // the single shared ticker that advances it (no per-sprite ticker).
        const a = anim.acquire(frames);
        animated.push(a);
        child = a;
      } else {
        if (!staticTex) {
          // fail-loud: record the unresolved key (incl. its fallback) and skip drawing
          // it; build() throws after collecting all gaps.
          this.missing.push(sub.fallback ? `${sub.key}|${sub.fallback}` : sub.key);
          continue;
        }
        child = new Sprite(staticTex);
      }
      child.anchor.set(0.5, 0.5);
      container.addChild(child);
    }

    if (container.children.length === 0) {
      container.destroy();
      // release any animated children we acquired before bailing
      for (const a of animated) anim.release(a);
      return;
    }

    // Editor (CustomMapObject::advance): the FULL sprite is CENTERED at the iso
    // position of the object's footprint centre, cellToWorld(x + W/2, y + H/2). Each
    // child is anchored (0.5,0.5) on its own (untrimmed) canvas, so Pixi applies the
    // trim offset and every layer lines up like the editor's centred pixmaps.
    const { w, h } = objectFootprint(obj, this.tables.landmarks);
    const center = cellToWorld(obj.pos.x + w / 2, obj.pos.y + h / 2);
    container.position.set(center.x, center.y);
    // editor z = getZ + x + y + getH; footprint-aware painter order.
    container.zIndex = objectZBase(obj) + obj.pos.x + obj.pos.y + h;
    container.label = obj.id;

    this.view.addChild(container);
    this.placed.push({ obj, view: container, animated });
  }

  /** Remove placed objects: recycle animated children to the pool, destroy the rest. */
  clear(anim: AnimationManager): void {
    for (const p of this.placed) {
      for (const a of p.animated) anim.release(a); // unregisters + detaches from container
      p.view.destroy({ children: true });
    }
    this.placed.length = 0;
    this.view.removeChildren();
  }

  setVisible(v: boolean): void {
    this.view.visible = v;
  }

  destroy(anim: AnimationManager): void {
    this.clear(anim);
    this.view.destroy({ children: true });
  }
}
