# -*- coding: utf-8 -*-
"""build_modifier_catalog: the reproducible builder for public/assets/modifierCatalog.json.

Catalogs every unit modifier (Gmodif.dbf) for the editor's per-unit modifier picker —
the «модификаторы» dialog of stacks/garrisons and stack templates (.sg carries them as
MidUnit MODIF_ID lists and template {UNIT_POS, MODIF_ID} pairs; both accept ANY Gmodif id,
and shipped maps use 378 distinct ones incl. mod-added G201UM/G202UM series).

Each entry:
  - id        <- MODIF_ID (10-char compound uid, UPPER; matches .sg MODIF_ID refs)
  - name      <- Tglobal[DESC_TXT] (CP866!); fallback: generated from GmodifL details;
                 fallback: COMMENTS (dev note, CP866); fallback: the id itself
  - source    <- SOURCE (LModifS enum: 0 L_UNIT / 1 L_STACK / 2 L_STACK_LEADER /
                 3 L_ATTACK / 4 L_CUSTOM) + sourceKey
  - dialog    <- true for the native ScenEdit unit-modifier dialog set: the G000UM9###
                 series with a resolved name (byte-verified: dialog strings x000tg60## are
                 exactly these rows' DESC_TXT)
  - class     <- coarse effect class for picker grouping: hp/armor/accuracy/damage/
                 initiative/ward/immunity/leader/move/regen/leadership/scout/drain/misc.
                 Derived from GmodifL.TYPE (LmodifE enum) first, then the .lua script name,
                 then name keywords.
  - effects   <- human-readable effect parts from GmodifL rows (per-detail DESC token when
                 present, else stat+magnitude), for the picker tooltip
  - scripted  <- SCRIPT non-empty (lua-driven; effects may be prose-only)

    python tools/asset-pipeline/build_modifier_catalog.py \
        --game "<D2_GAME_DIR>/Game" --out public/assets

GOTCHA: Tglobal.dbf and COMMENTS are CP866 (DOS-Cyrillic), NOT CP1251 like .sg strings.
"""
import argparse
import json
import os
import re

from build_item_catalog import read_dbf, _find, ascii_, cp866_

NULL_REF = "G000000000"

# LmodifE TYPE -> (class, RU stat label, magnitude mode: True=PERCENT, False=NUMBER, "auto")
TYPE_MAP = {
    1: ("scout", "обзор", False),
    2: ("leadership", "лидерство", False),
    3: ("accuracy", "точность", True),
    4: ("damage", "урон", True),
    5: ("armor", "броня", False),
    6: ("hp", "здоровье", "auto"),
    7: ("move", "ход", True),
    8: ("misc", "мораль", False),
    9: ("initiative", "инициатива", True),
    10: ("move", "передвижение", None),
    11: ("leader", "способность лидера", None),
    12: ("ward", "защита", None),
    13: ("regen", "регенерация", True),
    14: ("immunity", "иммунитет", None),
    15: ("drain", "вытягивание жизни", True),
    16: ("misc", "отступление", None),
    17: ("misc", "стоимость", True),
}

# .lua script name -> class (for scripted modifiers with no structured GmodifL rows)
SCRIPT_CLASS = [
    (r"resist_source_.*_always", "immunity"),
    (r"resist_source_.*_once", "ward"),
    (r"resist_class", "ward"),
    (r"hitpoint_|hp_", "hp"),
    (r"armor", "armor"),
    (r"acc\d|accuracy", "accuracy"),
    (r"dmg\d|damage", "damage"),
    (r"ini(_|[A-Z])|initiative|buff_initiative", "initiative"),
    (r"regen", "regen"),
    (r"leaderMods[\\/]", "leader"),
    (r"Leadership", "leadership"),
    (r"Move(Forest|Sea|Water)|move_", "move"),
    (r"drain|vampir", "drain"),
]

NAME_CLASS = [
    ("иммунитет", "immunity"),
    ("защиту от", "ward"),
    ("защита от", "ward"),
    ("здоров", "hp"),
    ("брон", "armor"),
    ("точност", "accuracy"),
    ("меткост", "accuracy"),
    ("урон", "damage"),
    ("инициатив", "initiative"),
    ("регенерац", "regen"),
    ("лидерств", "leadership"),
    ("хождение", "move"),
    ("мореплавание", "move"),
    ("вытягивание", "drain"),
]


