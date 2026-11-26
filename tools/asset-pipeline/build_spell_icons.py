"""build_spell_icons: the picture of every spell, as the game shows it.

Imgs/IconSpel.ff is asked for a picture by NAME — the SPELL_ID — through its index (see
fflib/pictures.py). Writes public/assets/spellicons/<id>.png (lowercased); a spell the archive
does not know keeps the editor's placeholder.

    python tools/asset-pipeline/build_spell_icons.py --game "<D2_GAME_DIR>/Game" --out public/assets

Needs the 3.7 interpreter (Pillow + numpy). Run AFTER build_spell_catalog.py.
"""
import argparse
import json
import os

from fflib import pictures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", default="public/assets")
    ap.add_argument("--catalog", default=None)
    args = ap.parse_args()

    catalog = args.catalog or os.path.join(args.out, "spellCatalog.json")
    with open(catalog, encoding="utf-8") as f:
        wanted = sorted({e["id"].upper() for e in json.load(f) if e.get("id")})

    archive = pictures.open_archive(args.game, "IconSpel.ff")

    outdir = os.path.join(args.out, "spellicons")
    os.makedirs(outdir, exist_ok=True)
    wrote, missing = 0, []
    for sid in wanted:
        rgba = archive.picture(sid)
        if rgba is None:
            missing.append(sid.lower())
            continue
        pictures.save(rgba, os.path.join(outdir, sid.lower() + ".png"))
        wrote += 1
    print("wrote %d spell icons -> %s (%d wanted, %d missing%s)" % (
        wrote, outdir, len(wanted), len(missing), ": " + ", ".join(missing[:8]) if missing else ""))


if __name__ == "__main__":
    main()
