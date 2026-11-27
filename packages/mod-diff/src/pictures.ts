/**
 * Pictures from the two mods' sprite manifests and icon files. A frame is the same picture
 * when its sheet's image blob and its rectangle are the same; the sheet INDEX is never
 * compared (it shifts between builds). An animation is the same when its frames are, in
 * order. An icon is the same when its file hash is.
 *
 * A changed blob only says the source record changed: pixels may still be equal. A sheet
 * shared by many frames (a terrain atlas) changes every frame on it.
 */
import { ID_PATTERN } from "@d2/mod-edit";
import type { Counts, ModData, PictureChange, PictureDiff, PictureSide, SpriteManifest } from "./types.js";

export interface FrameInfo {
  name: string;
  archive: string | null;
  sheet: string;
  image: string;
  sha256: string | null;
  rect: number[];
  sheetSize?: number[];
  ident: string;
}

export interface AnimInfo {
  name: string;
  archive: string | null;
  frames: string[];
  ident: string;
}

const SHA = /[0-9a-f]{64}/i;

/** The sha256 a store path or a bare hash names, lower case; null when none. */
export function shaOf(pathOrHash: string | undefined): string | null {
  const m = pathOrHash ? SHA.exec(pathOrHash) : null;
  return m ? m[0].toLowerCase() : null;
}

export function indexFrames(m: SpriteManifest | undefined): Map<string, FrameInfo> {
  const out = new Map<string, FrameInfo>();
  if (!m?.frames) return out;
  const shas = m.spritesheets.map((s) => shaOf(s.image));
  for (const [name, e] of Object.entries(m.frames)) {
    const sheet = m.spritesheets[e[0] ?? -1];
    if (!sheet) continue;
    const rect = e.slice(1).map(Number);
    const sha = shas[e[0]!] ?? null;
    const info: FrameInfo = { name, archive: sheet.ff ?? null, sheet: sheet.id, image: sheet.image, sha256: sha, rect, ident: `${sha ?? sheet.image}|${rect.join(",")}` };
    if (sheet.size) info.sheetSize = [...sheet.size];
    out.set(name, info);
  }
  return out;
}

export function indexAnimations(m: SpriteManifest | undefined, frames: Map<string, FrameInfo>): Map<string, AnimInfo> {
  const out = new Map<string, AnimInfo>();
  if (!m?.animations) return out;
  const sheetArchive = new Map(m.spritesheets.map((s) => [s.id, s.ff ?? null]));
  for (const a of m.animations) {
    const list = [...a.frames];
    const archive = (a.atlas !== undefined ? sheetArchive.get(a.atlas) : undefined) ?? frames.get(list[0] ?? "")?.archive ?? null;
    const ident = list.map((f) => frames.get(f)?.ident ?? `?${f}`).join(";");
    let key = a.id;
    for (let n = 2; out.has(key); n++) key = `${a.id}@${archive ?? n}`;
    out.set(key, { name: a.id, archive, frames: list, ident });
  }
  return out;
}

const frameSide = (f: FrameInfo): PictureSide => ({
  image: f.image,
  ...(f.sha256 ? { sha256: f.sha256 } : {}),
  sheet: f.sheet,
  rect: f.rect,
  ...(f.sheetSize ? { sheetSize: f.sheetSize } : {}),
});

const zero = (): Counts => ({ same: 0, added: 0, removed: 0, changed: 0 });

/** Icon folders of the store (uniticons/, itemicons/, ...). */
export const ICON_FOLDER = /^([a-z]+icons)\//i;

export function diffFrames(a: Map<string, FrameInfo>, b: Map<string, FrameInfo>, counts: Counts, out: PictureChange[]): void {
  for (const [name, fa] of a) {
    const fb = b.get(name);
    if (!fb) {
      counts.removed++;
      out.push({ kind: "frame", name, archive: fa.archive, change: "removed", a: frameSide(fa) });
    } else if (fa.ident !== fb.ident) {
      counts.changed++;
      out.push({ kind: "frame", name, archive: fb.archive ?? fa.archive, change: "changed", a: frameSide(fa), b: frameSide(fb) });
    } else counts.same++;
  }
  for (const [name, fb] of b) {
    if (a.has(name)) continue;
    counts.added++;
    out.push({ kind: "frame", name, archive: fb.archive, change: "added", b: frameSide(fb) });
  }
}

export function diffPictures(a: ModData, b: ModData, fa = indexFrames(a.manifest), fb = indexFrames(b.manifest)): PictureDiff {
  const changes: PictureChange[] = [];
  const frames = zero();
  diffFrames(fa, fb, frames, changes);

  const animations = zero();
  const aa = indexAnimations(a.manifest, fa);
  const ab = indexAnimations(b.manifest, fb);
  for (const [k, x] of aa) {
    const y = ab.get(k);
    if (!y) {
      animations.removed++;
      changes.push({ kind: "animation", name: x.name, archive: x.archive, change: "removed", a: { frames: x.frames } });
    } else if (x.ident !== y.ident) {
      animations.changed++;
      changes.push({ kind: "animation", name: x.name, archive: y.archive ?? x.archive, change: "changed", a: { frames: x.frames }, b: { frames: y.frames } });
    } else animations.same++;
  }
  for (const [k, y] of ab) {
    if (aa.has(k)) continue;
    animations.added++;
    changes.push({ kind: "animation", name: y.name, archive: y.archive, change: "added", b: { frames: y.frames } });
  }

  const icons = zero();
  const iconFiles = (files: ModData["files"]) => new Map(Object.entries(files ?? {}).filter(([n]) => ICON_FOLDER.test(n)));
  const ia = iconFiles(a.files);
  const ib = iconFiles(b.files);
  const iconSide = (path: string): PictureSide => {
    const sha = shaOf(path);
    return { image: path, ...(sha ? { sha256: sha } : {}) };
  };
  for (const [name, pa] of ia) {
    const folder = ICON_FOLDER.exec(name)![1]!;
    const pb = ib.get(name);
    if (pb === undefined) {
      icons.removed++;
      changes.push({ kind: "icon", name, archive: folder, change: "removed", a: iconSide(pa) });
    } else if ((shaOf(pa) ?? pa) !== (shaOf(pb) ?? pb)) {
      icons.changed++;
      changes.push({ kind: "icon", name, archive: folder, change: "changed", a: iconSide(pa), b: iconSide(pb) });
    } else icons.same++;
  }
  for (const [name, pb] of ib) {
    if (ia.has(name)) continue;
    icons.added++;
    changes.push({ kind: "icon", name, archive: ICON_FOLDER.exec(name)![1]!, change: "added", b: iconSide(pb) });
  }

  changes.sort((x, y) => (x.archive ?? "").localeCompare(y.archive ?? "") || x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name));
  const byArchive: PictureDiff["byArchive"] = {};
  for (const c of changes) {
    const k = c.archive ?? "";
    const n = (byArchive[k] ??= { added: 0, removed: 0, changed: 0 });
    n[c.change]++;
  }
  return { frames, animations, icons, byArchive, changes };
}

/** The entity id a picture name starts with ("G000UU0019STOP0" -> "G000UU0019"), upper case. */
export function pictureOwnerId(change: PictureChange): string | undefined {
  let name = change.name;
  if (change.kind === "icon") name = name.slice(name.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
  const head = name.slice(0, 10);
  return ID_PATTERN.test(head) ? head.toUpperCase() : undefined;
}
