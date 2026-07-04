"""pipeline: Stage-1 orchestrator + CLI.

Decodes the Stage-1 .ff archives into PixiJS-v8 spritesheet atlases and a top-level
``manifest.json`` (Contract B) under ``public/assets/``.

Usage:
    python tools/asset-pipeline/pipeline.py \
        --game "<D2_GAME_DIR>/Game" --out public/assets --stage 1
"""
import argparse
import os
import sys

# allow `python tools/asset-pipeline/pipeline.py` from the repo root
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_animations
import build_atlases
import build_terrain_tiles
import decode_resource
import extract_ff
import manifest as manifest_mod

# Stage-1 OBJECT archives: every frame resolved via GameResource (the faithful
# IndexesData -> ImagesContainer -> ImageParts path), keyed by its logical id.
# Terrain (Ground/GrBorder) is composited separately by compose_terrain.py.
STAGE1_OBJECT_ARCHIVES = [
    ("iso-terrn", "IsoTerrn.ff"),  # mountains (MOMNE*), roads (ROAD*), forest, ...
    ("iso-still", "IsoStill.ff"),
    ("iso-cmon", "IsoCmon.ff"),
    ("city", "City.ff"),
    ("capital", "Capital.ff"),
    ("iso-anim", "IsoAnim.ff"),
]


def _register_bundle(builder, bundle, written, frames):
    for page_idx, (img_name, meta_name) in enumerate(written):
        sid = bundle if len(written) == 1 else "%s-%d" % (bundle, page_idx)
        builder.add_spritesheet(sid, img_name, meta_name, ff="IsoUnit.ff")
    for f in frames:
        builder.add_index(f.key, bundle, frame=f.key)


def _add_units(game_dir, out_dir, server, builder, stats):
    """Decode EVERY unit idle (STOP) sprite + boats from IsoUnit, map-independent.

    Boats (G000RR000<race>SBOA<rot>) go to one small UPFRONT atlas "iso-unit".
    Each unit's idle frames go to a LAZY per-impl chunk "unit-<impl>" that
    AssetStore loads on demand (ensureLoaded), so opening a map pulls only that
    map's units — not all ~350 (~20-30 MB) upfront. IsoUnit is 159 MB / 10k+
    records, so we scan its name table for the exact keys instead of decoding it
    wholesale."""
    import re
    path = extract_ff.find_archive(game_dir, "IsoUnit.ff")
    if not path:
        return
    raw = open(path, "rb").read()
    stop_keys = sorted(set(
        m.group(0).decode("latin1")
        for m in re.finditer(rb"G[0-9A-Za-z]{3}UU[0-9]{4}STOP[0-7]", raw)))
    boat_keys = sorted(set(
        m.group(0).decode("latin1")
        for m in re.finditer(rb"G000RR000[0-9]SBOA[0-7]", raw)))
    if not stop_keys and not boat_keys:
        return
    frames = decode_resource.decode_keys(path, stop_keys + boat_keys)
    boat_frames = [f for f in frames if "SBOA" in f.key]
    stop_frames = [f for f in frames if "STOP" in f.key]

    # boats: one upfront atlas (small; needed for any stack-on-water)
    if boat_frames:
        written = build_atlases.build_atlas(
            "iso-unit", boat_frames, out_dir, ff="IsoUnit.ff", shader="default", tile_w=None)
        _register_bundle(builder, "iso-unit", written, boat_frames)
        stats["sheets"] += len(written)

    # leader idle sprites: lazy per-impl chunks "unit-<impl>"
    by_impl = {}
    for f in stop_frames:
        by_impl.setdefault(f.key.split("STOP")[0], []).append(f)
    pages = 0
    for impl, ifr in by_impl.items():
        bundle = "unit-" + impl
        written = build_atlases.build_atlas(
            bundle, ifr, out_dir, ff="IsoUnit.ff", shader="default", tile_w=None)
        _register_bundle(builder, bundle, written, ifr)
        pages += len(written)

    stats["archives"] += 1
    stats["frames"] += len(frames)
    stats["sheets"] += pages
    sys.stderr.write(
        "  iso-unit: %d boats (upfront) + %d idle frames in %d lazy unit chunks\n"
        % (len(boat_frames), len(stop_frames), len(by_impl)))


def run_stage1(game_dir, out_dir, server="http://localhost:3000"):
    builder = manifest_mod.ManifestBuilder(source_game_version="GOG Gold")
    stats = {"archives": 0, "frames": 0, "sheets": 0, "animations": 0, "missing": []}

    for bundle_id, archive in STAGE1_OBJECT_ARCHIVES:
        path = extract_ff.find_archive(game_dir, archive)
        if not path:
            stats["missing"].append(archive)
            sys.stderr.write("  SKIP: %s not found\n" % archive)
            continue

        frames, animations = decode_resource.decode_bundle(path)
        if not frames:
            sys.stderr.write("  SKIP: %s decoded 0 frames\n" % archive)
            continue
        stats["archives"] += 1
        stats["frames"] += len(frames)

        anim_defs = (
            build_animations.animation_defs(animations, bundle_id) if animations else []
        )
        fps_map = build_animations.fps_map_for(animations) if animations else None

        written = build_atlases.build_atlas(
            bundle_id, frames, out_dir,
            ff=archive, shader="default", tile_w=None,
            animations=animations or None, fps_map=fps_map)

        for page_idx, (img_name, meta_name) in enumerate(written):
            sheet_id = bundle_id if len(written) == 1 else "%s-%d" % (bundle_id, page_idx)
            builder.add_spritesheet(sheet_id, img_name, meta_name, ff=archive)
        stats["sheets"] += len(written)

        for f in frames:
            builder.add_index(f.key, bundle_id, frame=f.key)

        if anim_defs:
            builder.add_animations(anim_defs)
            stats["animations"] += len(anim_defs)

    _add_units(game_dir, out_dir, server, builder, stats)

    # shared runtime-terrain base tile atlas (replaces per-map compose_terrain PNGs)
    try:
        build_terrain_tiles.add_terrain_base(game_dir, out_dir, builder, stats)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("  terrain-base: FAILED (%s)\n" % e)

    manifest_path = os.path.join(out_dir, "manifest.json")
    data = builder.write(manifest_path)
    ok, msg = manifest_mod.validate(data)
    return stats, manifest_path, ok, msg


def main(argv=None):
    ap = argparse.ArgumentParser(description="D2 .ff -> PixiJS atlases + AssetManifest")
    ap.add_argument("--game", required=True, help="path to the Game directory")
    ap.add_argument("--out", required=True, help="output dir (e.g. public/assets)")
    ap.add_argument("--stage", type=int, default=1, help="pipeline stage (only 1 supported)")
    ap.add_argument("--server", default="http://localhost:3000",
                    help="map server for the targeted IsoUnit (stack leaders) pass")
    args = ap.parse_args(argv)

    if args.stage != 1:
        ap.error("only --stage 1 is implemented")

    out_dir = os.path.abspath(args.out)
    print("D2 asset pipeline - Stage %d" % args.stage)
    print("  game:", args.game)
    print("  out :", out_dir)
    os.makedirs(out_dir, exist_ok=True)

    stats, manifest_path, ok, msg = run_stage1(args.game, out_dir, args.server)

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
