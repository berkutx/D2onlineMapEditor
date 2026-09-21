import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapDocument, MapObject } from "@d2/map-schema";
import type { AssetStore } from "../src/AssetStore";

// Test overlay geometry/cache invalidation without requiring a GPU in CI.
vi.mock("pixi.js", () => {
  class Container {
    children: unknown[] = [];
    addChild(...children: unknown[]) { this.children.push(...children); }
    destroy() {}
  }
  class Graphics {
    polygons: number[][] = [];
    clear() { this.polygons = []; return this; }
    poly(points: number[]) { this.polygons.push(points); return this; }
    stroke() { return this; }
    fill() { return this; }
  }
  return { Container, Graphics, Sprite: class {}, Texture: {
    from: () => ({ source: { style: {}, update() {} }, destroy() {} }),
  } };
});
import { OverlayLayer } from "../src/OverlayLayer";
import { cellToWorld } from "../src/iso";

const capital = { id: "FT0000", type: "capital", pos: { x: 2, y: 2 } } as MapObject;
const documentWith = (objects: MapObject[]) => ({ size: 20, terrain: { cells: [] }, objects }) as unknown as MapDocument;
const assets = { resolveTexture: () => ({ label: "EMPTY" }), resolveAnimation: () => [] } as unknown as AssetStore;
const polygons = (layer: OverlayLayer, child: number): number[][] =>
  (layer.view.children[child] as unknown as { polygons: number[][] }).polygons;

beforeEach(() => {
  const context = { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => context }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("live overlay document", () => {
  it("removes the old capital hover on move, follows its new position and undo", () => {
    const before = documentWith([capital]);
    const moved = documentWith([{ ...capital, pos: { x: 10, y: 10 } }]);
    const layer = new OverlayLayer();
    layer.build(before, assets);
    layer.setCursorCell({ x: 3, y: 3 });
    expect(polygons(layer, 1)).toHaveLength(2);
    layer.update(moved); // no pointermove: a stationary cursor must also refresh
    expect(polygons(layer, 1)).toHaveLength(0);
    layer.setCursorCell({ x: 11, y: 11 });
    expect(polygons(layer, 1)).toHaveLength(2);
    expect(polygons(layer, 1)[0]?.slice(0, 2)).toEqual(Object.values(cellToWorld(10, 10)));
    layer.update(before); // undo
    expect(polygons(layer, 1)).toHaveLength(0);
    layer.setCursorCell({ x: 3, y: 3 });
    expect(polygons(layer, 1)).toHaveLength(2);
    layer.update(documentWith([])); // deletion
    expect(polygons(layer, 1)).toHaveLength(0);
  });

  it("invalidates passability while the tint is hidden and while it is visible", () => {
    const layer = new OverlayLayer();
    layer.build(documentWith([capital]), assets);
    layer.update(documentWith([{ ...capital, pos: { x: 10, y: 10 } }]));
    layer.setTint("passable", true);
    expect(polygons(layer, 0)).toHaveLength(25);
    expect(polygons(layer, 0)[0]?.slice(0, 2)).toEqual(Object.values(cellToWorld(10, 10)));
    layer.update(documentWith([]));
    expect(polygons(layer, 0)).toHaveLength(0);
  });

  it("updates terrain tints after painting without recreating the layer", () => {
    const layer = new OverlayLayer();
    const before = documentWith([]);
    layer.build(before, assets);
    layer.setTint("forest", true);
    const forest = { ...before, terrain: { cells: [{ x: 3, y: 4, ground: 1, roadType: -1 }] } } as MapDocument;
    layer.update(forest);
    expect(polygons(layer, 0)).toHaveLength(1);
    layer.update(before);
    expect(polygons(layer, 0)).toHaveLength(0);
  });

  it("does not outline an invisible garrisoned visitor", () => {
    const layer = new OverlayLayer();
    const visitor = { id: "ST0000", type: "stack", pos: { x: 2, y: 2 }, garrisoned: true } as MapObject;
    layer.build(documentWith([visitor]), assets);
    layer.setCursorCell({ x: 2, y: 2 });
    expect(polygons(layer, 1)).toHaveLength(0);
  });
});
