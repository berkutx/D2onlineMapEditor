"""build_unit_icons: extract unit face portraits from Imgs/Faces.ff into per-unit PNGs.

Faces.ff records are named UNIT_ID + a suffix. "<id>FACEB" (the big battle portrait) is the
authoritative per-unit face and is used here; the small "<id>FACE" records are shifted by one
unit and must NOT be preferred. Colour-keys the magenta border to transparency and writes
public/assets/uniticons/<id>.png (lowercased) so the unit picker can render <img>.

Only ~479/856 units ship their OWN face; the other 377 are upgrades/variants that reuse a base
unit's portrait. Gunits.dbf BASE_UNIT chains every such unit to a base that DOES have a face, so
we resolve through BASE_UNIT and write the base's portrait under the variant's id -> 856/856
coverage (no UI placeholders). Verified: the chain resolves for all 377.

    python tools/asset-pipeline/build_unit_icons.py --game "<D2_GAME_DIR>/Game" --out public/assets

Needs the 3.7 interpreter (Pillow + numpy). Run AFTER build_unit_catalog.py.
"""
import argparse
import json
import os

from PIL import Image

import extract_ff
from fflib import shaders
from build_item_catalog import read_dbf, ascii_, _find


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", default="public/assets")
    ap.add_argument("--catalog", default=None)
    args = ap.parse_args()

    catalog = args.catalog or os.path.join(args.out, "unitCatalog.json")
    with open(catalog, encoding="utf-8") as f:
        wanted = {e["id"].upper() for e in json.load(f) if e.get("id")}

    # BASE_UNIT chain (variant/upgrade -> base unit) so faceless units can reuse a base portrait.
    base_of = {}
    for r in read_dbf(_find(os.path.join(args.game, "Globals"), "Gunits.dbf")):
        uid = ascii_(r["UNIT_ID"]).upper()
        if uid and uid != "G000000000":
            base_of[uid] = ascii_(r["BASE_UNIT"]).upper()

    arch = extract_ff.find_archive(args.game, "Faces.ff")
    if not arch:
        raise SystemExit("Faces.ff not found under Game/Imgs|Interf")
    _name, images = extract_ff.extract(arch)
    by_name = {os.path.splitext(i.name)[0].upper(): i for i in images}

    def face(uid):
        # FACEB (the big battle portrait) is the authoritative per-unit face. The small
        # <id>FACE records in Faces.ff are shifted by one unit — each holds the PREVIOUS
        # unit's face (verified: G000UU0022FACE shows the archmage, G000UU0023FACE the
        # archangel, while their FACEB records show the correct archangel/thief). FACEB has
        # full coverage (479 own + 377 via BASE_UNIT = 856/856), so FACE is never needed.
        return by_name.get(uid + "FACEB") or by_name.get(uid + "FACES") or by_name.get(uid + "FACE")

    def resolve(uid, depth=0):
        """The portrait source for uid: its own face, else its BASE_UNIT chain's face."""
        img = face(uid)
        if img:
            return img
        base = base_of.get(uid, "G000000000")
        if base and base != "G000000000" and depth < 6:
            return resolve(base, depth + 1)
        return None

    outdir = os.path.join(args.out, "uniticons")
    os.makedirs(outdir, exist_ok=True)
    seen = via_base = 0
    for uid in wanted:
        img = face(uid)
        if not img:
            img = resolve(uid)
            if img:
                via_base += 1
        if not img:
            continue
        rgba, _ntrans = shaders.colorkey(img.open(), kind="default")
        Image.fromarray(rgba, "RGBA").save(os.path.join(outdir, uid.lower() + ".png"))
        seen += 1
    print("wrote %d unit icons -> %s (%d wanted, %d via BASE_UNIT, %d without portrait)" % (
        seen, outdir, len(wanted), via_base, len(wanted) - seen))


if __name__ == "__main__":
    main()
