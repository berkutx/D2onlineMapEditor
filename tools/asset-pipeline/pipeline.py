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


def _needed_unit_keys(server):
    """Leader STOP{facing} keys the map's stacks reference (IsoUnit is far too large
    to decode wholesale). Resolves stack.leaderUnitId -> unit.implId -> key."""
    import json
    import urllib.request
    try:
        scen = json.load(urllib.request.urlopen(server + "/api/scenarios"))
        riders = next((s for s in scen if "Rider" in s.get("name", "")), scen[0])
        doc = json.load(urllib.request.urlopen(server + "/api/maps/" + riders["id"]))
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("  unit keys: map fetch failed (%s); skipping IsoUnit\n" % e)
        return set()
    impl = {o["id"]: o["implId"] for o in doc.get("objects", [])
            if o.get("type") == "unit" and o.get("implId")}
    keys = set()
    for o in doc.get("objects", []):
        if o.get("type") == "stack" and o.get("leaderUnitId"):
            im = impl.get(o["leaderUnitId"])
            if im:
                keys.add("%sSTOP%d" % (im, o.get("facing", 0) or 0))
    return keys


def _needed_boat_keys(out_dir):
    """Boat body sprites for stacks on water: G000RR000<race>SBOA<rot>, rot 0..7,
    for every race in objectdata.json's unitBoat (boat-eligible leaders). Boat shadow
    (BOAT key) is deferred with the Shadows shader. Requires extract_gamedata to have
    run first (it writes unitBoat)."""
    import json
    try:
        data = json.load(open(os.path.join(out_dir, "objectdata.json")))
    except Exception:  # noqa: BLE001
        return set()
    races = set((data.get("unitBoat") or {}).values())
    return {"G000RR000%dSBOA%d" % (r, rot) for r in races for rot in range(8)}


def _add_units(game_dir, out_dir, server, builder, stats):
    """Targeted IsoUnit pass: decode only the leader (+ boat) sprites the map uses."""
    keys = _needed_unit_keys(server) | _needed_boat_keys(out_dir)
    path = extract_ff.find_archive(game_dir, "IsoUnit.ff")
    if not keys or not path:
        return
    frames = decode_resource.decode_keys(path, keys)
    if not frames:
        return
    written = build_atlases.build_atlas(
        "iso-unit", frames, out_dir, ff="IsoUnit.ff", shader="default", tile_w=None)
    for page_idx, (img_name, meta_name) in enumerate(written):
        sheet_id = "iso-unit" if len(written) == 1 else "iso-unit-%d" % page_idx
        builder.add_spritesheet(sheet_id, img_name, meta_name, ff="IsoUnit.ff")
    for f in frames:
        builder.add_index(f.key, "iso-unit", frame=f.key)
    stats["archives"] += 1
    stats["frames"] += len(frames)
    stats["sheets"] += len(written)
    sys.stderr.write("  iso-unit: %d leader sprites (of %d requested)\n"
                     % (len(frames), len(keys)))


def run_stage1(game_dir, out_dir, server="http://localhost:3000"):
    builder = manifest_mod.ManifestBuilder(source_game_version="GOG/last_version")
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
