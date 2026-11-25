"""build_sheets: a mod's graphics as small sprite sheets + AssetManifest 0.2.

pipeline.py packs every frame of an archive into shared RGBA pages ("iso-anim-17.png"): one
new sprite shifts the whole layout, so no two mods ever produce the same file, and palette
art is inflated 5-8x. Here the unit of output is the unit the GAME stores:

  * one sheet per SOURCE IMAGE RECORD of a .ff archive (a record already holds the frames
    that belong together: one landmark, one animation, one forest set);
  * the frames are assembled from the record's parts exactly as GameResource does, but stay
    in palette indices — the sheet is a palette PNG whose colour-key entries are transparent
    (tRNS). A sheet falls back to RGBA only when its frames do not share one palette;
  * a sheet depends on nothing but its record, the shader and this file, so the same record
    in two mods gives the same bytes: stored once in the blob store, cached once by a browser.

Frame rectangles live in ONE table in the manifest (no JSON per sheet). An animation lists
existing frame keys; it never gets a second copy of the pixels.

Everything the map renderer resolves SYNCHRONOUSLY while building terrain is eager (terrain
tiles, IsoTerrn: roads, forests, mountains); the rest is fetched per map by frame key.

    python tools/asset-pipeline/build_sheets.py --game "<game>" --out <dir> [--with-capital]
"""
import argparse
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import build_terrain_tiles  # noqa: E402
import extract_ff  # noqa: E402
import manifest as manifest_mod  # noqa: E402
from build_atlases import FPS, TICK_MS  # noqa: E402
from decode_images import _trim_bbox  # noqa: E402
from decode_resource import _shader_for  # noqa: E402
from fflib import packer  # noqa: E402
from fflib.gameresource import GameResource, SH_DEFAULT, assemble, transparent_colors  # noqa: E402

MANIFEST_VERSION = "0.2.0"
MAX_SHEET = 2048

# (bundle id, archive, lazy). Order = precedence: a frame key or animation id defined by
# several archives belongs to the first (a still in IsoCmon wins over IsoAnim's).
OBJECT_ARCHIVES = [
    ("iso-terrn", "IsoTerrn.ff", False),
    ("iso-still", "IsoStill.ff", True),
    ("iso-cmon", "IsoCmon.ff", True),
    ("city", "City.ff", True),
    ("iso-anim", "IsoAnim.ff", True),
]
# city-screen backgrounds: nothing in the editor draws them yet
CAPITAL = ("capital", "Capital.ff", True)


class RawFrame(object):
    """One assembled, UNTRIMMED frame: palette indices (+ palette, + which entries are
    transparent) for a palette source, or RGBA for a true-colour one."""

    __slots__ = ("key", "idx", "palette", "transp", "rgba")

    def __init__(self, key, idx=None, palette=None, transp=None, rgba=None):
        self.key = key
        self.idx = idx
        self.palette = palette
        self.transp = transp
        self.rgba = rgba

    def to_rgba(self):
        if self.rgba is not None:
            return self.rgba
        alpha = np.where(self.transp[self.idx], 0, 255).astype(np.uint8)
        return np.dstack([self.palette[self.idx], alpha])


class Sheet(object):
    """One PNG and where its frames sit: ``frames = [(key, x, y, w, h, trimX, trimY, srcW, srcH)]``."""

    __slots__ = ("id", "png", "w", "h", "frames", "mode")

    def __init__(self, sid, png, w, h, frames, mode):
        self.id = sid
        self.png = png
        self.w = w
        self.h = h
        self.frames = frames
        self.mode = mode


def raw_frame(key, source, w, h, parts, shader):
    """Assemble one frame from a decoded source (GameResource.source_pixels)."""
    kind, pixels, palette = source
    if kind == "P":
        return RawFrame(key, idx=assemble(pixels, w, h, parts), palette=palette,
                        transp=transparent_colors(palette, shader))
    rgb = assemble(pixels, w, h, parts)
    covered = assemble(np.ones(pixels.shape[:2], np.uint8), w, h, parts) > 0
    alpha = np.where(covered & ~transparent_colors(rgb, shader), 255, 0).astype(np.uint8)
    return RawFrame(key, rgba=np.dstack([rgb, alpha]))


