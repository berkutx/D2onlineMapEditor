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
import { zKey } from "./zorder.js";
import { objectSpriteCandidates, type ObjectResolveCtx } from "./objectSprite.js";
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

  constructor() {
    this.view = new Container();
    this.view.label = "objects";
    // Let Pixi sort children by zIndex so painter's order is maintained even if
    // we add/remove sprites incrementally.
    this.view.sortableChildren = true;
  }

  /** Rebuild all object sprites from a document. */
  build(
    doc: MapDocument,
    assets: AssetStore,
    anim: AnimationManager,
  ): void {
    this.clear(anim);
    // owner uid -> raceId, so forts/capitals theme by their owner's race.
    const raceByPlayer = new Map(doc.players.map((p) => [p.id, p.race]));
    const ctx: ObjectResolveCtx = {
      raceOf: (owner) => (owner ? raceByPlayer.get(owner) : undefined),
    };
    for (const obj of doc.objects) {
      this.place(obj, assets, anim, ctx);
    }
  }

  private place(
    obj: MapObject,
    assets: AssetStore,
    anim: AnimationManager,
    ctx: ObjectResolveCtx,
  ): void {
    // Resolve the object to a sprite/animation by trying its candidate names in
    // order: an animation wins over a static frame; first hit is used.
    let animFrames: Texture[] = [];
    let staticTex: Texture | undefined;
    for (const name of objectSpriteCandidates(obj, ctx)) {
      const frames = assets.resolveAnimation(name);
      if (frames.length > 1) {
        animFrames = frames;
        break;
      }
      if (!staticTex && assets.hasTexture(name)) {
        staticTex = assets.resolveTexture(name);
        if (staticTex.label === "EMPTY") staticTex = undefined;
        else break;
      }
    }

    let sprite: Sprite | AnimatedSprite;
    let animated = false;

    if (animFrames.length > 1) {
      // Pooled AnimatedSprite with autoUpdate=false: the AnimationManager owns
      // the single shared ticker that advances it (no per-sprite ticker).
      sprite = anim.acquire(animFrames);
      animated = true;
    } else if (staticTex) {
      sprite = new Sprite(staticTex);
    } else {
      // nothing resolved (e.g. generic/event, or a stack needing IsoUnit)
      return;
    }

    // D2 iso anchor = bottom-center: the sprite's foot sits on the cell center.
    sprite.anchor.set(0.5, 1);

    // Position at the object's FRONT cell so multi-tile art lines up with the
    // cell whose occlusion it controls (same cell zKey sorts on).
    const fp = obj.footprint ?? { w: 1, h: 1 };
    const fx = obj.pos.x + (fp.w - 1);
    const fy = obj.pos.y + (fp.h - 1);
    const world = cellToWorld(fx, fy);
    sprite.position.set(world.x, world.y);
    sprite.zIndex = zKey(obj);
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
