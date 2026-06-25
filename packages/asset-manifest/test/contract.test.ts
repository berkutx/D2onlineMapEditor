import { describe, it, expect } from "vitest";
import {
  AssetManifest,
  Spritesheet,
  MANIFEST_VERSION,
  D2_TICK_MS,
} from "../src/index";

describe("@d2/asset-manifest contract", () => {
  it("D2 tick is 42ms", () => {
    expect(D2_TICK_MS).toBe(42);
  });

  it("validates a minimal manifest with defaults applied", () => {
    const m = AssetManifest.parse({ manifestVersion: MANIFEST_VERSION });
    expect(m.tickMs).toBe(42);
    expect(m.paletteMode).toBe("baked");
    expect(m.spritesheets).toEqual([]);
  });

  it("validates a Pixi-compatible spritesheet with an animation", () => {
    const sheet = Spritesheet.parse({
      frames: {
        water_0: { frame: { x: 0, y: 0, w: 192, h: 192 } },
        water_1: { frame: { x: 192, y: 0, w: 192, h: 192 } },
      },
      animations: { water: ["water_0", "water_1"] },
      meta: { image: "terrain.webp", size: { w: 4096, h: 4096 }, d2: { fps: { water: 8 } } },
    });
    expect(sheet.animations?.water).toHaveLength(2);
    expect(sheet.meta.d2?.fps?.water).toBe(8);
  });

  it("defaults an animation's fps from the 42ms tick", () => {
    const m = AssetManifest.parse({
      manifestVersion: MANIFEST_VERSION,
      animations: [{ id: "a", atlas: "iso-anim", frames: ["f0", "f1"] }],
    });
    expect(m.animations[0]!.frameDurationMs).toBe(42);
    expect(Math.round(m.animations[0]!.fps)).toBe(24);
  });
});
