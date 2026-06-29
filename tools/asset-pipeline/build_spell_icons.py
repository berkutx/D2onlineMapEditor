"""build_spell_icons: extract spell icons from Imgs/IconSpel.ff into per-spell PNGs.

IconSpel.ff records are named DIRECTLY by SPELL_ID ("<id>.PNG"), the clean analog of
IconItem.ff. Colour-keys the magenta background and writes public/assets/spellicons/<id>.png
(lowercased). 220/224 spells have an icon; the rest fall back to a placeholder.

    python tools/asset-pipeline/build_spell_icons.py --game "C:/GOG Games/last_version/Game" --out public/assets

Needs the 3.7 interpreter (Pillow + numpy). Run AFTER build_spell_catalog.py.
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

    catalog = args.catalog or os.path.join(args.out, "spellCatalog.json")
    with open(catalog, encoding="utf-8") as f:
        wanted = {e["id"].lower() for e in json.load(f) if e.get("id")}

    arch = extract_ff.find_archive(args.game, "IconSpel.ff")
    if not arch:
        raise SystemExit("IconSpel.ff not found under Game/Imgs|Interf")
    _name, images = extract_ff.extract(arch)

    outdir = os.path.join(args.out, "spellicons")
    os.makedirs(outdir, exist_ok=True)
    seen = set()
    for img in images:
        key = os.path.splitext(img.name)[0].lower()
        if key not in wanted or key in seen:
            continue
        seen.add(key)
        rgba, _ntrans = shaders.colorkey(img.open(), kind="default")
        Image.fromarray(rgba, "RGBA").save(os.path.join(outdir, key + ".png"))
    missing = sorted(wanted - seen)
    print("wrote %d spell icons -> %s (%d wanted, %d missing%s)" % (
        len(seen), outdir, len(wanted), len(missing), ": " + ", ".join(missing[:8]) if missing else ""))


if __name__ == "__main__":
    main()