def _encode_p(canvas, palette, transp):
    im = Image.fromarray(canvas, "P")
    im.putpalette(palette.astype(np.uint8).tobytes())
    buf = io.BytesIO()
    im.save(buf, "PNG", transparency=bytes(0 if t else 255 for t in transp), compress_level=9)
    return buf.getvalue()


def _encode_rgba(canvas):
    buf = io.BytesIO()
    Image.fromarray(canvas, "RGBA").save(buf, "PNG", compress_level=9)
    return buf.getvalue()


def make_sheets(sheet_id, raws):
    """Trim and pack frames into sheet(s): normally one; more only when they overflow
    MAX_SHEET. Deterministic: the same frames always give the same bytes."""
    if not raws:
        return []
    first = raws[0]
    indexed = (
        all(r.idx is not None for r in raws)
        and all(np.array_equal(r.palette, first.palette) and np.array_equal(r.transp, first.transp) for r in raws)
        and bool(first.transp.any())  # the sheet's background needs a transparent entry
    )
    cells = []
    for r in raws:
        pixels = r.idx if indexed else r.to_rgba()
        opaque = ~r.transp[r.idx] if indexed else pixels[..., 3] != 0
        src_h, src_w = int(pixels.shape[0]), int(pixels.shape[1])
        bbox = _trim_bbox(opaque)
        if bbox is None:  # nothing visible: keep a 1x1 stub so the key still resolves
            x0, y0, x1, y1 = 0, 0, 1, 1
        else:
            x0, y0, x1, y1 = bbox
        cells.append((r.key, pixels[y0:y1, x0:x1], x0, y0, src_w, src_h))

    by_key = dict((c[0], c) for c in cells)
    placements, _sizes = packer.pack(
        [(c[0], c[1].shape[1], c[1].shape[0]) for c in cells], max_size=MAX_SHEET)
    pages = {}
    for p in placements:
        pages.setdefault(p.page, []).append(p)

    out = []
    for n, page in enumerate(sorted(pages)):
        placed = pages[page]
        w = max(p.x + p.w for p in placed)
        h = max(p.y + p.h for p in placed)
        if indexed:
            canvas = np.full((h, w), int(np.argmax(first.transp)), np.uint8)
        else:
            canvas = np.zeros((h, w, 4), np.uint8)
        frames = []
        for p in placed:
            key, pixels, tx, ty, src_w, src_h = by_key[p.key]
            canvas[p.y : p.y + p.h, p.x : p.x + p.w] = pixels
            frames.append((key, p.x, p.y, p.w, p.h, tx, ty, src_w, src_h))
        png = _encode_p(canvas, first.palette, first.transp) if indexed else _encode_rgba(canvas)
        sid = sheet_id if len(pages) == 1 else "%s.%d" % (sheet_id, n)
        out.append(Sheet(sid, png, w, h, frames, "P" if indexed else "RGBA"))
    return out


