"""build_lord_icons: a portrait for every lord of the player editor's lord picker.

Imgs/Lords.ff holds the portraits a player chooses from, named LORD<raceCode><size><nn>:
  raceCode = HU (Empire) / DW (Кланы Гор) / HE (Легионы) / UN (Нежить) / EL (Эльфы) / NE (Нейтрал),
  size     = L (large) / S (small),
  nn       = 01..04.
They are portraits of a RACE, not of a lord type: the game lets the player pick any of the four
whatever lord they play, and Glord.PIC is empty. The picker only wants a face next to each
name, so a race's lords get its portraits in order (1st Glord row -> 01, 2nd -> 02, …) — a
decoration, the NAME is the label. Pictures are read by name through the archive's index (see
fflib/pictures.py); writes public/assets/lordicons/<LORD_ID>.png (lowercased).

    python tools/asset-pipeline/build_lord_icons.py --game "<D2_GAME_DIR>/Game" --out public/assets

Needs the 3.7 interpreter (Pillow + numpy). Run AFTER build_lord_catalog.py.
"""
import argparse
import os

from fflib import pictures
from fflib.dbf import read_dbf, find_table, ascii_

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
    for r in read_dbf(find_table(globals_dir, "Glord.dbf")):
        lid = ascii_(r["LORD_ID"]).upper()
        rid = ascii_(r["RACE_ID"]).upper()
        if not lid or lid == "G000000000":
            continue
        by_race.setdefault(rid, []).append(lid)

    archive = pictures.open_archive(args.game, "Lords.ff")

    outdir = os.path.join(args.out, "lordicons")
    os.makedirs(outdir, exist_ok=True)
    wrote = missing = 0
    for rid, lords in by_race.items():
        code = RACE_CODE.get(rid)
        if not code:
            continue
        for ordinal, lid in enumerate(lords, start=1):
            # prefer the large portrait; fall back to small.
            _name, rgba = archive.first(["LORD%sL%02d" % (code, ordinal), "LORD%sS%02d" % (code, ordinal)])
            if rgba is None:
                missing += 1
                continue
            pictures.save(rgba, os.path.join(outdir, lid.lower() + ".png"))
            wrote += 1
    print("wrote %d lord icons -> %s (%d without a portrait)" % (wrote, outdir, missing))


if __name__ == "__main__":
    main()
