"""pipeline: Stage-1 orchestrator + CLI.

Decodes the Stage-1 .ff archives into PixiJS-v8 spritesheet atlases and a top-level
``manifest.json`` (Contract B) under ``public/assets/``.

Usage:
    python tools/asset-pipeline/pipeline.py \
        --game "C:/GOG Games/last_version/Game" --out public/assets --stage 1
"""
import argparse
import os
import sys

# allow `python tools/asset-pipeline/pipeline.py` from the repo root
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_animations
import build_atlases
import build_terrain
import decode_images
import extract_ff
import manifest as manifest_mod
from fflib import naming

# Stage-1 bundles: (bundle_id, archive, shader, category)
#   category drives which extra index (terrain/animations) the bundle feeds.
STAGE1_BUNDLES = [
    ("iso-terrn", "IsoTerrn.ff", "default", "terrain"),
    ("ground", "Ground.ff", "border", "ground"),
    ("gr-border", "GrBorder.ff", "border", "border"),
    ("iso-still", "IsoStill.ff", "default", "object"),
    ("city", "City.ff", "default", "object"),
    ("capital", "Capital.ff", "default", "object"),
    ("iso-anim", "IsoAnim.ff", "default", "animation"),
]


def _decode_bundle(archive_path, shader):
    """Decode one archive -> list of trimmed :class:`Frame` (deduped by key)."""
    _name, images = extract_ff.extract(archive_path)
    frames = []
    seen = set()
    for img in images:
        key = naming.frame_key(img.name)
        if key in seen:
            continue
        seen.add(key)
        try:
            frames.append(decode_images.decode_frame(img, key, shader=shader))
        except Exception as e:  # a single corrupt PNG must not sink the bundle
            sys.stderr.write("  WARN: failed to decode %s (id=%d): %s\n" % (
                img.name, img.id, e))
    return frames


def run_stage1(game_dir, out_dir):
    builder = manifest_mod.ManifestBuilder(source_game_version="GOG/last_version")
    stats = {"archives": 0, "frames": 0, "sheets": 0, "animations": 0, "missing": []}

    ground_keys = []
    border_keys = []
    terrn_keys = []

    for bundle_id, archive, shader, category in STAGE1_BUNDLES:
        path = extract_ff.find_archive(game_dir, archive)
        if not path:
            stats["missing"].append(archive)
            sys.stderr.write("  SKIP: %s not found\n" % archive)
            continue

        frames = _decode_bundle(path, shader)
        if not frames:
            sys.stderr.write("  SKIP: %s decoded 0 frames\n" % archive)
            continue
        stats["archives"] += 1
        stats["frames"] += len(frames)

        keys = [f.key for f in frames]

        animations = None
        fps_map = None
        anim_defs = []
        if category == "animation":
            animations = build_animations.group_animations(keys)
            fps_map = build_animations.fps_map_for(animations)
            anim_defs = build_animations.animation_defs(animations, bundle_id)

        if category == "ground":
            ground_keys = keys
        elif category == "border":
            border_keys = keys
        elif category == "terrain":
            terrn_keys = keys

        tile_w = build_terrain.TILE_W if category in ("ground", "border", "terrain") else None

        written = build_atlases.build_atlas(
            bundle_id, frames, out_dir,
            ff=archive, shader=shader, tile_w=tile_w,
            animations=animations, fps_map=fps_map)

        for page_idx, (img_name, meta_name) in enumerate(written):
            sheet_id = bundle_id if len(written) == 1 else "%s-%d" % (bundle_id, page_idx)
            builder.add_spritesheet(sheet_id, img_name, meta_name, ff=archive)
        stats["sheets"] += len(written)

        # frame -> sheet index (point each key at its first/owning bundle sheet)
        for f in frames:
            builder.add_index(f.key, bundle_id, frame=f.key)

        if anim_defs:
            builder.add_animations(anim_defs)
            stats["animations"] += len(anim_defs)

    # terrain index (from ground + border + iso-terrn)
    terrain = build_terrain.build_terrain_index(ground_keys, border_keys, terrn_keys)
    builder.set_terrain(terrain)

    manifest_path = os.path.join(out_dir, "manifest.json")
    data = builder.write(manifest_path)
    ok, msg = manifest_mod.validate(data)
    return stats, manifest_path, ok, msg


def main(argv=None):
    ap = argparse.ArgumentParser(description="D2 .ff -> PixiJS atlases + AssetManifest")
    ap.add_argument("--game", required=True, help="path to the Game directory")
    ap.add_argument("--out", required=True, help="output dir (e.g. public/assets)")
    ap.add_argument("--stage", type=int, default=1, help="pipeline stage (only 1 supported)")
    args = ap.parse_args(argv)

    if args.stage != 1:
        ap.error("only --stage 1 is implemented")

    out_dir = os.path.abspath(args.out)
    print("D2 asset pipeline - Stage %d" % args.stage)
    print("  game:", args.game)
    print("  out :", out_dir)
    os.makedirs(out_dir, exist_ok=True)

    stats, manifest_path, ok, msg = run_stage1(args.game, out_dir)

    print("\nSUMMARY")
    print("  archives processed:", stats["archives"])
    print("  frames decoded    :", stats["frames"])
    print("  atlas sheets      :", stats["sheets"])
    print("  animations        :", stats["animations"])
    if stats["missing"]:
        print("  missing archives  :", ", ".join(stats["missing"]))
    print("  manifest          :", manifest_path)
    print("  validation        :", "OK" if ok else "FAIL", "-", msg)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
