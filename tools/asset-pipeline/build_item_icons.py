"""build_item_icons: extract item inventory icons from Imgs/IconItem.ff into per-icon PNGs.

IconItem.ff records are named by the item's ITEM_ID (e.g. "G000IG1008.PNG") — the same id
the catalog uses. This walks the archive, colour-keys the magenta background to transparency,
and writes each needed icon to public/assets/itemicons/<id>.png (lowercased) so the editor's
ItemPicker can render <img src="/assets/itemicons/<id>.png">. Only catalog items are kept.

    python tools/asset-pipeline/build_item_icons.py \
        --game "<D2_GAME_DIR>/Game" --out public/assets

Needs the 3.7 interpreter (Pillow + numpy). Run AFTER build_item_catalog.py.
"""
import argparse
import json
import os

from PIL import Image

import extract_ff
from fflib import shaders


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", default="public/assets")
    ap.add_argument("--catalog", default=None)
    args = ap.parse_args()

    catalog = args.catalog or os.path.join(args.out, "itemCatalog.json")
    wanted = set()
    with open(catalog, encoding="utf-8") as f:
        for e in json.load(f):
            if e.get("id"):
                wanted.add(e["id"].lower())  # IconItem.ff records are named by ITEM_ID

    arch = extract_ff.find_archive(args.game, "IconItem.ff")
    if not arch:
        raise SystemExit("IconItem.ff not found under Game/Imgs|Interf")
    _name, images = extract_ff.extract(arch)

    outdir = os.path.join(args.out, "itemicons")
    os.makedirs(outdir, exist_ok=True)

    seen = set()
    for img in images:
        key = os.path.splitext(img.name)[0].lower()  # "ICNPO001.PNG" -> "icnpo001"
        if key not in wanted or key in seen:
            continue
        seen.add(key)
        rgba, _ntrans = shaders.colorkey(img.open(), kind="default")
        Image.fromarray(rgba, "RGBA").save(os.path.join(outdir, key + ".png"))

    missing = sorted(wanted - seen)
    print("wrote %d icons -> %s (%d wanted, %d missing%s)" % (
        len(seen), outdir, len(wanted), len(missing),
        ": " + ", ".join(missing[:12]) if missing else ""))


if __name__ == "__main__":
    main()