def _int(b):
    try:
        return int(ascii_(b) or "0")
    except ValueError:
        return 0


_CYR = re.compile(u"[а-яА-ЯёЁ]")
_MIDCAP = re.compile(u"[а-яё][А-ЯЁ]")  # заглавная внутри слова = неправдоподобный декод


def _ru_score(t):
    return len(_CYR.findall(t)) - 3 * len(_MIDCAP.findall(t))


def _ru_bytes(b):
    """COMMENTS mixes encodings in this mod (mostly CP866, some rows CP1251) —
    decode with whichever yields more plausible Cyrillic (mid-word capitals penalized)."""
    best, best_score = "", -1
    for enc in ("cp866", "cp1251"):
        try:
            t = b.decode(enc).rstrip("\x00").strip()
        except UnicodeDecodeError:
            continue
        s = _ru_score(t)
        if s > best_score:
            best, best_score = t, s
    if best:
        return best
    return b.decode("cp866", "replace").rstrip("\x00").strip()


def _clean_text(t):
    return re.sub(r"^\\f\w+;", "", t).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    globals_dir = os.path.join(args.game, "Globals")

    gmodif = read_dbf(_find(globals_dir, "Gmodif.dbf"))
    gmodifL = {}
    for r in read_dbf(_find(globals_dir, "GmodifL.dbf")):
        gmodifL.setdefault(ascii_(r["BELONGS_TO"]).lower(), []).append(r)
    lmodifs = {_int(r["ID"]): ascii_(r["TEXT"]) for r in read_dbf(_find(globals_dir, "LModifS.dbf"))}

    texts = {}
    for r in read_dbf(_find(globals_dir, "Tglobal.dbf")):
        texts[ascii_(r["TXT_ID"]).strip().lower()] = _clean_text(cp866_(r["TEXT"]))

    def resolve(token):
        return texts.get(ascii_(token).strip().lower(), "") if ascii_(token).strip() else ""

    out = []
    for row in gmodif:
        mid = ascii_(row["MODIF_ID"]).upper()
        if not mid or mid == NULL_REF:
            continue
        source = _int(row["SOURCE"])
        script = ascii_(row["SCRIPT"]).strip()
        comment = _ru_bytes(row["COMMENTS"])
        name = resolve(row["DESC_TXT"])

        details = gmodifL.get(mid.lower(), [])
        cls = None
        effects = []
        for d in details:
            tm = TYPE_MAP.get(_int(d["TYPE"]))
            if tm and cls is None:
                cls = tm[0]
            # per-detail text beats generated stat+magnitude
            dt = resolve(d["DESC"])
            if dt:
                effects.append(dt)
                continue
            if not tm:
                continue
            _, ru, mode = tm
            pct, num = _int(d["PERCENT"]), _int(d["NUMBER"])
            if mode is True:
                effects.append("%+d%% %s" % (pct, ru) if pct else ru)
            elif mode is False:
                effects.append("%+d %s" % (num, ru) if num else ru)
            elif mode == "auto":
                v, suf = (num, "") if num else (pct, "%")
                effects.append("%+d%s %s" % (v, suf, ru) if v else ru)
            else:
                effects.append(ru)
        if cls is None and script:
            for pat, c in SCRIPT_CLASS:
                if re.search(pat, script, re.IGNORECASE):
                    cls = c
                    break
        if cls is None and name:
            low = name.lower()
            for kw, c in NAME_CLASS:
                if kw in low:
                    cls = c
                    break

        dialog = bool(re.match(r"^G000UM9\d{3}$", mid)) and bool(name)
        entry = {
            "id": mid,
            "name": name or (" · ".join(effects) if effects else "") or comment or mid,
            "source": source,
            "sourceKey": lmodifs.get(source, ""),
            "class": cls or "misc",
            "dialog": dialog,
        }
        if effects:
            entry["effects"] = effects
        if script:
            entry["scripted"] = True
        if comment and comment != entry["name"]:
            entry["comment"] = comment
        out.append(entry)

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "modifierCatalog.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    by_class = {}
    for e in out:
        by_class[e["class"]] = by_class.get(e["class"], 0) + 1
    print("wrote %d modifiers -> %s" % (len(out), path))
    print("  dialog set:", sum(1 for e in out if e["dialog"]), " by class:", by_class)


if __name__ == "__main__":
    main()
