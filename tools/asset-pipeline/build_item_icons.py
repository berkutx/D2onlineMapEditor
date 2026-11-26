"""build_item_icons: the inventory picture of every item, as the game shows it.

Imgs/IconItem.ff is asked for a picture by NAME, through its index (see fflib/pictures.py):

  * an item's picture is named by its ITEM_ID;
  * a scroll has no picture of its own. The game shows one of five, by the race of the first
    lord — in Glord order — whose research (GspellR) holds the scroll's spell: SCROLLHU,
    SCROLLUN, SCROLLHE, SCROLLDW, SCROLLEL. A spell no lord learns gets the Empire's; a race
    outside these five gets no picture. GItem.IMAGE_ID ("icnsc001" on every scroll) names
    nothing in the archive and is not what the picture is found by.

Writes public/assets/itemicons/<id>.png (lowercased) for the editor's <img>. Only catalog items
are kept.

    python tools/asset-pipeline/build_item_icons.py \
        --game "<D2_GAME_DIR>/Game" --out public/assets

Needs the 3.7 interpreter (Pillow + numpy). Run AFTER build_item_catalog.py.
"""
import argparse
import json
import os

from fflib import pictures
from fflib.dbf import read_dbf, find_table, has_table, ascii_

NULL_ID = "G000000000"

#: Race category (Lrace.TEXT) -> the scroll picture of that race.
SCROLL_PICTURES = {
    "L_HUMAN": "SCROLLHU",
    "L_UNDEAD": "SCROLLUN",
    "L_HERETIC": "SCROLLHE",
    "L_DWARF": "SCROLLDW",
    "L_ELF": "SCROLLEL",
}
#: The scroll category of LmagItm.dbf; its id is 8 in every install seen.
SCROLL_CATEGORY = "L_SCROLL"
SCROLL_CATEGORY_ID = 8


def _enum(globals_dir, table):
    """An L*.dbf enum table as {id: TEXT}; empty when the install has no such table."""
    out = {}
    if not has_table(globals_dir, table):
        return out
    for row in read_dbf(find_table(globals_dir, table)):
        try:
            out.setdefault(int(ascii_(row["ID"])), ascii_(row["TEXT"]).upper())
        except ValueError:
            continue
    return out


def scroll_category_ids(globals_dir):
    ids = {i for i, text in _enum(globals_dir, "LmagItm.dbf").items() if text == SCROLL_CATEGORY}
    return ids or {SCROLL_CATEGORY_ID}


def spell_races(globals_dir):
    """{SPELL_ID: race category} — the race of the first lord, in table order, who can learn
    the spell. Spells no lord learns are absent."""
    race_names = _enum(globals_dir, "Lrace.dbf")
    race_of = {}
    for row in read_dbf(find_table(globals_dir, "Grace.dbf")):
        try:
            race_of[ascii_(row["RACE_ID"]).upper()] = race_names.get(int(ascii_(row["RACE_TYPE"])), "")
        except ValueError:
            continue
    research = {}
    for row in read_dbf(find_table(globals_dir, "GspellR.dbf")):
        research.setdefault(ascii_(row["LORD_ID"]).upper(), set()).add(ascii_(row["SPELL_ID"]).upper())
    out = {}
    for row in read_dbf(find_table(globals_dir, "Glord.dbf")):
        race = race_of.get(ascii_(row["RACE_ID"]).upper(), "")
        for spell in research.get(ascii_(row["LORD_ID"]).upper(), ()):
            out.setdefault(spell, race)
    return out


def picture_names(globals_dir):
    """{ITEM_ID: the name of its picture in IconItem.ff} for every item of GItem.dbf; an empty
    name where the game shows nothing."""
    scroll_cats = scroll_category_ids(globals_dir)
    races = None
    out = {}
    for row in read_dbf(find_table(globals_dir, "GItem.dbf")):
        iid = ascii_(row["ITEM_ID"]).upper()
        if not iid or iid == NULL_ID:
            continue
        try:
            cat = int(ascii_(row["ITEM_CAT"]) or "0")
        except ValueError:
            cat = 0
        if cat not in scroll_cats:
            out[iid] = iid
            continue
        if races is None:
            races = spell_races(globals_dir)
        race = races.get(ascii_(row["SPELL_ID"]).upper(), "L_HUMAN")
        out[iid] = SCROLL_PICTURES.get(race, "")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", default="public/assets")
    ap.add_argument("--catalog", default=None)
    args = ap.parse_args()

    catalog = args.catalog or os.path.join(args.out, "itemCatalog.json")
    with open(catalog, encoding="utf-8") as f:
        wanted = sorted({e["id"].upper() for e in json.load(f) if e.get("id")})

    archive = pictures.open_archive(args.game, "IconItem.ff")
    names = picture_names(os.path.join(args.game, "Globals"))

    outdir = os.path.join(args.out, "itemicons")
    os.makedirs(outdir, exist_ok=True)

    cache = {}
    wrote, shared, missing = 0, 0, []
    for iid in wanted:
        name = names.get(iid, iid)
        if name not in cache:
            cache[name] = archive.picture(name)
        rgba = cache[name]
        if rgba is None:
            missing.append(iid.lower())
            continue
        pictures.save(rgba, os.path.join(outdir, iid.lower() + ".png"))
        wrote += 1
        shared += name != iid
    print("wrote %d icons -> %s (%d wanted, %d of them a scroll picture, %d missing%s)" % (
        wrote, outdir, len(wanted), shared, len(missing),
        ": " + ", ".join(missing[:12]) if missing else ""))


if __name__ == "__main__":
    main()
