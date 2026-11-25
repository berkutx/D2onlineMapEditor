import { describe, it, expect } from "vitest";
import { AssetManifest, FrameEntry, MANIFEST_VERSION, SpritesheetRef } from "../src/index";

describe("asset manifest 0.2 (a frame table instead of a JSON per sheet)", () => {
  it("is the current version", () => {
    expect(MANIFEST_VERSION).toBe("0.2.0");
  });

  it("a sheet is an image: no meta, its own lazy flag and size", () => {
    const ref = SpritesheetRef.parse({
      id: "iso-cmon/1234",
      image: "blobs/ab/" + "ab".repeat(32) + ".png",
      bytes: 4096,
      lazy: true,
      size: [120, 64],
    });
    expect(ref.meta).toBeUndefined();
    expect(ref.lazy).toBe(true);
    // a 0.1 atlas page still parses
    expect(SpritesheetRef.parse({ id: "iso-anim-3", image: "iso-anim-3.png", meta: "iso-anim-3.json" }).lazy).toBeUndefined();
  });

  it("a frame entry is [sheet, x, y, w, h, trimX, trimY, sourceW, sourceH]", () => {
    expect(FrameEntry.safeParse([0, 10, 0, 32, 48, 4, 2, 64, 64]).success).toBe(true);
    expect(FrameEntry.safeParse([0, 10, 0, 32, 48, 4, 2, 64]).success).toBe(false); // too short
    expect(FrameEntry.safeParse([0, 10, 0, 0, 48, 4, 2, 64, 64]).success).toBe(false); // empty rect
    expect(FrameEntry.safeParse([-1, 10, 0, 32, 48, 4, 2, 64, 64]).success).toBe(false);
  });

  it("a manifest with a frame table needs no index; one without it is a 0.1 manifest", () => {
    const m = AssetManifest.parse({
      manifestVersion: MANIFEST_VERSION,
      spritesheets: [{ id: "iso-anim/7", image: "sheets/iso-anim/7.png", lazy: true }],
      frames: { "iso-anim:0H": [0, 0, 0, 32, 32, 0, 0, 32, 32], "1H": [0, 33, 0, 32, 32, 0, 0, 32, 32] },
      animations: [{ id: "G000FT0000HU0", atlas: "iso-anim/7", frames: ["iso-anim:0H", "1H"] }],
    });
    expect(Object.keys(m.frames ?? {})).toEqual(["iso-anim:0H", "1H"]);
    expect(m.index).toEqual({});
    expect(m.animations[0]!.frameDurationMs).toBe(42);
    expect(AssetManifest.parse({ manifestVersion: "0.1.0" }).frames).toBeUndefined();
  });
});
