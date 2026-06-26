/**
 * ObjectLayer — places map objects (buildings, stacks, sites, decals) as sprites
 * on a `sortableChildren` container, z-ordered by the PURE {@link zKey}.
 *
 * Touches `pixi.js` -> COMPILE-ONLY under vitest.
 *
 * Static objects become plain `Sprite`s. Objects whose `imageName` (or `leaderImage`
 * for stacks) resolves to a registered ANIMATION become `AnimatedSprite`s handed to
 * the {@link AnimationManager}. Each sprite is positioned at its front-cell iso
 * world coordinate with a bottom-center anchor (the D2 iso convention), and its
 * `zIndex` is the painter's-order key so Pixi sorts the container for us.
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
  objectSpriteKey,
  objectFootprint,
  objectZBase,
  type LandmarkFootprints,
} from "./objectSprite.js";

/** Grace race index -> 2-letter fort code (Grace.RACE_TYPE -> Lrace), for
 *  capital/village sprites. The object's `race` is the OWNER player's Grace index. */
export type RaceCodes = Record<number, string>;
import type { AssetStore } from "./AssetStore.js";
import type { AnimationManager } from "./AnimationManager.js";

interface PlacedObject {
  obj: MapObject;
  sprite: Sprite | AnimatedSprite;
  animated: boolean;
}

export class ObjectLayer {
  /** The display object to add to the world container. */
  readonly view: Container;
  private readonly placed: PlacedObject[] = [];
  private landmarks?: LandmarkFootprints;
  private graceFortCodes?: RaceCodes;
  /** "x,y" of every water cell (ground==3), to pick the treasure (bag) variant. */
  private waterCells = new Set<string>();

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
    landmarks?: LandmarkFootprints,
    graceFortCodes?: RaceCodes,
  ): void {
    this.clear(anim);
    this.landmarks = landmarks;
    this.graceFortCodes = graceFortCodes;
    // water cells (ground == 3) — treasure bags pick a different sprite on water.
    this.waterCells = new Set();
    for (const c of doc.terrain.cells) {
      if (((c.value >> 3) & 7) === 3) this.waterCells.add(`${c.x},${c.y}`);
    }
    for (const obj of doc.objects) {
      if (allowedTypes && !allowedTypes.has(obj.type)) continue;
      this.place(obj, assets, anim);
    }
  }

  private place(
    obj: MapObject,
    assets: AssetStore,
    anim: AnimationManager,
  ): void {
    // The exact editor key for this object (ports ObjectAccessors::frameData).
    const water = obj.type === "treasure"
      ? this.waterCells.has(`${obj.pos.x},${obj.pos.y}`)
      : undefined;
    const key = objectSpriteKey(obj, { graceFortCodes: this.graceFortCodes, water });
    if (!key) return;

    // Candidate keys in editor preference order. Villages try the race-suffixed
    // sprite first then the base "NE"+tier — FortObjectAccessor calls getImagesData
    // twice (the second only if the first is empty). All other types have one key.
    const keys: string[] = [key];
    if (obj.type === "village") {
      const base = `G000FT0000NE${obj.tier ?? 1}`;
      if (base !== key) keys.push(base);
    }

    // An animation (multi-frame) wins; otherwise a single static frame. No guessed
    // fallback beyond the editor's own documented two-try above.
    let animFrames: Texture[] = [];
    let staticTex: Texture | null = null;
    for (const k of keys) {
      const af = assets.resolveAnimation(k);
      if (af.length > 1) { animFrames = af; break; }
      const t = assets.resolveTexture(k);
      if (t.label !== "EMPTY") { staticTex = t; break; }
    }

    let sprite: Sprite | AnimatedSprite;
    let animated = false;

    if (animFrames.length > 1) {
      // Pooled AnimatedSprite with autoUpdate=false: the AnimationManager owns
      // the single shared ticker that advances it (no per-sprite ticker).
      sprite = anim.acquire(animFrames);
      animated = true;
    } else {
      if (!staticTex) return; // no candidate key resolved -> not drawn
      sprite = new Sprite(staticTex);
    }

    // Editor (CustomMapObject::advance): the FULL sprite is CENTERED at the iso
    // position of the object's footprint centre, cartesianToIsometric(W/2, H/2),
    // relative to the cell at cellToWorld(x,y). cellToWorld is linear, so that is
    // cellToWorld(x + W/2, y + H/2). A trimmed Pixi texture's anchor is relative to
    // its `orig` (untrimmed) size, so anchor (0.5,0.5) centres the original canvas
    // there and Pixi applies the trim offset — matching the editor's pixmap centring.
    const { w, h } = objectFootprint(obj, this.landmarks);
    sprite.anchor.set(0.5, 0.5);
    const center = cellToWorld(obj.pos.x + w / 2, obj.pos.y + h / 2);
    sprite.position.set(center.x, center.y);
    // editor z = getZ + x + y + getH; footprint-aware painter order.
    sprite.zIndex = objectZBase(obj) + obj.pos.x + obj.pos.y + h;
    sprite.label = obj.id;

    this.view.addChild(sprite);
    this.placed.push({ obj, sprite, animated });
    // `acquire` already registered the sprite with the manager.
  }

  /** Remove placed sprites: recycle animated ones to the pool, destroy the rest. */
  clear(anim: AnimationManager): void {
    for (const p of this.placed) {
      if (p.animated) {
        // returns to the pool, unregisters, and detaches from this.view
        anim.release(p.sprite as AnimatedSprite);
      } else {
        p.sprite.destroy();
      }
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
