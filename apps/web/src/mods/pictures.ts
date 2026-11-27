/**
 * Pictures of one mod: a manifest frame as a crop of its sheet, the first frame of an
 * animation, a store path as a URL. Sheets are content-addressed blobs shared by every mod.
 */
import type { PictureChange, PictureSide, SpriteManifest } from "@d2/mod-diff";
import { assetStoreUrl } from "../services/api";

/** URL of a store path ("blobs/<xx>/<sha>.png"). */
export function storeUrl(path: string): string {
  return `${assetStoreUrl()}/${path.replace(/^\//, "")}`;
}

/** A manifest frame as a picture side, or null when the manifest has no such frame. */
export function frameSide(manifest: SpriteManifest | null | undefined, name: string): PictureSide | null {
  if (!manifest?.frames) return null;
  // animation frame lists may name a frame with its atlas ("iso-cmon:A")
  const f = manifest.frames[name] ?? (name.includes(":") ? manifest.frames[name.slice(name.indexOf(":") + 1)] : undefined);
  if (!f) return null;
  const sheet = manifest.spritesheets[f[0] ?? -1];
  if (!sheet) return null;
  return { image: sheet.image, sheet: sheet.id, rect: f.slice(1, 9) as number[], sheetSize: sheet.size ? [...sheet.size] : undefined };
}

/** The picture to draw for one side of a change: a frame as it is, an animation's first frame. */
export function drawable(change: PictureChange, side: PictureSide | undefined, manifest: SpriteManifest | null | undefined): PictureSide | null {
  if (!side) return null;
  if (change.kind === "frame" && side.image && side.rect) return side;
  if (change.kind === "animation" && side.frames?.length) {
    for (const name of side.frames) {
      const f = frameSide(manifest, name);
      if (f) return f;
    }
  }
  return null;
}

/** A unit's figure on the map (its STOP frame), when the mod has one. */
export function unitFigure(manifest: SpriteManifest | null | undefined, unitId: string): PictureSide | null {
  const id = unitId.toUpperCase();
  for (const facing of [0, 1, 7, 2]) {
    const f = frameSide(manifest, `${id}STOP${facing}`);
    if (f) return f;
  }
  return null;
}