def archive_sheets(path, bundle):
    """Every image record of an archive as sheet(s), plus its animations.

    Returns ``(sheets, animations)``; ``animations = [(ID, [frame keys])]`` in file order,
    holding only frames that were built. Keys are the UPPERCASE logical ids, as everywhere.

    The colour key belongs to the id something is ASKED BY, not to the image: a crystal's
    animation (G000CR...) drops the black field of frames that keep it under their own
    names. Where an animation's shader differs from its frame's own, the frame is built a
    second time for that animation, as ``<ANIMATION>#<n>``; everywhere else an animation
    simply lists its frames' own keys and no pixel is stored twice."""
    gr = GameResource(path)
    sheets = []
    animations = []
    seen = set()  # a key is built once per archive, from the first record that has it
    if gr.indexes_opt is None:
        for uid, name in gr.standalone_images():
            src = gr.source_pixels(uid)
            if src is None or name.upper() in seen:
                continue
            seen.add(name.upper())
            h, w = src[1].shape[:2]
            raw = raw_frame(name.upper(), src, w, h, [(0, 0, 0, 0, w, h)], _shader_for(name))
            sheets.extend(make_sheets("%s/%d" % (bundle, uid), [raw]))
        return sheets, animations

    # what each animation is made of, and which records owe it a re-shaded frame
    plans = []    # (ID, [(frame name, variant key prefix or None)])
    variants = {}  # uid -> [(prefix, frame name, shader)]
    for name, frame_names in gr.animation_names():
        shader = _shader_for(name)
        plan = []
        for n, fn in enumerate(frame_names):
            desc = gr._index.get(fn.lower())
            if desc is None or desc[0] == -1:
                continue
            prefix = None
            if _shader_for(fn) != shader:
                prefix = "%s#%d" % (name.upper(), n)
                variants.setdefault(desc[0], []).append((prefix, fn, shader))
            plan.append((fn, prefix))
        plans.append((name.upper(), plan))

    own_keys = {}      # image name (as the archive spells it) -> its frame keys
    variant_keys = {}  # variant prefix -> its frame keys
    for uid, names, images in gr.image_records():
        src = gr.source_pixels(uid)
        if src is None:
            continue
        wanted = set(names)
        # an id normally names ONE image of the block; several images under one name are
        # its frames, in block order (keys ID#0, ID#1, ... and an animation ID)
        per_name = {}
        order = []
        for (iname, w, h, parts) in images:
            if iname not in wanted or not parts:
                continue
            if iname not in per_name:
                per_name[iname] = []
                order.append(iname)
            per_name[iname].append((w, h, parts))
        by_shader = {}

        def add(base, group, shader):
            keys = [base] if len(group) == 1 else ["%s#%d" % (base, i) for i in range(len(group))]
            built = []
            for k, (w, h, parts) in zip(keys, group):
                try:
                    by_shader.setdefault(shader, []).append(raw_frame(k, src, w, h, parts, shader))
                    built.append(k)
                except (ValueError, IndexError):
                    continue  # a part outside the source: the editor shows nothing either
            return built

        for iname in order:
            key = iname.upper()
            if key in seen:
                continue
            seen.add(key)
            own_keys[iname] = add(key, per_name[iname], _shader_for(iname))
            if len(own_keys[iname]) > 1:
                animations.append((key, own_keys[iname]))
        for prefix, fn, shader in variants.get(uid, []):
            if fn in per_name and prefix not in seen:
                seen.add(prefix)
                variant_keys[prefix] = add(prefix, per_name[fn], shader)
        for shader in sorted(by_shader):
            sid = "%s/%d" % (bundle, uid) if shader == SH_DEFAULT else "%s/%d.s%d" % (bundle, uid, shader)
            sheets.extend(make_sheets(sid, by_shader[shader]))

    for aid, plan in plans:
        keys = []
        for fn, prefix in plan:
            keys.extend(variant_keys.get(prefix, []) if prefix else own_keys.get(fn, []))
        animations.append((aid, keys))
    return sheets, animations


def unit_sheets(path):
    """IsoUnit: each unit's idle frame per facing (frame 0 of STOP0..7) as a lazy sheet
    "unit/<IMPL>", and the boats as one eager sheet "iso-unit". IsoUnit is 150+ MB of
    animations, so only these exact keys are resolved — never the whole archive."""
    with open(path, "rb") as fp:
        raw = fp.read()
    stop_keys = sorted(set(m.group(0).decode("latin1")
                           for m in re.finditer(rb"G[0-9A-Za-z]{3}UU[0-9]{4}STOP[0-7]", raw)))
    boat_keys = sorted(set(m.group(0).decode("latin1")
                           for m in re.finditer(rb"G000RR000[0-9]SBOA[0-7]", raw)))
    del raw
    gr = GameResource(path)
    cache = {}

    def first_frame(key):
        hit = gr.resolve_first(key)
        if hit is None:
            return None
        uid, w, h, parts = hit
        if uid not in cache:
            if len(cache) > 8:
                cache.clear()
            cache[uid] = gr.source_pixels(uid)
        if cache[uid] is None:
            return None
        try:
            return raw_frame(key.upper(), cache[uid], w, h, parts, SH_DEFAULT)
        except (ValueError, IndexError):
            return None

    eager, lazy = [], []
    boats = [f for f in (first_frame(k) for k in boat_keys) if f is not None]
    eager.extend(make_sheets("iso-unit", boats))
    by_impl = {}
    for key in stop_keys:
        by_impl.setdefault(key.split("STOP")[0], []).append(key)
    for impl in sorted(by_impl):
        frames = [f for f in (first_frame(k) for k in by_impl[impl]) if f is not None]
        lazy.extend(make_sheets("unit/" + impl.upper(), frames))
    return eager, lazy


