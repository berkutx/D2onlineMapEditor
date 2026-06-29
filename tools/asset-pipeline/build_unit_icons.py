"""build_unit_icons: extract unit face portraits from Imgs/Faces.ff into per-unit PNGs.

Faces.ff records are named UNIT_ID + a suffix: "<id>FACE" (full 130x142 portrait — used here),
with "FACES"/"FACEB" fallbacks. Colour-keys the magenta border to transparency and writes
public/assets/uniticons/<id>.png (lowercased) so the unit picker can render <img>. ~479/856
units have a portrait; the rest fall back to a placeholder in the UI.

    python tools/asset-pipeline/build_unit_icons.py --game "C:/GOG Games/last_version/Game" --out public/assets

Needs the 3.7 interpreter (Pillow + numpy). Run AFTER build_unit_catalog.py.
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

    catalog = args.catalog or os.path.join(args.out, "unitCatalog.json")
    with open(catalog, encoding="utf-8") as f:
        wanted = {e["id"].upper() for e in json.load(f) if e.get("id")}

    arch = extract_ff.find_archive(args.game, "Faces.ff")
    if not arch:
        raise SystemExit("Faces.ff not found under Game/Imgs|Interf")
    _name, images = extract_ff.extract(arch)
    by_name = {os.path.splitext(i.name)[0].upper(): i for i in images}

    outdir = os.path.join(args.out, "uniticons")
    os.makedirs(outdir, exist_ok=True)
    seen = set()
    for uid in wanted:
        img = by_name.get(uid + "FACE") or by_name.get(uid + "FACES") or by_name.get(uid + "FACEB")
        if not img:
            continue
        rgba, _ntrans = shaders.colorkey(img.open(), kind="default")
        Image.fromarray(rgba, "RGBA").save(os.path.join(outdir, uid.lower() + ".png"))
        seen.add(uid)
    print("wrote %d unit icons -> %s (%d wanted, %d without portrait)" % (
        len(seen), outdir, len(wanted), len(wanted) - len(seen)))


if __name__ == "__main__":
    main()
