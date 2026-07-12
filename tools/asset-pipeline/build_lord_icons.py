"""build_lord_icons: extract lord portraits from Imgs/Lords.ff into per-lord PNGs for the
player-editor lord picker.

Lords.ff records are NOT keyed by LORD_ID — they are named LORD<raceCode><size><nn>:
  raceCode = HU (Empire) / DW (Кланы Гор) / HE (Легионы) / UN (Нежить) / EL (Эльфы) / NE (Нейтрал),
  size     = L (large) / S (small),
  nn       = 01..04 (the race's lords, in LORD_ID order).
Glord.PIC is empty in this mod, so we resolve each lord to its portrait by (RACE_ID -> raceCode) +
its ORDINAL within its race (1st/2nd/3rd Glord row -> L01/L02/L03). The picker shows the NAME as the
authoritative label, so a one-off portrait would be cosmetic only. Colour-keys the magenta border to
transparency and writes public/assets/lordicons/<LORD_ID>.png (lowercased).

    python tools/asset-pipeline/build_lord_icons.py --game "<D2_GAME_DIR>/Game" --out public/assets

Needs the 3.7 interpreter (Pillow + numpy). Run AFTER build_lord_catalog.py.
"""
import argparse
import os

from PIL import Image

import extract_ff
from fflib import shaders
from build_item_catalog import read_dbf, ascii_, _find

# RACE_ID (Grace) -> the Lords.ff race code (matches the Lterrain race letters).
RACE_CODE = {
    "G000RR0000": "HU",  # Империя
    "G000RR0001": "DW",  # Кланы Гор (mountain-clans / dwarves)
    "G000RR0002": "HE",  # Легионы Проклятых (heretics)
    "G000RR0003": "UN",  # Орды Нежити
    "G000RR0004": "NE",  # Нейтрал
    "G000RR0005": "EL",  # Эльфийский Союз
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", default="public/assets")
    args = ap.parse_args()

    globals_dir = os.path.join(args.game, "Globals")
    # group lords by race, preserving Glord row order (== LORD_ID order) for the ordinal.
    by_race = {}
    for r in read_dbf(_find(globals_dir, "Glord.dbf")):
        lid = ascii_(r["LORD_ID"]).upper()
        rid = ascii_(r["RACE_ID"]).upper()
        if not lid or lid == "G000000000":
            continue
        by_race.setdefault(rid, []).append(lid)

    arch = extract_ff.find_archive(args.game, "Lords.ff")
    if not arch:
        raise SystemExit("Lords.ff not found under Game/Imgs")
    _name, images = extract_ff.extract(arch)
    by_name = {os.path.splitext(i.name)[0].upper(): i for i in images}

    def portrait(code, ordinal):
        # prefer the large portrait; fall back to small.
        return by_name.get("LORD%sL%02d" % (code, ordinal)) or by_name.get("LORD%sS%02d" % (code, ordinal))

    outdir = os.path.join(args.out, "lordicons")
    os.makedirs(outdir, exist_ok=True)
    wrote = missing = 0
    for rid, lords in by_race.items():
        code = RACE_CODE.get(rid)
        if not code:
            continue
        for ordinal, lid in enumerate(lords, start=1):
            img = portrait(code, ordinal)
            if not img:
                missing += 1
                continue
            rgba, _n = shaders.colorkey(img.open(), kind="default")
            Image.fromarray(rgba, "RGBA").save(os.path.join(outdir, lid.lower() + ".png"))
            wrote += 1
    print("wrote %d lord icons -> %s (%d without a portrait record)" % (wrote, outdir, missing))


if __name__ == "__main__":
    main()