class _TerrainCapture(object):
    """Stands in for pipeline.py's ManifestBuilder while build_terrain_tiles runs: it only
    notes which pages were written (their frames are read back from the page metas)."""

    def __init__(self):
        self.pages = []

    def add_spritesheet(self, sid, image, meta, ff=None):
        self.pages.append((sid, image, meta, ff))

    def add_index(self, frame_key, sheet_id, frame=None):
        pass


def terrain_sheets(game_dir, tmp_dir):
    """The shared terrain tile atlases (base ground, pre-blended borders, water foam), built
    by build_terrain_tiles unchanged and re-expressed as sheets."""
    capture = _TerrainCapture()
    stats = {"archives": 0, "frames": 0, "sheets": 0}
    build_terrain_tiles.add_terrain_base(game_dir, tmp_dir, capture, stats)
    sheets = []
    for sid, image, meta, _ff in capture.pages:
        with open(os.path.join(tmp_dir, meta)) as fp:
            page = json.load(fp)
        frames = []
        for key in sorted(page["frames"]):
            f = page["frames"][key]
            fr, sss, ss = f["frame"], f["spriteSourceSize"], f["sourceSize"]
            frames.append((key, fr["x"], fr["y"], fr["w"], fr["h"], sss["x"], sss["y"], ss["w"], ss["h"]))
        with open(os.path.join(tmp_dir, image), "rb") as fp:
            png = fp.read()
        size = page["meta"]["size"]
        sheets.append(Sheet(sid, png, size["w"], size["h"], frames, "RGBA"))
        os.remove(os.path.join(tmp_dir, meta))
        os.remove(os.path.join(tmp_dir, image))
    return sheets


def dump_json(obj):
    """Deterministic JSON bytes: same data -> same bytes -> same blob."""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


class FrameTable(object):
    """What the manifest says about the sheets: their list, where every frame sits, and the
    animations — with the two rules that make keys from several archives live together.

    * A frame key belongs to the first archive that defines it (a still in IsoCmon wins over
      a frame of the same name in IsoAnim). A later frame of the same name is not lost: it is
      entered as ``<archive>:<KEY>``.
    * An animation is made of the frames of ITS archive. Frame names such as "A" or "0H" are
      unique only inside one archive, so each archive resolves its animations through its
      own key map (``own``), never through the shared table.
    """

    def __init__(self):
        self.refs = []        # manifest spritesheets, in sheet-index order
        self.frames = {}      # frame key -> [sheet index, x, y, w, h, trimX, trimY, srcW, srcH]
        self.animations = []
        self.shadowed = 0     # frames that had to take a qualified key (or were dropped)
        self._anim_ids = set()

    def add_sheet(self, sheet, image, ff=None, lazy=False, own=None, scope=None):
        """Enter a sheet. ``own`` collects key -> the key it got in the table; ``scope`` is the
        prefix for a key that is already taken (without one such a frame is dropped)."""
        index = len(self.refs)
        ref = {"id": sheet.id, "image": image, "bytes": len(sheet.png), "size": [sheet.w, sheet.h]}
        if ff:
            ref["ff"] = ff
        if lazy:
            ref["lazy"] = True
        self.refs.append(ref)
        for (key, x, y, w, h, tx, ty, sw, sh) in sheet.frames:
            table_key = key
            if key in self.frames:
                self.shadowed += 1
                if scope is None:
                    continue
                table_key = "%s:%s" % (scope, key)
            self.frames[table_key] = [index, x, y, w, h, tx, ty, sw, sh]
            if own is not None:
                own[key] = table_key

    def add_animations(self, anims, own):
        """Enter an archive's ``[(ID, [frame keys])]``, resolved through that archive's ``own``."""
        for aid, keys in anims:
            keys = [own[k] for k in keys if k in own]
            if len(keys) == 1:
                # one frame is not an animation: the id is another name of that frame
                self.frames.setdefault(aid, self.frames[keys[0]])
                continue
            # An animation may share its id with a still frame (the object's static look,
            # usually from an earlier archive): the renderer asks for the animation first.
            if len(keys) < 2 or aid in self._anim_ids:
                continue
            self._anim_ids.add(aid)
            self.animations.append({
                "id": aid, "atlas": self.refs[self.frames[keys[0]][0]]["id"], "frames": keys,
                "frameDurationMs": TICK_MS, "fps": FPS, "loop": True})


