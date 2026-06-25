"""build_atlases: pack decoded frames into PixiJS-v8 spritesheet atlases.

Emits, per bundle, one or more atlas PNG pages and a Pixi "JSON Hash" spritesheet
(``frames`` / ``animations`` / ``meta``) that ``Assets.load()`` consumes natively.
Trim metadata is preserved via ``spriteSourceSize`` / ``sourceSize``; the ``meta.d2``
extension carries the source archive, shader kind, tile width and per-animation fps.
"""
import json
import os

import numpy as np
from PIL import Image

from fflib import packer

# D2 animation clock (VERIFIED 42ms/frame -> ~23.81fps). Pixi: animationSpeed = fps/60.
TICK_MS = 42
FPS = 1000.0 / TICK_MS  # 23.8095...


def _page_filename(bundle_id, page, total_pages):
    if total_pages == 1:
        return "%s.png" % bundle_id
    return "%s-%d.png" % (bundle_id, page)


def build_atlas(bundle_id, frames, out_dir, ff=None, shader=None, tile_w=None,
                animations=None, fps_map=None, max_size=packer.DEFAULT_MAX):
    """Pack ``frames`` (list of :class:`decode_images.Frame`) into atlas page(s).

    Writes ``<bundle_id>[-N].png`` + ``<bundle_id>.json`` under ``out_dir``.
    Returns a list of ``(image_path, meta_path)`` relative to ``out_dir`` - one
    entry per page (each page gets its own Pixi spritesheet JSON, as Pixi requires
    a 1:1 image<->json mapping).
    """
    os.makedirs(out_dir, exist_ok=True)
    by_key = {f.key: f for f in frames}
    rects = [(f.key, f.w, f.h) for f in frames]
    # keep each animation's frames on one page so the Pixi-native `animations`
    # block is usable (the manifest array is authoritative regardless).
    groups = None
    if animations:
        groups = {}
        for aid, keys in animations.items():
            for k in keys:
                groups[k] = aid
    placements, page_sizes = packer.pack(rects, max_size=max_size, groups=groups)

    # group placements per page
    pages = {}
    for p in placements:
        pages.setdefault(p.page, []).append(p)

    total_pages = len(page_sizes)
    written = []

    for page_idx in sorted(pages.keys()):
        pw, ph = page_sizes[page_idx]
        canvas = np.zeros((ph, pw, 4), dtype=np.uint8)
        sheet_frames = {}
        for pl in pages[page_idx]:
            f = by_key[pl.key]
            canvas[pl.y:pl.y + f.h, pl.x:pl.x + f.w] = f.rgba
            sheet_frames[pl.key] = {
                "frame": {"x": pl.x, "y": pl.y, "w": f.w, "h": f.h},
                "rotated": False,
                "trimmed": bool(f.trimmed),
                "spriteSourceSize": {"x": f.trim_x, "y": f.trim_y, "w": f.w, "h": f.h},
                "sourceSize": {"w": f.src_w, "h": f.src_h},
            }

        img_name = _page_filename(bundle_id, page_idx, total_pages)
        meta_name = (img_name[:-4] + ".json")
        Image.fromarray(canvas, "RGBA").save(os.path.join(out_dir, img_name))

        # only attach animations whose frames all live on this page
        page_keys = set(sheet_frames.keys())
        page_anims = {}
        page_fps = {}
        if animations:
            for aid, keys in animations.items():
                if keys and all(k in page_keys for k in keys):
                    page_anims[aid] = list(keys)
                    if fps_map and aid in fps_map:
                        page_fps[aid] = fps_map[aid]

        meta = {
            "image": img_name,
            "format": "RGBA8888",
            "size": {"w": pw, "h": ph},
            "scale": 1,
            "d2": {},
        }
        if ff:
            meta["d2"]["ff"] = ff
        if shader:
            meta["d2"]["shader"] = shader
        if tile_w:
            meta["d2"]["tileW"] = tile_w
        if page_fps:
            meta["d2"]["fps"] = page_fps
        if not meta["d2"]:
            del meta["d2"]

        sheet = {"frames": sheet_frames, "meta": meta}
        if page_anims:
            sheet["animations"] = page_anims

        with open(os.path.join(out_dir, meta_name), "w") as fp:
            json.dump(sheet, fp, indent=1)

        written.append((img_name, meta_name))

    return written
