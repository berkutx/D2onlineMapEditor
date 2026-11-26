"""build_unit_catalog: Globals/Gunits.dbf -> public/assets/unitCatalog.json.

Catalogs every unit for the editor's garrison + mercenary pickers. Each entry:
  - id        <- UNIT_ID (10-char compound, UPPER; matches .sg MidUnit TYPE / site UNIT_ID)
  - name/desc <- Tglobal[NAME_TXT/DESC_TXT]  (CP866; rich-text prefix stripped)
  - level     <- LEVEL
  - cat/catKey<- UNIT_CAT + LunitC.dbf enum (L_SOLDIER/L_LEADER/L_SUMMON/...)
  - leaderKey <- LleadC.dbf enum when LEADER_CAT != 0 (fighter/mage/explorer/rod/noble)
  - race      <- Grace[RACE_ID].NAME_TXT (coarse, 6 races); subrace <- GSubRace[RACE_TYPE==SUBRACE].NAME_TXT
  - hp/armor/leadership <- HIT_POINT / ARMOR / LEADERSHIP
  - xp        <- XP_KILLED: the experience a victory over the unit gives — the game's own
                 measure of how strong it is (what "a guard worth N" is counted in)
  - branch    <- BRANCH + LunitB.dbf enum (L_FIGHTER / L_ARCHER / L_MAGE / L_SPECIAL / L_HERO ...)
  - melee     <- true when the unit's main attack only reaches an adjacent enemy (Gattacks.REACH ->
                 LattR.MELEE, or L_ADJACENT in a mod whose LattR has no such column): it must
                 stand in the FRONT line to fight; emitted only when true
  - area      <- true when that attack hits several targets at once (L_ALL, or a mod's reach whose
                 MAX_TARGTS is above one); emitted only when true
  - atk       <- the main attack's class (LattC enum: L_DAMAGE / L_HEAL / L_BOOST_DAMAGE ...)
  - dyn       <- [DYN_UPG_LV, hp1, xp1, hp2, xp2]: what one level above the base adds to hit
                 points and to `xp`, before DYN_UPG_LV (GDynUpgr[DYN_UPG1]) and from it on
                 (GDynUpgr[DYN_UPG2]); omitted for a unit that does not grow
  - water     <- true for a unit that lives only on water (WATER_ONLY); emitted only when true

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
    lunitb = {_int(r, "ID"): ascii_(r["TEXT"]) for r in read_dbf(_find(g, "LunitB.dbf"))}
    lattc = {_int(r, "ID"): ascii_(r["TEXT"]) for r in read_dbf(_find(g, "LattC.dbf"))}
    # reach id -> does the attack only hit an adjacent enemy? MSS mods add reaches of their own
    # and say so in a MELEE column; a table without it has the three stock reaches
    # The three stock reaches keep their meaning whatever those columns hold for them (one mod
    # leaves them blank, another fills them with F / 0), and so does a mod's scripted copy of
    # "any one target" (L_ANY_C, L_ANY_SCRIPT), whose MAX_TARGTS is not always 1.
    melee_reach = {}
    area_reach = {}
    for r in read_dbf(_find(g, "LattR.dbf")):
        rid = _int(r, "ID")
        text = ascii_(r["TEXT"]).strip().upper()
        if text in ("L_ALL", "L_ANY", "L_ADJACENT"):
            melee_reach[rid] = text == "L_ADJACENT"
            area_reach[rid] = text == "L_ALL"
            continue
        melee_reach[rid] = "MELEE" in r and ascii_(r["MELEE"]).strip().upper() == "T"
        area_reach[rid] = text not in ("L_ANY_C", "L_ANY_SCRIPT") and "MAX_TARGTS" in r and _int(r, "MAX_TARGTS") > 1
    attacks = {}
    for r in read_dbf(_find(g, "Gattacks.dbf")):
        attacks[ascii_(r["ATT_ID"]).upper()] = (_int(r, "REACH"), _int(r, "CLASS"))
    dyn_upg = {}
    for r in read_dbf(_find(g, "GDynUpgr.dbf")):
        dyn_upg[ascii_(r["UPGRADE_ID"]).upper()] = (_int(r, "HIT_POINT"), _int(r, "XP_KILLED"))
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
            "xp": _int(r, "XP_KILLED"),
            "branch": lunitb.get(_int(r, "BRANCH"), ""),
        }
        attack = attacks.get(ascii_(r["ATTACK_ID"]).upper())
        if attack:
            if melee_reach.get(attack[0], False):
                entry["melee"] = True
            if area_reach.get(attack[0], False):
                entry["area"] = True
            entry["atk"] = lattc.get(attack[1], "")
        up1 = dyn_upg.get(ascii_(r["DYN_UPG1"]).upper())
        up2 = dyn_upg.get(ascii_(r["DYN_UPG2"]).upper())
        if up1 or up2:
            up1 = up1 or (0, 0)
            up2 = up2 or up1
            entry["dyn"] = [_int(r, "DYN_UPG_LV"), up1[0], up1[1], up2[0], up2[1]]
        if lead:
            entry["leaderKey"] = lleadc.get(lead, "")
        if "WATER_ONLY" in r and ascii_(r["WATER_ONLY"]).strip().upper() == "T":
            entry["water"] = True
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