def build(game_dir, out_dir, blob_rel=None, with_capital=False, log=None):
    """Write ``sheets/<sheet id>.png`` and ``manifest.json`` under ``out_dir``.

    ``blob_rel(abs path) -> "blobs/xx/<sha>.png"`` names a sheet's place in a blob store; the
    manifest then points at the blob (one URL for every mod that has the same sheet). Without
    it the manifest points at ``sheets/<id>.png`` next to itself. Returns a stats dict."""
    log = log or (lambda msg: sys.stderr.write(msg + os.linesep))
    os.makedirs(out_dir, exist_ok=True)
    table = FrameTable()
    stats = {"sheets": 0, "frames": 0, "bytes": 0, "palette": 0, "rgba": 0,
             "shadowed": 0, "animations": 0, "missing": []}

    def emit(sheet, ff, lazy, own=None, scope=None):
        rel = "sheets/%s.png" % sheet.id
        path = os.path.join(out_dir, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fp:
            fp.write(sheet.png)
        table.add_sheet(sheet, blob_rel(path) if blob_rel else rel, ff, lazy, own, scope)
        stats["sheets"] += 1
        stats["bytes"] += len(sheet.png)
        stats["palette" if sheet.mode == "P" else "rgba"] += 1

    for sheet in terrain_sheets(game_dir, out_dir):
        emit(sheet, "Ground.ff" if sheet.id.startswith("terrain-base") else "GrBorder.ff", False)

    archives = OBJECT_ARCHIVES + ([CAPITAL] if with_capital else [])
    for bundle, archive, lazy in archives:
        path = extract_ff.find_archive(game_dir, archive)
        if not path:
            stats["missing"].append(archive)
            log("  SKIP: %s not found" % archive)
            continue
        sheets, anims = archive_sheets(path, bundle)
        own = {}
        for sheet in sheets:
            emit(sheet, archive, lazy, own, bundle)
        table.add_animations(anims, own)
        log("  %s: %d sheets, %d animations" % (bundle, len(sheets), len(anims)))

    unit_path = extract_ff.find_archive(game_dir, "IsoUnit.ff")
    if unit_path:
        eager, lazy = unit_sheets(unit_path)
        for sheet in eager:
            emit(sheet, "IsoUnit.ff", False)
        for sheet in lazy:
            emit(sheet, "IsoUnit.ff", True)
        log("  iso-unit: %d boat sheet(s), %d unit sheets" % (len(eager), len(lazy)))
    else:
        stats["missing"].append("IsoUnit.ff")

    manifest = {
        "manifestVersion": MANIFEST_VERSION,
        "tickMs": TICK_MS,
        "paletteMode": "baked",
        "spritesheets": table.refs,
        "frames": table.frames,
        "index": {},
        "animations": table.animations,
        "objectNaming": manifest_mod.OBJECT_NAMING,
    }
    with open(os.path.join(out_dir, "manifest.json"), "wb") as fp:
        fp.write(dump_json(manifest))
    stats["frames"] = len(table.frames)
    stats["animations"] = len(table.animations)
    stats["shadowed"] = table.shadowed
    stats["manifest"] = manifest
    return stats


def main(argv=None):
    ap = argparse.ArgumentParser(description="D2 .ff -> per-record sprite sheets + AssetManifest 0.2")
    ap.add_argument("--game", required=True, help="path to the Game directory")
    ap.add_argument("--out", required=True, help="output dir (sheets/ and manifest.json)")
    ap.add_argument("--with-capital", action="store_true", help="also build Capital.ff (city screens)")
    args = ap.parse_args(argv)
    stats = build(args.game, os.path.abspath(args.out), with_capital=args.with_capital)
    ok, msg = manifest_mod.validate(stats["manifest"])
    print("sheets %d (%d palette, %d RGBA), %.1f MB; frames %d, animations %d, shadowed keys %d" % (
        stats["sheets"], stats["palette"], stats["rgba"], stats["bytes"] / 1048576.0,
        stats["frames"], stats["animations"], stats["shadowed"]))
    if stats["missing"]:
        print("missing archives:", ", ".join(stats["missing"]))
    print("validation:", "OK" if ok else "FAIL", "-", msg)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
