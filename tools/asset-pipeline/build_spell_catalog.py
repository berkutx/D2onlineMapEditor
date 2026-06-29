"""build_spell_catalog: Globals/Gspells.dbf -> public/assets/spellCatalog.json.

Catalogs every spell for the editor's mage-shop picker. Each entry:
  - id        <- SPELL_ID (10-char compound, UPPER; matches site SPELL_ID + GItem.SPELL_ID)
  - name/desc <- Tglobal[NAME_TXT/DESC_TXT] (CP866)
  - level     <- LEVEL (research tier)
  - cat/catKey<- CATEGORY + Lspell.DBF enum (L_ATTACK/L_BOOST/L_HEAL/L_SUMMON/...)
  - damage/heal/area <- DAMAGE_QTY / HEAL_QTY / AREA (when set)
  - summon    <- Gunits[UNIT_ID].name when CATEGORY is L_SUMMON

    python tools/asset-pipeline/build_spell_catalog.py --game "C:/GOG Games/last_version/Game" --out public/assets
"""
import argparse
import json
import os

from build_item_catalog import read_dbf, ascii_, cp866_, _find, clean_desc


def _int(row, key):
    try:
        return int(ascii_(row[key]) or "0")
    except ValueError:
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", default="public/assets")
    args = ap.parse_args()
    g = os.path.join(args.game, "Globals")

    texts = {}
    for r in read_dbf(_find(g, "Tglobal.dbf")):
        k = ascii_(r["TXT_ID"]).lower()
        if k:
            texts[k] = cp866_(r["TEXT"])
    lspell = {_int(r, "ID"): ascii_(r["TEXT"]) for r in read_dbf(_find(g, "Lspell.DBF"))}
    unit_name = {}
    for r in read_dbf(_find(g, "Gunits.dbf")):
        unit_name[ascii_(r["UNIT_ID"]).upper()] = texts.get(ascii_(r["NAME_TXT"]).lower(), "")

    out = []
    for r in read_dbf(_find(g, "Gspells.dbf")):
        sid = ascii_(r["SPELL_ID"]).upper()
        if not sid or sid == "G000000000":
            continue
        cat = _int(r, "CATEGORY")
        catKey = lspell.get(cat, "")
        entry = {
            "id": sid,
            "name": texts.get(ascii_(r["NAME_TXT"]).lower(), ""),
            "level": _int(r, "LEVEL"),
            "cat": cat,
            "catKey": catKey,
        }
        dmg, heal, area = _int(r, "DAMAGE_QTY"), _int(r, "HEAL_QTY"), _int(r, "AREA")
        if dmg:
            entry["damage"] = dmg
        if heal:
            entry["heal"] = heal
        if area:
            entry["area"] = area
        if catKey == "L_SUMMON":
            u = ascii_(r["UNIT_ID"]).upper()
            if u and u != "G000000000":
                entry["summon"] = unit_name.get(u, "")
        desc = clean_desc(texts, ascii_(r["DESC_TXT"]))
        if desc:
            entry["desc"] = desc
        out.append(entry)

    out.sort(key=lambda e: (e["cat"], e["level"], e["name"], e["id"]))
    os.makedirs(args.out, exist_ok=True)
    dest = os.path.join(args.out, "spellCatalog.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("wrote %d spells -> %s" % (len(out), dest))


if __name__ == "__main__":
    main()
