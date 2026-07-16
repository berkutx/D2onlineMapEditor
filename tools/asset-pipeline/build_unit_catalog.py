"""build_unit_catalog: Globals/Gunits.dbf -> public/assets/unitCatalog.json.

Catalogs every unit for the editor's garrison + mercenary pickers. Each entry:
  - id        <- UNIT_ID (10-char compound, UPPER; matches .sg MidUnit TYPE / site UNIT_ID)
  - name/desc <- Tglobal[NAME_TXT/DESC_TXT]  (CP866; rich-text prefix stripped)
  - level     <- LEVEL
  - cat/catKey<- UNIT_CAT + LunitC.dbf enum (L_SOLDIER/L_LEADER/L_SUMMON/...)
  - leaderKey <- LleadC.dbf enum when LEADER_CAT != 0 (fighter/mage/explorer/rod/noble)
  - race      <- Grace[RACE_ID].NAME_TXT (coarse, 6 races); subrace <- GSubRace[RACE_TYPE==SUBRACE].NAME_TXT
  - hp/armor/leadership <- HIT_POINT / ARMOR / LEADERSHIP

    python tools/asset-pipeline/build_unit_catalog.py --game "<D2_GAME_DIR>/Game" --out public/assets

Reuses read_dbf/ascii_/cp866_/clean_desc from build_item_catalog (deleted DBF rows skipped).
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
    lunitc = {_int(r, "ID"): ascii_(r["TEXT"]) for r in read_dbf(_find(g, "LunitC.dbf"))}
    lleadc = {_int(r, "ID"): ascii_(r["TEXT"]) for r in read_dbf(_find(g, "LleadC.dbf"))}
    race_name = {}
    for r in read_dbf(_find(g, "Grace.dbf")):
        race_name[ascii_(r["RACE_ID"]).upper()] = texts.get(ascii_(r["NAME_TXT"]).lower(), "")
    subrace_name = {}
    for r in read_dbf(_find(g, "GSubRace.dbf")):
        subrace_name[_int(r, "RACE_TYPE")] = texts.get(ascii_(r["NAME_TXT"]).lower(), "")

    out = []
    for r in read_dbf(_find(g, "Gunits.dbf")):
        uid = ascii_(r["UNIT_ID"]).upper()
        if not uid or uid == "G000000000":
            continue
        cat = _int(r, "UNIT_CAT")
        lead = _int(r, "LEADER_CAT")
        sub = _int(r, "SUBRACE")
        entry = {
            "id": uid,
            "name": texts.get(ascii_(r["NAME_TXT"]).lower(), ""),
            "level": _int(r, "LEVEL"),
            "cat": cat,
            "catKey": lunitc.get(cat, ""),
            "race": race_name.get(ascii_(r["RACE_ID"]).upper(), ""),
            "subrace": subrace_name.get(sub, ""),
            "subraceId": sub,
            "hp": _int(r, "HIT_POINT"),
            "armor": _int(r, "ARMOR"),
            "leadership": _int(r, "LEADERSHIP"),
        }
        if lead:
            entry["leaderKey"] = lleadc.get(lead, "")
        # SIZE_SMALL (DBF logical): 'T' => 1-cell small unit; 'F' or blank => 2-cell BIG unit
        # (dragons/giants/big heroes). Emitted only when large, to keep the JSON compact (like
        # leaderKey/desc). Consumed by unitStore.isLarge for the merged formation slot + placing a
        # fresh big unit across both column cells. NOTE: ~19 mod units leave SIZE_SMALL blank and
        # are ambiguous (giants + a few smalls); `!= "T"` follows the engine's logical-false default
        # and flags the blank giants (Cyclops/Grimthurs) correctly at the cost of a couple mod smalls.
        if ascii_(r["SIZE_SMALL"]).strip().upper() != "T":
            entry["large"] = True
        desc = clean_desc(texts, ascii_(r["DESC_TXT"]))
        if desc:
            entry["desc"] = desc
        out.append(entry)

    out.sort(key=lambda e: (e["subraceId"], e["level"], e["name"], e["id"]))
    os.makedirs(args.out, exist_ok=True)
    dest = os.path.join(args.out, "unitCatalog.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("wrote %d units -> %s" % (len(out), dest))


if __name__ == "__main__":
    main()
