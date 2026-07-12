# -*- coding: utf-8 -*-
"""build_lord_catalog: the reproducible builder for public/assets/lordCatalog.json.

Catalogs every lord (Glord.dbf) for the editor's player-editor lord picker. A MidPlayer's
LORD_ID references one of these 18 rows (6 races × 3 archetypes); the game keys the lord's
bonuses off the referenced row's CATEGORY, so a player's lord is a picker over its race's
three lords (mage / warrior / diplomat).

Each entry:
  - id         <- LORD_ID (10-char compound uid, UPPER; matches .sg LORD_ID refs)
  - race       <- RACE_ID (UPPER; matches Grace + the player's RACE_ID)
  - raceName   <- Grace[RACE_ID].NAME_TXT -> Tglobal (CP866)
  - raceType   <- Grace[RACE_ID].RACE_TYPE (int; the header/PLAYER_n value)
  - category   <- CATEGORY (int: 0 L_MAGE / 1 L_WARRIOR / 2 L_DIPLOMAT)
  - categoryKey<- Llord[CATEGORY].TEXT
  - name       <- Glord.NAME_TXT -> Tglobal (CP866); fallback: the id
  - desc       <- Glord.DESC_TXT -> Tglobal (CP866)

    python tools/asset-pipeline/build_lord_catalog.py \
        --game "<D2_GAME_DIR>/Game" --out public/assets

GOTCHA: Tglobal.dbf is CP866 (DOS-Cyrillic), NOT CP1251 like .sg strings.
"""
import argparse
import json
import os
import re

from build_item_catalog import read_dbf, _find, ascii_, cp866_

NULL_REF = "G000000000"

# RU archetype labels for the picker (Llord enum order).
CATEGORY_RU = {0: "Маг", 1: "Воин", 2: "Дипломат"}


def _int(b):
    try:
        return int(ascii_(b) or "0")
    except ValueError:
        return 0


def _clean(t):
    return re.sub(r"^\\f\w+;", "", t).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    globals_dir = os.path.join(args.game, "Globals")

    texts = {}
    for r in read_dbf(_find(globals_dir, "Tglobal.dbf")):
        texts[ascii_(r["TXT_ID"]).strip().lower()] = _clean(cp866_(r["TEXT"]))

    def resolve(token):
        return texts.get(ascii_(token).strip().lower(), "")

    llord = {_int(r["ID"]): ascii_(r["TEXT"]) for r in read_dbf(_find(globals_dir, "Llord.dbf"))}

    grace = {}
    for r in read_dbf(_find(globals_dir, "Grace.dbf")):
        rid = ascii_(r["RACE_ID"]).upper()
        grace[rid] = {"name": resolve(r["NAME_TXT"]), "raceType": _int(r["RACE_TYPE"])}

    out = []
    for row in read_dbf(_find(globals_dir, "Glord.dbf")):
        lid = ascii_(row["LORD_ID"]).upper()
        if not lid or lid == NULL_REF:
            continue
        rid = ascii_(row["RACE_ID"]).upper()
        cat = _int(row["CATEGORY"])
        g = grace.get(rid, {})
        entry = {
            "id": lid,
            "race": rid,
            "raceName": g.get("name", ""),
            "raceType": g.get("raceType", -1),
            "category": cat,
            "categoryKey": llord.get(cat, ""),
            "categoryName": CATEGORY_RU.get(cat, "?"),
            "name": resolve(row["NAME_TXT"]) or lid,
        }
        desc = resolve(row["DESC_TXT"])
        if desc:
            entry["desc"] = desc
        out.append(entry)

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "lordCatalog.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("wrote %d lords -> %s" % (len(out), path))
    for e in out:
        print("  %s  %-10s  %-9s  %s" % (e["id"], e["race"], e["categoryName"], e["name"]))


if __name__ == "__main__":
    main()
